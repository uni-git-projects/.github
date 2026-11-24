use crate::text::{is_model_text, split_ws};
use anyhow::Result;
use regex::{Captures, Regex};
use std::{
    collections::{HashMap, HashSet},
    sync::LazyLock,
};

static TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?s)<!--.*?-->|<![^>]*>|</?[A-Za-z](?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+|<"#)
        .unwrap()
});
static TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^<\s*(/?)\s*([A-Za-z][\w:-]*)").unwrap());
static ATTR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(\s)(alt|aria-label|title)(\s*=\s*)(?:"([^"]*)"|'([^']*)')"#).unwrap()
});
static NON_TEXT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(?:https?://|mailto:|tel:|#[\w-]+$)").unwrap());
static SELF_CLOSING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/\s*>$").unwrap());

const EXCLUDED: &[&str] = &[
    "a", "code", "kbd", "math", "pre", "samp", "script", "style", "svg",
];
const VOIDS: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];

enum Plan<'a> {
    Literal(&'a str),
    Text(&'a str, &'a str, &'a str),
    Tag(&'a str, HashSet<&'a str>),
}

fn is_text(value: &str) -> bool {
    let value = value.trim();
    is_model_text(value) && !NON_TEXT.is_match(value)
}

pub(super) fn translate_html<F>(html: &str, translate: F) -> Result<String>
where
    F: FnOnce(&[&str]) -> Result<HashMap<String, String>>,
{
    let mut plans = Vec::new();
    let mut texts = Vec::new();
    let mut seen = HashSet::new();
    let mut stack: Vec<(String, bool)> = Vec::new();
    let mut depth = 0;
    for token in TOKEN.find_iter(html).map(|token| token.as_str()) {
        if !token.starts_with('<') {
            let (leading, core, trailing) = split_ws(token);
            if depth > 0 || !is_text(core) {
                plans.push(Plan::Literal(token));
            } else {
                if seen.insert(core) {
                    texts.push(core);
                }
                plans.push(Plan::Text(leading, core, trailing));
            }
            continue;
        }
        let Some(tag) = TAG.captures(token) else {
            plans.push(Plan::Literal(token));
            continue;
        };
        let name = tag[2].to_ascii_lowercase();
        if &tag[1] == "/" {
            plans.push(Plan::Literal(token));
            if let Some(index) = stack.iter().rposition(|(entry, _)| *entry == name) {
                depth -= stack
                    .drain(index..)
                    .filter(|(_, excluded)| *excluded)
                    .count();
            }
            continue;
        }
        let excluded = EXCLUDED.contains(&name.as_str());
        let mut attrs = HashSet::new();
        if depth == 0 && !excluded {
            for attr in ATTR.captures_iter(token) {
                let original = attr.get(4).or_else(|| attr.get(5)).unwrap().as_str();
                if is_text(original) {
                    if seen.insert(original) {
                        texts.push(original);
                    }
                    attrs.insert(original);
                }
            }
        }
        if attrs.is_empty() {
            plans.push(Plan::Literal(token));
        } else {
            plans.push(Plan::Tag(token, attrs));
        }
        if !SELF_CLOSING.is_match(token) && !VOIDS.contains(&name.as_str()) {
            stack.push((name, excluded));
            if excluded {
                depth += 1;
            }
        }
    }
    let translated = translate(&texts)?;
    let mut result = String::new();
    for plan in plans {
        match plan {
            Plan::Literal(value) => result.push_str(value),
            Plan::Text(leading, core, trailing) => {
                result.push_str(leading);
                result.push_str(translated.get(core).map_or(core, String::as_str));
                result.push_str(trailing);
            }
            Plan::Tag(value, attrs) => {
                result.push_str(&ATTR.replace_all(value, |attr: &Captures<'_>| {
                    let (quote, original) = if let Some(value) = attr.get(4) {
                        ('"', value.as_str())
                    } else {
                        ('\'', attr.get(5).unwrap().as_str())
                    };
                    if attrs.contains(original)
                        && let Some(value) = translated.get(original)
                    {
                        return format!(
                            "{}{}{}{quote}{value}{quote}",
                            &attr[1], &attr[2], &attr[3]
                        );
                    }
                    attr[0].to_owned()
                }));
            }
        }
    }
    Ok(result)
}
