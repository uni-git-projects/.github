use anyhow::{Context, Result, ensure};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{collections::BTreeMap, fs};

const THEME_TOKENS: &[&str] = &[
    "--page-background",
    "--page-glow",
    "--page-text",
    "--details-border",
    "--tagline-text",
    "--focus-ring",
    "--success-text",
    "--toggle-background",
    "--toggle-border",
    "--toggle-text",
    "--toggle-shadow",
    "--link-background",
    "--link-border",
    "--link-text",
    "--link-shadow",
    "--link-hover-background",
    "--link-hover-border",
    "--link-hover-text",
    "--readme-text",
    "--readme-heading",
    "--readme-muted",
    "--readme-link",
    "--readme-link-hover",
    "--readme-border",
    "--readme-blockquote-text",
    "--readme-blockquote-border",
    "--readme-table-row-alt",
    "--readme-kbd-background",
    "--readme-kbd-border",
    "--readme-kbd-text",
    "--readme-mark-background",
    "--code-background",
    "--code-text",
    "--inline-code-background",
    "--syntax-comment",
    "--syntax-keyword",
    "--syntax-string",
    "--syntax-function",
    "--syntax-entity",
    "--syntax-variable",
    "--syntax-tag",
];

#[derive(Deserialize)]
struct Theme {
    light: Map<String, Value>,
    dark: Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Style {
    bg: String,
    bg_size: Option<String>,
    bg_pos: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThemeData {
    names: Vec<String>,
    default_name: String,
    colors: BTreeMap<String, Value>,
    theme_color: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StyleData {
    names: Vec<String>,
    default_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Layout {
    theme: ThemeData,
    style: StyleData,
    theme_css: String,
    style_css: String,
    theme_color_inline_css: Option<String>,
    fixed_theme_tone: Option<&'static str>,
    light_theme_color: Option<String>,
    dark_theme_color: Option<String>,
    uncolored_light_theme_color: Option<String>,
    uncolored_dark_theme_color: Option<String>,
}

fn validate_variant(name: &str, variant: &Map<String, Value>, pattern: &Regex) -> Result<()> {
    for (property, value) in variant {
        ensure!(
            pattern.is_match(property)
                && value.as_str().is_some_and(|value| !value.trim().is_empty()),
            "Invalid token in theme {name:?}: {property}"
        );
    }
    let missing: Vec<&str> = THEME_TOKENS
        .iter()
        .copied()
        .filter(|token| !variant.contains_key(*token))
        .collect();
    ensure!(
        missing.is_empty(),
        "Theme {name:?} is missing required tokens: {}",
        missing.join(", ")
    );
    Ok(())
}

fn variant_css(variant: &Map<String, Value>) -> String {
    variant
        .iter()
        .map(|(key, value)| format!("{key}:{};", value.as_str().unwrap_or_default()))
        .collect()
}

fn theme_css(name: &str, theme: &Theme) -> Result<String> {
    let name = serde_json::to_string(name)?;
    let light = variant_css(&theme.light);
    let dark = variant_css(&theme.dark);
    Ok(format!(
        r#"html[data-site-theme={name}],:is(.site-theme-dialog,.site-style-dialog)[data-preview-mode="light"] .site-theme-preview[data-site-theme-preview={name}]{{{light}}}html[data-site-theme={name}].dark,:is(.site-theme-dialog,.site-style-dialog)[data-preview-mode="dark"] .site-theme-preview[data-site-theme-preview={name}]{{{dark}}}"#
    ))
}

fn background(variant: &Map<String, Value>) -> Option<String> {
    variant
        .get("--page-background")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn parse_number(value: &str, max: f64) -> Option<f64> {
    let value = value.trim();
    let percent = value.ends_with('%');
    let (number, limit) = value
        .strip_suffix('%')
        .map_or((value, max), |value| (value, 100.0));
    let number: f64 = number.parse().ok()?;
    (number.is_finite() && (0.0..=limit).contains(&number)).then_some(if percent {
        number / 100.0 * max
    } else {
        number
    })
}

fn parse_color(value: &str) -> Option<[f64; 3]> {
    if let Some(hex) = value.strip_prefix('#') {
        if !matches!(hex.len(), 3 | 4 | 6 | 8) || !hex.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return None;
        }
        let hex = if hex.len() <= 4 {
            hex.chars()
                .flat_map(|digit| [digit, digit])
                .collect::<String>()
        } else {
            hex.to_owned()
        };
        return Some([
            f64::from(u8::from_str_radix(&hex[0..2], 16).ok()?),
            f64::from(u8::from_str_radix(&hex[2..4], 16).ok()?),
            f64::from(u8::from_str_radix(&hex[4..6], 16).ok()?),
        ]);
    }
    let lower = value.to_ascii_lowercase();
    let body = lower
        .strip_prefix("rgb(")
        .or_else(|| lower.strip_prefix("rgba("))?
        .strip_suffix(')')?;
    let (channels, alpha): (Vec<&str>, Option<&str>) = if body.contains(',') {
        let parts: Vec<&str> = body.split(',').collect();
        if !matches!(parts.len(), 3 | 4) {
            return None;
        }
        (parts[..3].to_vec(), parts.get(3).copied())
    } else {
        let (channels, alpha) = body
            .split_once('/')
            .map_or((body, None), |(channels, alpha)| (channels, Some(alpha)));
        (channels.split_whitespace().collect(), alpha)
    };
    if channels.len() != 3 || alpha.is_some_and(|alpha| parse_number(alpha, 1.0).is_none()) {
        return None;
    }
    Some([
        parse_number(channels[0], 255.0)?,
        parse_number(channels[1], 255.0)?,
        parse_number(channels[2], 255.0)?,
    ])
}

fn color_tone(rgb: [f64; 3]) -> &'static str {
    let [r, g, b] = rgb.map(|channel| {
        let value = channel / 255.0;
        if value <= 0.04045 {
            value / 12.92
        } else {
            ((value + 0.055) / 1.055).powf(2.4)
        }
    });
    if 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.179 {
        "dark"
    } else {
        "light"
    }
}

fn style_css(name: &str, style: &Style) -> Result<String> {
    let name_str = serde_json::to_string(name)?;
    let mut declarations = format!("background:{};", style.bg);
    for (property, value) in [
        ("background-size", &style.bg_size),
        ("background-position", &style.bg_pos),
    ] {
        if let Some(value) = value.as_ref().filter(|value| !value.trim().is_empty()) {
            declarations.push_str(&format!("{property}:{value};"));
        }
    }
    let shared_stars = if name == "stars" {
        format!(
            ":root{{--stars-style-background:{};--stars-style-background-size:{};--stars-style-background-position:{};}}",
            style.bg,
            style.bg_size.as_deref().unwrap_or("auto"),
            style.bg_pos.as_deref().unwrap_or("center")
        )
    } else {
        String::new()
    };
    let site = format!("html[data-theme-style={name_str}] body{{{declarations}}}");
    let light_stars = if name == "stars" {
        format!(
            "html[data-theme-style={name_str}]:not(.dark) body{{background:#fff;background-size:auto;background-position:0 0;}}"
        )
    } else {
        String::new()
    };
    let preview = format!(
        ".site-theme-dialog[data-preview-style={name_str}] .site-theme-preview-style-layer,.site-style-dialog .site-theme-preview-style-layer[data-site-style-preview={name_str}]{{{declarations}}}"
    );
    let light_preview = if name == "stars" {
        format!(
            r#".site-theme-dialog[data-preview-mode="light"][data-preview-style={name_str}] .site-theme-preview-style-layer,.site-style-dialog[data-preview-mode="light"] .site-theme-preview-style-layer[data-site-style-preview={name_str}]{{background:#fff;background-size:auto;background-position:0 0;}}"#
        )
    } else {
        String::new()
    };
    Ok(format!(
        "{shared_stars}{site}{light_stars}{preview}{light_preview}"
    ))
}

pub(super) fn generate(theme: &str, color: &str, style: &str) -> Result<Layout> {
    let themes: BTreeMap<String, Theme> = serde_json::from_slice(&fs::read("src/themes.json")?)?;
    let styles: BTreeMap<String, Style> =
        serde_json::from_slice(&fs::read("src/styles/styles.json")?)?;
    let pattern = Regex::new(r"(?i)^--[a-z0-9-]+$")?;
    let mut all_themes = String::new();
    let mut all_styles = String::new();
    let mut colors = BTreeMap::new();
    for (name, theme) in &themes {
        validate_variant(name, &theme.light, &pattern)?;
        validate_variant(name, &theme.dark, &pattern)?;
        ensure!(
            theme.light.len() == theme.dark.len()
                && theme.light.keys().all(|key| theme.dark.contains_key(key)),
            "Theme {name:?} must define the same tokens in light and dark variants."
        );
        all_themes.push_str(&theme_css(name, theme)?);
        colors.insert(
            name.clone(),
            json!({"light": background(&theme.light), "dark": background(&theme.dark)}),
        );
    }
    for (name, style) in &styles {
        ensure!(
            !style.bg.trim().is_empty(),
            "Theme style {name:?} must define a background."
        );
        all_styles.push_str(&style_css(name, style)?);
    }
    let theme = theme.trim();
    let style = style.trim();
    let color = color.trim();
    ensure!(
        parse_color(theme).is_none(),
        "Theme {theme:?} is a color. Put HEX/RGB colors in themeColor instead."
    );
    ensure!(
        theme != "all",
        "Theme all has been removed; use a theme name such as star_wars, stars, or abyss."
    );
    ensure!(
        style != "all",
        "Style all has been removed; use a style name such as stars or solid."
    );
    let selected = if theme.is_empty() {
        None
    } else {
        Some(themes.get(theme).with_context(|| {
            format!(
                "Unknown theme {theme:?}. Available themes: {}",
                themes.keys().cloned().collect::<Vec<_>>().join(", ")
            )
        })?)
    };
    if !style.is_empty() {
        ensure!(
            styles.contains_key(style),
            "Unknown style {style:?}. Available: {}",
            styles.keys().cloned().collect::<Vec<_>>().join(", ")
        );
    }
    let rgb =
        if color.is_empty() {
            None
        } else {
            Some(parse_color(color).with_context(|| {
                format!("Invalid themeColor {color:?}. Use a HEX or RGB color.")
            })?)
        };
    let fixed_theme_tone = if selected.is_none() {
        rgb.map(color_tone)
    } else {
        None
    };
    let inline_css = if let Some(tone) = fixed_theme_tone {
        Some(fixed_color_css(color, tone))
    } else if rgb.is_some() {
        Some(accent_css(color))
    } else {
        None
    };
    let theme_color = rgb.map(|_| color.to_owned());
    let uncolored_light = selected.and_then(|theme| background(&theme.light));
    let uncolored_dark = selected.and_then(|theme| background(&theme.dark));
    Ok(Layout {
        theme: ThemeData {
            names: themes.keys().cloned().collect(),
            default_name: if theme.is_empty() { "abyss" } else { theme }.to_owned(),
            colors,
            theme_color: theme_color.clone(),
        },
        style: StyleData {
            names: styles.keys().cloned().collect(),
            default_name: if style.is_empty() { "solid" } else { style }.to_owned(),
        },
        theme_css: all_themes,
        style_css: all_styles,
        theme_color_inline_css: inline_css,
        fixed_theme_tone,
        light_theme_color: theme_color.clone().or_else(|| uncolored_light.clone()),
        dark_theme_color: theme_color.or_else(|| uncolored_dark.clone()),
        uncolored_light_theme_color: uncolored_light,
        uncolored_dark_theme_color: uncolored_dark,
    })
}

fn fixed_color_css(col: &str, mode: &str) -> String {
    let foreground = if mode == "dark" { "#ffffff" } else { "#000000" };
    let glow = format!("color-mix(in srgb, {foreground} 12%, transparent)");
    let success = if mode == "dark" { "#7ee787" } else { "#116329" };
    let syntax = if mode == "dark" {
        [
            "#d1d5db", "#ff9b94", "#b9dcff", "#dfbaff", "#ffc078", "#9bd0ff", "#9aefad",
        ]
    } else {
        [
            "#4b5563", "#b4232f", "#063b78", "#6f42c1", "#7c2d12", "#034ea2", "#0f5d2f",
        ]
    };
    let [comment, keyword, string, function, entity, variable, tag] = syntax;
    [
        format!("--page-background:{col}"),
        format!("--page-glow:{glow}"),
        format!("--page-text:{foreground}"),
        format!("--details-border:color-mix(in srgb, {foreground} 28%, transparent)"),
        format!("--tagline-text:color-mix(in srgb, {foreground} 76%, transparent)"),
        format!("--focus-ring:color-mix(in srgb, {foreground} 42%, transparent)"),
        format!("--success-text:{success}"),
        format!("--toggle-background:color-mix(in srgb, {col} 82%, {foreground} 18%)"),
        format!("--toggle-border:color-mix(in srgb, {foreground} 30%, transparent)"),
        format!("--toggle-text:{foreground}"),
        "--toggle-shadow:0 8px 24px rgb(0 0 0 / 0.22)".to_owned(),
        format!("--link-background:color-mix(in srgb, {col} 86%, {foreground} 14%)"),
        format!("--link-border:color-mix(in srgb, {foreground} 28%, transparent)"),
        format!("--link-text:{foreground}"),
        "--link-shadow:0 4px 12px rgb(0 0 0 / 0.18)".to_owned(),
        format!("--link-hover-background:color-mix(in srgb, {col} 72%, {foreground} 28%)"),
        format!("--link-hover-border:color-mix(in srgb, {foreground} 55%, transparent)"),
        format!("--link-hover-text:{foreground}"),
        format!("--readme-text:{foreground}"),
        format!("--readme-heading:{foreground}"),
        format!("--readme-muted:color-mix(in srgb, {foreground} 72%, transparent)"),
        format!("--readme-link:{foreground}"),
        format!("--readme-link-hover:{foreground}"),
        format!("--readme-border:color-mix(in srgb, {foreground} 28%, transparent)"),
        format!("--readme-blockquote-text:color-mix(in srgb, {foreground} 76%, transparent)"),
        format!("--readme-blockquote-border:color-mix(in srgb, {foreground} 38%, transparent)"),
        format!("--readme-table-row-alt:color-mix(in srgb, {foreground} 7%, transparent)"),
        format!("--readme-kbd-background:color-mix(in srgb, {foreground} 10%, transparent)"),
        format!("--readme-kbd-border:color-mix(in srgb, {foreground} 30%, transparent)"),
        format!("--readme-kbd-text:{foreground}"),
        format!("--readme-mark-background:color-mix(in srgb, {foreground} 20%, transparent)"),
        format!("--code-background:color-mix(in srgb, {col} 88%, {foreground} 12%)"),
        format!("--code-text:{foreground}"),
        format!("--inline-code-background:color-mix(in srgb, {foreground} 12%, transparent)"),
        format!("--syntax-comment:{comment}"),
        format!("--syntax-keyword:{keyword}"),
        format!("--syntax-string:{string}"),
        format!("--syntax-function:{function}"),
        format!("--syntax-entity:{entity}"),
        format!("--syntax-variable:{variable}"),
        format!("--syntax-tag:{tag}"),
    ]
    .join(";")
}

fn accent_css(col: &str) -> String {
    [
        format!("--focus-ring:color-mix(in srgb, {col} 55%, transparent)"),
        format!("--toggle-background:color-mix(in srgb, {col} 10%, var(--page-background))"),
        format!("--toggle-border:color-mix(in srgb, {col} 52%, var(--details-border))"),
        format!("--toggle-text:color-mix(in srgb, {col} 72%, var(--page-text))"),
        format!("--link-background:color-mix(in srgb, {col} 10%, var(--page-background))"),
        format!("--link-border:color-mix(in srgb, {col} 48%, var(--details-border))"),
        format!("--link-text:color-mix(in srgb, {col} 72%, var(--page-text))"),
        format!("--link-hover-background:color-mix(in srgb, {col} 18%, var(--page-background))"),
        format!("--link-hover-border:{col}"),
        format!("--link-hover-text:color-mix(in srgb, {col} 86%, var(--page-text))"),
        format!("--readme-link:color-mix(in srgb, {col} 78%, var(--page-text))"),
        format!("--readme-link-hover:color-mix(in srgb, {col} 90%, var(--page-text))"),
        format!("--readme-blockquote-border:color-mix(in srgb, {col} 52%, var(--readme-border))"),
        format!("--readme-mark-background:color-mix(in srgb, {col} 24%, transparent)"),
    ]
    .join(";")
}
