use regex::{Captures, Regex};
use std::sync::LazyLock;
use unicode_segmentation::UnicodeSegmentation;

static MODEL_TEXT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{L}\p{N}]").unwrap());
static WORDS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{L}\p{N}]+").unwrap());
static SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
static EMOJI: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[\p{Emoji_Presentation}\p{Extended_Pictographic}]|\u{20E3}").unwrap()
});
static ENTITY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)&(?:#([0-9]+)|#x([0-9a-f]+)|([a-z][0-9a-z]+));").unwrap());

pub(super) fn is_model_text(value: &str) -> bool {
    MODEL_TEXT.is_match(value)
}

pub(super) fn split_ws(value: &str) -> (&str, &str, &str) {
    let start = value.len() - value.trim_start().len();
    let core = value[start..].trim_end();
    (&value[..start], core, &value[start + core.len()..])
}

pub(super) fn split_emoji(value: &str) -> Vec<(bool, &str)> {
    let mut result = Vec::new();
    let mut offset = 0;
    for (index, grapheme) in value.grapheme_indices(true) {
        if EMOJI.is_match(grapheme) {
            if index > offset {
                result.push((false, &value[offset..index]));
            }
            result.push((true, grapheme));
            offset = index + grapheme.len();
        }
    }
    if offset < value.len() || result.is_empty() {
        result.push((false, &value[offset..]));
    }
    result
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

pub(super) fn split_text(value: &str, limit: usize) -> Vec<String> {
    if utf16_len(value) <= limit {
        return vec![value.to_owned()];
    }
    let mut chunks = Vec::new();
    let mut current = String::new();
    let push = |chunks: &mut Vec<String>, current: &mut String| {
        if !current.is_empty() {
            chunks.push(std::mem::take(current));
        }
    };
    for sentence in value.split_sentence_bounds() {
        if utf16_len(sentence) <= limit {
            if utf16_len(&current) + utf16_len(sentence) > limit {
                push(&mut chunks, &mut current);
            }
            current.push_str(sentence);
            continue;
        }
        push(&mut chunks, &mut current);
        let mut start = 0;
        let mut parts = Vec::new();
        for space in SPACE.find_iter(sentence) {
            parts.push(&sentence[start..space.start()]);
            parts.push(space.as_str());
            start = space.end();
        }
        parts.push(&sentence[start..]);
        for part in parts {
            if utf16_len(&current) + utf16_len(part) > limit {
                push(&mut chunks, &mut current);
            }
            if utf16_len(part) <= limit {
                current.push_str(part);
                continue;
            }
            let mut start = 0;
            let mut len = 0;
            for (index, ch) in part.char_indices() {
                if len + ch.len_utf16() > limit {
                    chunks.push(part[start..index].to_owned());
                    start = index;
                    len = 0;
                }
                len += ch.len_utf16();
            }
            if start < part.len() {
                chunks.push(part[start..].to_owned());
            }
        }
    }
    push(&mut chunks, &mut current);
    chunks
}

fn repeated<T: PartialEq>(items: &[T], max_size: usize, count: usize, min_length: usize) -> bool {
    for size in 1..=max_size.min(items.len() / count) {
        for index in 0..=items.len() - size * count {
            let pattern = &items[index..index + size];
            let repeats = items[index..]
                .chunks_exact(size)
                .take_while(|chunk| *chunk == pattern)
                .count();
            if repeats >= count && repeats * size >= min_length {
                return true;
            }
        }
    }
    false
}

pub(super) fn invalid_translation(source: &str, translated: &str) -> Option<String> {
    let translated = translated.trim();
    if translated.is_empty() {
        return Some("empty output".to_owned());
    }
    let length = translated.chars().count();
    let max_chars = (source.trim().chars().count() * 4 + 24).max(80);
    if length > max_chars {
        return Some(format!("output ({length} > {max_chars})"));
    }
    let lower = translated.to_lowercase();
    let words: Vec<_> = WORDS.find_iter(&lower).map(|word| word.as_str()).collect();
    let chars: Vec<_> = translated
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect();
    if repeated(&words, 4, 3, 3) || repeated(&chars, 8, 4, 8) {
        return Some("repetition".to_owned());
    }
    None
}

pub(super) fn max_tokens(source: &str, cap: usize) -> usize {
    ((source.chars().count() * 5).div_ceil(2) + 8)
        .max(16)
        .min(cap.max(16))
}

pub(super) fn preview(value: &str) -> String {
    SPACE.replace_all(value, " ").chars().take(80).collect()
}

pub(super) fn escape_html(value: &str) -> String {
    let mut result = String::new();
    for ch in value.chars() {
        match ch {
            '&' => result.push_str("&amp;"),
            '<' => result.push_str("&lt;"),
            '>' => result.push_str("&gt;"),
            '"' => result.push_str("&quot;"),
            '\'' => result.push_str("&#39;"),
            _ => result.push(ch),
        }
    }
    result
}

pub(super) fn decode_html(value: &str) -> String {
    ENTITY
        .replace_all(value, |captures: &Captures<'_>| {
            if let Some(number) = captures.get(1).or_else(|| captures.get(2)) {
                let radix = if captures.get(1).is_some() { 10 } else { 16 };
                return u32::from_str_radix(number.as_str(), radix)
                    .ok()
                    .and_then(char::from_u32)
                    .map_or_else(|| captures[0].to_owned(), |ch| ch.to_string());
            }
            match captures[3].to_ascii_lowercase().as_str() {
                "amp" => "&",
                "apos" => "'",
                "copy" => "©",
                "gt" => ">",
                "hellip" => "…",
                "laquo" => "«",
                "ldquo" => "“",
                "lsquo" => "‘",
                "lt" => "<",
                "mdash" => "—",
                "nbsp" => "\u{a0}",
                "ndash" => "–",
                "quot" => "\"",
                "raquo" => "»",
                "rdquo" => "”",
                "reg" => "®",
                "rsquo" => "’",
                "trade" => "™",
                _ => &captures[0],
            }
            .to_owned()
        })
        .into_owned()
}
