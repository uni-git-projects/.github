use crate::{
    readme::{encode, request},
    text::decode_html,
};
use anyhow::Result;
use base64::{Engine, engine::general_purpose::STANDARD};
use regex::Regex;
use reqwest::{Url, blocking::Client};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::LazyLock,
    time::Duration,
};

static SCHEME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[a-z][a-z\d+.-]*:").unwrap());
static SCHEME_HOST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[a-z][a-z\d+.-]*://").unwrap());
static WWW: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^www\.").unwrap());
static CAMEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([a-z0-9])([A-Z])").unwrap());
static SEPARATOR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[-_]+").unwrap());
static SVG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<svg\b([^>]*)>(.*?)</svg>").unwrap());
static VIEW_BOX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)\bviewBox=["']([^"']+)["']"#).unwrap());
static TITLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<title>(.*?)</title>").unwrap());
static PATH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?is)<path\b[^>]*?\bd=["']([^"']+)["']"#).unwrap());
static HTTP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^https?://").unwrap());

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitHubOrg {
    login: String,
    avatar_url: String,
    profile_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    website_url: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkIcon {
    title: String,
    view_box: String,
    body: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IconLink {
    key: String,
    label: String,
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    icon: Option<LinkIcon>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fallback_icon: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rel: Option<&'static str>,
    is_open_tab: bool,
}

pub(super) fn client() -> Result<Client> {
    Ok(Client::builder()
        .user_agent("github-profile-readme-site")
        .timeout(Duration::from_secs(60))
        .build()?)
}

fn normalize_external_url(url: &str) -> Option<String> {
    let url = url.trim();
    if url.is_empty() {
        return None;
    }
    let candidate = if SCHEME.is_match(url) {
        url.to_owned()
    } else {
        format!("https://{}", url.strip_prefix("//").unwrap_or(url))
    };
    let parsed = Url::parse(&candidate).ok()?;
    matches!(parsed.scheme(), "http" | "https").then(|| parsed.to_string())
}

pub(super) fn fetch_orgs(client: &Client, names: &[String]) -> Vec<GitHubOrg> {
    let mut seen = HashSet::new();
    names
        .iter()
        .filter_map(|name| {
            let org = name.trim().trim_start_matches('@');
            if org.is_empty() || !seen.insert(org) {
                return None;
            }
            let result = (|| -> Result<GitHubOrg> {
                let url = format!("https://api.github.com/orgs/{}", encode(org));
                let response = request(client, &url, "application/vnd.github+json")
                    .send()?
                    .error_for_status()?;
                let data: serde_json::Value = response.json()?;
                let login = data["login"].as_str().unwrap_or_default().trim();
                let avatar = data["avatar_url"].as_str().unwrap_or_default().trim();
                anyhow::ensure!(
                    !login.is_empty() && !avatar.is_empty(),
                    "Incomplete profile data"
                );
                let profile_url = data["html_url"]
                    .as_str()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map_or_else(
                        || format!("https://github.com/{}", encode(login)),
                        str::to_owned,
                    );
                Ok(GitHubOrg {
                    login: login.to_owned(),
                    avatar_url: avatar.to_owned(),
                    profile_url,
                    website_url: data["blog"].as_str().and_then(normalize_external_url),
                })
            })();
            match result {
                Ok(org) => Some(org),
                Err(error) => {
                    eprintln!("[GitHub organization] @{org}: {error}");
                    None
                }
            }
        })
        .collect()
}

pub(super) fn fetch_avatar(client: &Client, url: &str) -> Option<String> {
    let response = client
        .get(url)
        .header("Accept", "image/*")
        .send()
        .ok()?
        .error_for_status()
        .ok()?;
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("image/png")
        .to_owned();
    if !content_type.starts_with("image/")
        || content_type
            .chars()
            .any(|ch| matches!(ch, '"' | '<' | '>' | '&'))
    {
        return None;
    }
    let encoded = STANDARD.encode(response.bytes().ok()?);
    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
      <defs>
        <clipPath id="avatar-circle">
          <circle cx="32" cy="32" r="31" />
        </clipPath>
      </defs>

      <image
        href="data:{content_type};base64,{encoded}"
        x="1"
        y="1"
        width="62"
        height="62"
        preserveAspectRatio="xMidYMid slice"
        clip-path="url(#avatar-circle)"
      />
    </svg>"##
    );
    Some(format!(
        "data:image/svg+xml;base64,{}",
        STANDARD.encode(svg)
    ))
}

fn norm(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect()
}

fn key_host(key: &str) -> String {
    let key = key.trim();
    let without_scheme = SCHEME_HOST.replace(key, "");
    let host = without_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    WWW.replace(host, "").into_owned()
}

fn candidates(key: &str) -> Vec<String> {
    let host = key_host(key).trim_end_matches('.').to_lowercase();
    let label = host.split('.').next().unwrap_or_default();
    let mut seen = HashSet::new();
    [key.trim(), &host, label]
        .into_iter()
        .filter(|key| !key.is_empty() && seen.insert(*key))
        .map(norm)
        .collect()
}

fn label(key: &str) -> String {
    let host = key_host(key);
    let separated = CAMEL.replace_all(&host, "$1 $2");
    let label = SEPARATOR.replace_all(&separated, " ");
    let mut chars = label.trim().chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().chain(chars).collect()
    })
}

