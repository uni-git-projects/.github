use crate::text::escape_html;
use anyhow::{Result, ensure};
use regex::{Captures, Regex};
use reqwest::{Url, blocking::Client};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{env, time::Duration};

const GH_API_VERSION: &str = "2026-03-10";
const JSON: &str = "application/vnd.github+json";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Readme {
    pub owner: String,
    pub repo_name: String,
    pub readme_dir: String,
    pub html: String,
    pub is_success: bool,
}

impl Readme {
    pub fn same_repo(&self, other: &Self) -> bool {
        self.owner == other.owner
            && self.repo_name == other.repo_name
            && self.readme_dir == other.readme_dir
    }

    fn api_url(&self, path: &str) -> String {
        format!(
            "https://api.github.com/repos/{}/{}{path}",
            encode(&self.owner),
            encode(&self.repo_name)
        )
    }

    fn fail(mut self, message: &str) -> Self {
        eprintln!("[GitHub README] {message}");
        self.html = format!(
            "\n    <h1>{}</h1>\n    <p>The profile README could not be loaded.</p>\n    <p><a href=\"https://github.com/{}/{}\">Open the GitHub repository</a></p>\n  ",
            escape_html(&self.owner),
            encode(&self.owner),
            encode(&self.repo_name)
        );
        self
    }
}

pub(super) fn encode(value: &str) -> String {
    use std::fmt::Write;
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            write!(encoded, "%{byte:02X}").expect("writing to String cannot fail");
        }
    }
    encoded
}

fn encode_path(value: &str) -> String {
    value
        .split('/')
        .filter(|part| !part.is_empty())
        .map(encode)
        .collect::<Vec<_>>()
        .join("/")
}

pub(super) fn request(
    client: &Client,
    url: &str,
    accept: &str,
) -> reqwest::blocking::RequestBuilder {
    let request = client
        .get(url)
        .header("Accept", accept)
        .header("X-GitHub-Api-Version", GH_API_VERSION);
    match env::var("GITHUB_TOKEN") {
        Ok(token) if !token.trim().is_empty() => request.bearer_auth(token.trim()),
        _ => request,
    }
}

fn api_json(client: &Client, url: &str) -> Option<Value> {
    request(client, url, JSON)
        .send()
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .ok()
}

pub(super) fn fetch_readme(username: &str, repo: &str) -> Readme {
    let owner = username.trim();
    let repo = repo.trim();
    let mut readme = Readme {
        owner: owner.to_owned(),
        repo_name: if repo.is_empty() { owner } else { repo }.to_owned(),
        readme_dir: if repo == ".github" { "profile" } else { "" }.to_owned(),
        html: String::new(),
        is_success: false,
    };
    match fetch(&mut readme, repo) {
        Ok(()) => readme,
        Err(error) => readme.fail(&error.to_string()),
    }
}

fn fetch(readme: &mut Readme, repo: &str) -> Result<()> {
    ensure!(!readme.owner.is_empty(), "githubName is required.");
    ensure!(
        !repo.contains('/'),
        "repoName must be only be the repository in owner/repository."
    );
    let client = Client::builder()
        .user_agent("github-profile-readme-site")
        .timeout(Duration::from_secs(60))
        .build()?;
    let is_org = if repo.is_empty() || repo == ".github" {
        api_json(
            &client,
            &format!("https://api.github.com/users/{}", encode(&readme.owner)),
        )
        .map(|account| account["type"] == "Organization")
    } else {
        Some(false)
    };
    if repo.is_empty() && is_org == Some(true) {
        readme.repo_name = ".github".to_owned();
    }
    readme.readme_dir = if readme.repo_name == ".github" && is_org != Some(false) {
        "profile"
    } else {
        ""
    }
    .to_owned();
    let path = if readme.readme_dir.is_empty() {
        "/readme".to_owned()
    } else {
        format!("/readme/{}", encode_path(&readme.readme_dir))
    };
    let response = request(
        &client,
        &readme.api_url(&path),
        "application/vnd.github.raw+json",
    )
    .send()?;
    let status = response.status();
    ensure!(
        status.is_success(),
        "GitHub API returned {status}. Confirm that {}/{}/{}README.md is public.",
        readme.owner,
        readme.repo_name,
        if readme.readme_dir.is_empty() {
            String::new()
        } else {
            format!("{}/", readme.readme_dir)
        }
    );
    let markdown = response.text()?;
    let info = api_json(&client, &readme.api_url(""));
    let branch = info
        .as_ref()
        .and_then(|value| value["default_branch"].as_str())
        .filter(|branch| !branch.trim().is_empty())
        .unwrap_or("HEAD");
    readme.html = render(&markdown, readme, branch);
    readme.is_success = true;
    Ok(())
}

