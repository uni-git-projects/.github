use crate::{Request, html::translate_html, text};
use anyhow::Result;
use std::{
    collections::{HashMap, HashSet},
    env,
};

pub(super) const MODEL_ID: &str = "casawolice/small100-onnx";

pub(super) fn locale_norm(locale: &str) -> String {
    locale.trim().replace('_', "-")
}

fn limit(name: &str, default: usize, minimum: usize) -> usize {
    let value = env::var(name).unwrap_or_default();
    let value = value.trim_start();
    let (negative, digits) = if let Some(value) = value.strip_prefix('-') {
        (true, value)
    } else {
        (false, value.strip_prefix('+').unwrap_or(value))
    };
    let end = digits
        .find(|ch: char| !ch.is_ascii_digit())
        .unwrap_or(digits.len());
    match digits[..end].parse::<usize>() {
        Ok(0) | Err(_) => default,
        Ok(_) if negative => minimum,
        Ok(value) => value.max(minimum),
    }
}

pub(super) struct Translator<F> {
    infer: F,
    supported: HashSet<String>,
    memory: HashMap<(String, String, String), String>,
    max_chars: usize,
    max_new_tokens: usize,
}

impl<F> Translator<F>
where
    F: FnMut(&Request) -> Result<String>,
{
    pub fn new(infer: F, supported: HashSet<String>) -> Self {
        Self {
            infer,
            supported,
            memory: HashMap::new(),
            max_chars: limit("HF_TRANS_MAX_CHARS", 320, 80),
            max_new_tokens: limit("HF_TRANS_MAX_NEW_TOKENS", 384, 32),
        }
    }

    pub fn validate_route(&self, source: &str, target: &str) -> Result<()> {
        for locale in [source, target] {
            let locale = locale_norm(locale).to_lowercase();
            anyhow::ensure!(
                self.supported.contains(&locale),
                "Unsupported translation locale: {locale}"
            );
        }
        Ok(())
    }

    fn translate_unit(&mut self, value: &str, source: &str, target: &str) -> Result<String> {
        let mut reason = String::new();
        for retry in [false, true] {
            let cap = if retry {
                ((value.chars().count() * 7).div_ceil(4) + 8).max(16)
            } else {
                self.max_new_tokens
            };
            let translated = (self.infer)(&Request {
                text: value.to_owned(),
                target: target.to_owned(),
                max_new_tokens: text::max_tokens(value, cap),
                no_repeat_ngram_size: if retry { 2 } else { 3 },
                repetition_penalty: if retry { 1.35 } else { 1.15 },
            })?;
            if let Some(error) = text::invalid_translation(value, &translated) {
                reason = error;
            } else {
                return Ok(translated);
            }
        }
        eprintln!(
            "Rejected {source} -> {target} translation ({reason}): {}",
            text::preview(value)
        );
        Ok(value.to_owned())
    }

    pub fn translate_many(
        &mut self,
        values: &[&str],
        source: &str,
        target: &str,
    ) -> Result<HashMap<String, String>> {
        self.validate_route(source, target)?;
        let source = locale_norm(source).to_lowercase();
        let target = locale_norm(target).to_lowercase();
        let mut output = HashMap::new();
        for &value in values {
            if output.contains_key(value) {
                continue;
            }
            if source == target {
                output.insert(value.to_owned(), value.to_owned());
                continue;
            }
            if value.is_empty() {
                continue;
            }
            let key = (source.clone(), target.clone(), value.to_owned());
            if let Some(translated) = self.memory.get(&key) {
                output.insert(value.to_owned(), translated.clone());
                continue;
            }
            let mut translated = String::new();
            for (protected, part) in text::split_emoji(value) {
                if protected || !text::is_model_text(part) {
                    translated.push_str(part);
                    continue;
                }
                let (leading, core, trailing) = text::split_ws(part);
                translated.push_str(leading);
                for chunk in text::split_text(core, self.max_chars) {
                    if text::is_model_text(&chunk) {
                        translated.push_str(&self.translate_unit(&chunk, &source, &target)?);
                    } else {
                        translated.push_str(&chunk);
                    }
                }
                translated.push_str(trailing);
            }
            self.memory.insert(key, translated.clone());
            output.insert(value.to_owned(), translated);
        }
        Ok(output)
    }

    pub fn translate_html(&mut self, html: &str, source: &str, target: &str) -> Result<String> {
        translate_html(html, |encoded| {
            let decoded: Vec<_> = encoded
                .iter()
                .map(|value| text::decode_html(value))
                .collect();
            let values: Vec<_> = decoded.iter().map(String::as_str).collect();
            let translated = self.translate_many(&values, source, target)?;
            Ok(encoded
                .iter()
                .zip(&decoded)
                .map(|(original, value)| {
                    (
                        original.to_string(),
                        text::escape_html(translated.get(value).unwrap_or(value)),
                    )
                })
                .collect())
        })
    }
}