fn svg_files(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext == "svg"))
        .collect();
    files.sort();
    files
}

fn parse_svg(svg: &str, slug: &str, simple: bool) -> Option<LinkIcon> {
    let matches = SVG.captures(svg)?;
    let attributes = matches.get(1)?.as_str();
    let body = matches.get(2)?.as_str().trim();
    if body.is_empty() {
        return None;
    }
    let view_box = VIEW_BOX
        .captures(attributes)
        .and_then(|value| value.get(1))
        .map_or(if simple { "0 0 24 24" } else { "0 0 16 16" }, |value| {
            value.as_str()
        })
        .to_owned();
    if simple {
        let title = TITLE.captures(body)?;
        let title = decode_html(title.get(1)?.as_str());
        let path = PATH.captures(body)?;
        return Some(LinkIcon {
            title,
            view_box,
            body: format!(r#"<path d="{}" />"#, path.get(1)?.as_str()),
        });
    }
    Some(LinkIcon {
        title: label(slug),
        view_box,
        body: body.to_owned(),
    })
}

fn simple_icons(dir: &Path) -> HashMap<String, LinkIcon> {
    let mut index = HashMap::new();
    for path in svg_files(dir) {
        let Some(slug) = path.file_stem().and_then(|name| name.to_str()) else {
            continue;
        };
        let Ok(svg) = fs::read_to_string(&path) else {
            continue;
        };
        let Some(icon) = parse_svg(&svg, slug, true) else {
            continue;
        };
        index.insert(norm(slug), icon.clone());
        index.insert(norm(&icon.title), icon);
    }
    index
}

fn fallback(key: &str, url: &str) -> &'static str {
    let key = norm(key);
    if url.to_lowercase().starts_with("mailto:") || key.contains("email") {
        "email"
    } else if ["website", "portfolio", "homepage"]
        .iter()
        .any(|term| key.contains(term))
    {
        "website"
    } else {
        "link"
    }
}

pub(super) fn links(
    links: &serde_json::Map<String, serde_json::Value>,
    modules: &Path,
) -> Result<Vec<IconLink>> {
    if links
        .values()
        .all(|value| value.as_str().is_none_or(|url| url.trim().is_empty()))
    {
        return Ok(Vec::new());
    }
    let simple_dir = modules.join("simple-icons/icons");
    let bootstrap_dir = modules.join("bootstrap-icons/icons");
    anyhow::ensure!(
        simple_dir.is_dir() && bootstrap_dir.is_dir(),
        "Icon packages not installed. Run: npm ci."
    );
    let simple = simple_icons(&simple_dir);
    anyhow::ensure!(
        !simple.is_empty(),
        "Simple Icons SVG catalog could not be read."
    );
    let bootstrap: HashMap<String, PathBuf> = svg_files(&bootstrap_dir)
        .into_iter()
        .filter_map(|path| Some((norm(path.file_stem()?.to_str()?), path)))
        .collect();
    Ok(links
        .iter()
        .filter_map(|(key, value)| {
            let url = value.as_str()?.trim();
            if url.is_empty() {
                return None;
            }
            let candidates = candidates(key);
            let icon = candidates
                .iter()
                .find_map(|key| simple.get(key).cloned())
                .or_else(|| {
                    candidates.iter().find_map(|key| {
                        let path = bootstrap.get(key)?;
                        parse_svg(
                            &fs::read_to_string(path).ok()?,
                            path.file_stem()?.to_str()?,
                            false,
                        )
                    })
                });
            let is_open_tab = HTTP.is_match(url);
            Some(IconLink {
                key: key.clone(),
                label: icon
                    .as_ref()
                    .map_or_else(|| label(key), |icon| icon.title.clone()),
                url: url.to_owned(),
                fallback_icon: icon.is_none().then(|| fallback(key, url)),
                icon,
                rel: is_open_tab.then_some("noopener noreferrer"),
                is_open_tab,
            })
        })
        .collect())
}