fn render(markdown: &str, readme: &Readme, branch: &str) -> String {
    let mut options = comrak::Options::default();
    options.extension.strikethrough = true;
    options.extension.table = true;
    options.extension.autolink = true;
    options.extension.tasklist = true;
    options.render.r#unsafe = true;
    let html = comrak::markdown_to_html(markdown, &options);
    let html = format_tag(
        &format_tag(&normalize_heading(&html), "h1", "readme-title"),
        "p",
        "readme-intro",
    );
    optimize_images(&format_urls(&html, readme, branch))
}

fn pattern(value: &str) -> Regex {
    Regex::new(value).expect("valid HTML pattern")
}

fn has_class(attrs: &str, class: &str) -> bool {
    let regex = pattern(r#"(?is)\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')"#);
    regex.captures(attrs).is_some_and(|captures| {
        captures
            .get(1)
            .or_else(|| captures.get(2))
            .unwrap()
            .as_str()
            .split_whitespace()
            .any(|value| value == class)
    })
}

fn strip_anchors(html: &str) -> String {
    pattern(r"(?is)<a\b([^>]*)>.*?</a>")
        .replace_all(html, |captures: &Captures<'_>| {
            if has_class(&captures[1], "anchor") {
                String::new()
            } else {
                captures[0].to_owned()
            }
        })
        .into_owned()
}

fn normalize_heading(html: &str) -> String {
    let heading = pattern(r"(?is)<h1\b[^>]*>.*?</h1>");
    let wrapper = pattern(r"(?is)<div\b([^>]*)>.*?</div>");
    let mut html = html.to_owned();
    let replacement = wrapper
        .captures_iter(&html)
        .find(|captures| has_class(&captures[1], "markdown-heading"))
        .and_then(|captures| {
            let wrapper = captures.get(0)?;
            let head = heading.find(wrapper.as_str())?;
            Some((wrapper.range(), strip_anchors(head.as_str())))
        });
    if let Some((range, replacement)) = replacement {
        html.replace_range(range, &replacement);
    }
    let html = heading.replace(&html, |captures: &Captures<'_>| strip_anchors(&captures[0]));
    let adjacent = pattern(r"(?is)(<h1\b[^>]*>.*?</h1>)\s*<a\b([^>]*)>.*?</a>");
    for captures in adjacent.captures_iter(&html) {
        if has_class(&captures[2], "anchor") {
            let mut result = html.to_string();
            result.replace_range(captures.get(0).unwrap().range(), &captures[1]);
            return result;
        }
    }
    html.into_owned()
}

fn format_tag(html: &str, tag: &str, class: &str) -> String {
    let classes = pattern(r#"(?is)\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')"#);
    pattern(&format!(r"(?i)<{tag}\b([^>]*)>"))
        .replace(html, |captures: &Captures<'_>| {
            let attrs = &captures[1];
            let attrs = if classes.is_match(attrs) {
                classes
                    .replace(attrs, |captures: &Captures<'_>| {
                        let (quote, value) = if let Some(value) = captures.get(1) {
                            ('"', value.as_str())
                        } else {
                            ('\'', captures.get(2).unwrap().as_str())
                        };
                        let mut values: Vec<_> = value.split_whitespace().collect();
                        if !values.contains(&class) {
                            values.push(class);
                        }
                        format!(" class={quote}{}{quote}", values.join(" "))
                    })
                    .into_owned()
            } else {
                format!("{attrs} class=\"{class}\"")
            };
            format!("<{tag}{attrs}>")
        })
        .into_owned()
}

fn relative_url(value: &str, base: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() || pattern(r"(?i)^(?:[a-z][a-z0-9+.-]*:|//|#)").is_match(trimmed) {
        return value.to_owned();
    }
    if trimmed.starts_with('/') {
        return format!("https://github.com{trimmed}");
    }
    Url::parse(base)
        .and_then(|base| base.join(trimmed))
        .map_or_else(|_| value.to_owned(), |url| url.to_string())
}

fn format_attr<F>(html: &str, tags: &str, attr: &str, format: F) -> String
where
    F: Fn(&str) -> String,
{
    let regex = pattern(&format!(
        r#"(?is)(<(?:{tags})\b[^>]*?\s{attr}\s*=\s*)(?:"([^"]*)"|'([^']*)')"#
    ));
    regex
        .replace_all(html, |captures: &Captures<'_>| {
            let (quote, value) = if let Some(value) = captures.get(2) {
                ('"', value.as_str())
            } else {
                ('\'', captures.get(3).unwrap().as_str())
            };
            format!("{}{quote}{}{quote}", &captures[1], format(value))
        })
        .into_owned()
}

fn format_urls(html: &str, readme: &Readme, branch: &str) -> String {
    let owner = encode(&readme.owner);
    let repo = encode(&readme.repo_name);
    let branch = encode(branch);
    let dir = if readme.readme_dir.is_empty() {
        String::new()
    } else {
        format!("{}/", encode_path(&readme.readme_dir))
    };
    let raw = format!("https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{dir}");
    let blob = format!("https://github.com/{owner}/{repo}/blob/{branch}/{dir}");
    let html = format_attr(html, "img|source|video|audio|track|input", "src", |value| {
        relative_url(value, &raw)
    });
    let html = format_attr(&html, "img|source", "data-canonical-src", |value| {
        relative_url(value, &raw)
    });
    let html = format_attr(&html, "img|source", "srcset", |value| {
        if value.trim().starts_with("data:") {
            return value.to_owned();
        }
        value
            .split(',')
            .map(|item| {
                let mut parts = item.split_whitespace();
                let url = relative_url(parts.next().unwrap_or_default(), &raw);
                parts
                    .next()
                    .map_or_else(|| url.clone(), |descriptor| format!("{url} {descriptor}"))
            })
            .collect::<Vec<_>>()
            .join(", ")
    });
    format_attr(&html, "a|area", "href", |value| relative_url(value, &blob))
}

fn optimize_images(html: &str) -> String {
    let svg = pattern(r#"(?i)\bsrc\s*=\s*["'][^"']*\.svg(?:[?#]|["'])"#);
    let decoding = pattern(r"(?i)\bdecoding\s*=");
    let loading = pattern(r"(?i)\bloading\s*=");
    let priority = pattern(r"(?i)\bfetchpriority\s*=");
    let mut first = true;
    pattern(r"(?i)<img\b([^>]*)>")
        .replace_all(html, |captures: &Captures<'_>| {
            let eager = first && !svg.is_match(&captures[1]);
            first = false;
            let attrs = captures[1].trim_end();
            let (attrs, close) = if let Some(attrs) = attrs.strip_suffix('/') {
                (attrs.trim_end(), " />")
            } else {
                (attrs, ">")
            };
            let mut result = format!("<img{attrs}");
            if !decoding.is_match(&result) {
                result.push_str(" decoding=\"async\"");
            }
            if !loading.is_match(&result) {
                result.push_str(if eager {
                    " loading=\"eager\""
                } else {
                    " loading=\"lazy\""
                });
            }
            if !priority.is_match(&result) {
                result.push_str(if eager {
                    " fetchpriority=\"high\""
                } else {
                    " fetchpriority=\"low\""
                });
            }
            result.push_str(close);
            result
        })
        .into_owned()
}
