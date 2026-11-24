use crate::{
    Request, appearance, assets,
    readme::{Readme, fetch_readme},
    translation::{MODEL_ID, Translator, locale_norm},
};
use anyhow::{Context, Result, ensure};
use regex::Regex;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    env, fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

const TAB_SUFFIX: &str = "GitHub Profile";
const LOCALES: &str = include_str!("../../src/locales.json");
const THEME_MODAL: &str = include_str!("../../src/theme-modal.json");

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Config {
    github_name: Option<String>,
    repo_name: Option<String>,
    language: Option<String>,
    locales: Option<Vec<String>>,
    tab_name: Option<String>,
    tagline: Option<String>,
    tab_suffix: Option<String>,
    description: Option<String>,
    ga_id: Option<String>,
    theme: Option<String>,
    theme_color: Option<String>,
    style: Option<String>,
    organizations: Option<Vec<String>>,
    links: serde_json::Map<String, Value>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThemeModal {
    title: String,
    description: String,
    mode: String,
    style: String,
    search_themes: String,
    preview_title: String,
    #[serde(rename = "previewHTML")]
    preview_html: String,
    theme_palette: String,
    style_layers: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GenDoc {
    locale_src: String,
    src_hash: String,
    locale: String,
    generator: Value,
    tab_suffix: String,
    tagline: String,
    theme_modal: ThemeModal,
    readme: Readme,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicDoc<'a> {
    locale: &'a str,
    title: String,
    tagline: &'a str,
    theme_modal: &'a ThemeModal,
    #[serde(rename = "readmeHTML")]
    readme_html: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SiteData<'a> {
    repo_name: &'a str,
    config: PageConfig<'a>,
    locale_src: &'a str,
    locales: &'a [String],
    profile: SourceProfile<'a>,
    layout: appearance::Layout,
    fav_url: Option<String>,
    icon_links: Vec<assets::IconLink>,
    org_badges: Vec<assets::GitHubOrg>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PageConfig<'a> {
    github_name: &'a str,
    github_profile_url: String,
    github_avatar_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tab_name: Option<&'a str>,
    description: &'a str,
    ga_id: &'a str,
    theme: &'a str,
    language: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceProfile<'a> {
    locale: &'a str,
    title: String,
    tagline: &'a str,
    theme_modal: &'a ThemeModal,
    #[serde(rename = "readmeHTML")]
    readme_html: &'a str,
    version: &'a str,
}

fn profile_title(config: &Config, suffix: &str) -> String {
    let title = config
        .tab_name
        .as_deref()
        .filter(|value| !value.is_empty())
        .or(config.github_name.as_deref())
        .unwrap_or_default();
    let suffix = if suffix.is_empty() {
        TAB_SUFFIX
    } else {
        suffix
    };
    format!("{title} — {suffix}")
}

fn preprocess(
    config: &Config,
    source: &str,
    locales: &[String],
    generated: &Path,
    layout: appearance::Layout,
) -> Result<()> {
    let doc: GenDoc =
        read_json(&locale_path(generated, source))?.context("Missing generated source profile")?;
    let client = assets::client()?;
    let github_name = config.github_name.as_deref().unwrap_or_default();
    let profile_url = format!("https://github.com/{github_name}");
    let avatar_url = format!("{profile_url}.png?size=320");
    let icon_links = assets::links(&config.links, Path::new("node_modules"))?;
    let org_badges =
        assets::fetch_orgs(&client, config.organizations.as_deref().unwrap_or_default());
    let fav_url = assets::fetch_avatar(&client, &avatar_url);
    let data = SiteData {
        repo_name: &doc.readme.repo_name,
        config: PageConfig {
            github_name,
            github_profile_url: profile_url,
            github_avatar_url: avatar_url,
            tab_name: config.tab_name.as_deref(),
            description: config.description.as_deref().unwrap_or_default(),
            ga_id: config.ga_id.as_deref().unwrap_or_default(),
            theme: config.theme.as_deref().unwrap_or("abyss"),
            language: config.language.as_deref().unwrap_or("en"),
        },
        locale_src: source,
        locales,
        profile: SourceProfile {
            locale: source,
            title: profile_title(config, &doc.tab_suffix),
            tagline: &doc.tagline,
            theme_modal: &doc.theme_modal,
            readme_html: &doc.readme.html,
            version: &doc.src_hash,
        },
        layout,
        fav_url,
        icon_links,
        org_badges,
    };
    let path = Path::new(".cache/site.json");
    fs::create_dir_all(path.parent().context("Missing site data directory")?)?;
    write_json(path, &data)?;
    println!("Site preprocessing complete.");
    Ok(())
}

fn env_dir(key: &str, default: &str) -> PathBuf {
    let value = env::var(key).unwrap_or_default();
    PathBuf::from(if value.trim().is_empty() {
        default
    } else {
        value.trim()
    })
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    match fs::read(path) {
        Ok(bytes) => {
            Ok(Some(serde_json::from_slice(&bytes).with_context(|| {
                format!("Invalid JSON: {}", path.display())
            })?))
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).with_context(|| format!("Could not read {}", path.display())),
    }
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    fs::write(path, bytes).with_context(|| format!("Could not write {}", path.display()))
}

fn hash(value: &impl Serialize) -> Result<String> {
    use std::fmt::Write;
    let mut encoded = String::with_capacity(64);
    for byte in Sha256::digest(serde_json::to_vec(value)?).iter() {
        write!(encoded, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(encoded)
}

fn model_meta(locale_map_hash: &str) -> Value {
    json!({ "provider": "native-small100-a0d8498", "model": MODEL_ID, "dtype": "int8", "task": "translation", "emoji": "preserve", "localeMap": locale_map_hash })
}

fn locale_path(dir: &Path, locale: &str) -> PathBuf {
    dir.join(format!("{locale}.json"))
}

fn is_current(doc: &GenDoc, locale: &str, source: &str, source_hash: &str, meta: &Value) -> bool {
    doc.locale == locale
        && doc.locale_src == source
        && doc.src_hash == source_hash
        && ["provider", "model", "dtype", "task", "emoji", "localeMap"]
            .iter()
            .all(|key| doc.generator[*key] == meta[*key])
}

fn locales(config: &Config) -> Result<(String, Vec<String>)> {
    let source = locale_norm(config.language.as_deref().unwrap_or_default());
    let source = if source.is_empty() {
        "en".to_owned()
    } else {
        source
    };
    let pattern = Regex::new(r"(?i)^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$")?;
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for locale in std::iter::once(source.as_str()).chain(
        config
            .locales
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(String::as_str),
    ) {
        let locale = locale_norm(locale);
        if locale.is_empty() {
            continue;
        }
        ensure!(pattern.is_match(&locale), "Invalid locale: {locale}");
        if seen.insert(locale.clone()) {
            result.push(locale);
        }
    }
    Ok((source, result))
}

fn translate_theme<F>(
    translator: &mut Translator<F>,
    modal: &ThemeModal,
    target: &str,
) -> Result<ThemeModal>
where
    F: FnMut(&Request) -> Result<String>,
{
    let values = translator.translate_many(
        &[
            &modal.title,
            &modal.description,
            &modal.mode,
            &modal.style,
            &modal.search_themes,
            &modal.preview_title,
            &modal.theme_palette,
            &modal.style_layers,
        ],
        "en",
        target,
    )?;
    let get = |value: &String| values.get(value).unwrap_or(value).clone();
    Ok(ThemeModal {
        title: get(&modal.title),
        description: get(&modal.description),
        mode: get(&modal.mode),
        style: get(&modal.style),
        search_themes: get(&modal.search_themes),
        preview_title: get(&modal.preview_title),
        preview_html: translator.translate_html(&modal.preview_html, "en", target)?,
        theme_palette: get(&modal.theme_palette),
        style_layers: get(&modal.style_layers),
    })
}

fn publish(locales: &[String], config: &Config, generated: &Path, public: &Path) -> Result<()> {
    match fs::remove_dir_all(public) {
        Ok(()) => (),
        Err(error) if error.kind() == ErrorKind::NotFound => (),
        Err(error) => return Err(error.into()),
    }
    if locales.len() <= 1 {
        return Ok(());
    }
    fs::create_dir_all(public)?;
    let title = config
        .tab_name
        .as_deref()
        .filter(|value| !value.is_empty())
        .or(config.github_name.as_deref())
        .unwrap_or_default()
        .trim();
    for locale in locales {
        let doc: GenDoc = read_json(&locale_path(generated, locale))?.with_context(|| {
            format!("Missing generated translation for {locale}. Run: npm run i18n.")
        })?;
        let suffix = if doc.tab_suffix.is_empty() {
            TAB_SUFFIX
        } else {
            &doc.tab_suffix
        };
        write_json(
            &locale_path(public, locale),
            &PublicDoc {
                locale: &doc.locale,
                title: format!("{title} — {suffix}"),
                tagline: &doc.tagline,
                theme_modal: &doc.theme_modal,
                readme_html: &doc.readme.html,
            },
        )?;
    }
    Ok(())
}

pub(super) fn run<F>(infer: F) -> Result<()>
where
    F: FnMut(&Request) -> Result<String>,
{
    let config: Config =
        read_json(Path::new("site.config.json"))?.context("site.config.json could not be read.")?;
    let (source, locales) = locales(&config)?;
    let layout = appearance::generate(
        config.theme.as_deref().unwrap_or_default(),
        config.theme_color.as_deref().unwrap_or_default(),
        config.style.as_deref().unwrap_or_default(),
    )?;
    let mut readme = fetch_readme(
        config.github_name.as_deref().unwrap_or_default(),
        config.repo_name.as_deref().unwrap_or_default(),
    );
    let generated = env_dir("I18N_OUTPUT_DIR", "src/gen/i18n");
    let public = env_dir("I18N_PUBLIC_DIR", "public/i18n");
    if !readme.is_success {
        let previous = read_json::<Value>(&locale_path(&generated, &source))?
            .and_then(|doc| doc.get("readme").cloned())
            .and_then(|doc| serde_json::from_value::<Readme>(doc).ok());
        if let Some(previous) = previous
            && previous.is_success
            && previous.same_repo(&readme)
        {
            eprintln!("Reverting to prior README from the same repo.");
            readme = previous;
        }
    }
    generate(
        infer, &config, &source, &locales, readme, &generated, &public,
    )?;
    preprocess(&config, &source, &locales, &generated, layout)
}

fn generate<F>(
    infer: F,
    config: &Config,
    source: &str,
    locales: &[String],
    readme: Readme,
    generated: &Path,
    public: &Path,
) -> Result<()>
where
    F: FnMut(&Request) -> Result<String>,
{
    let map: Value = serde_json::from_str(LOCALES)?;
    let supported = map
        .as_object()
        .context("Invalid locale map")?
        .values()
        .filter_map(Value::as_str)
        .map(|locale| locale_norm(locale).to_lowercase())
        .collect();
    let meta = model_meta(&hash(&map)?[..16]);
    let mut translator = Translator::new(infer, supported);
    let theme: ThemeModal = serde_json::from_str(THEME_MODAL)?;
    let english = source.to_lowercase().starts_with("en");
    let source_theme = if english {
        theme.clone()
    } else {
        translate_theme(&mut translator, &theme, source)?
    };
    let tagline = config.tagline.as_deref().unwrap_or_default();
    let tab_suffix = config
        .tab_suffix
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(TAB_SUFFIX);
    let source_hash = hash(
        &json!({ "localeSrc": source, "tabSuffix": tab_suffix, "tagline": tagline, "themeModal": theme, "readme": readme }),
    )?;
    fs::create_dir_all(generated)?;
    write_json(
        &locale_path(generated, source),
        &GenDoc {
            locale_src: source.to_owned(),
            src_hash: source_hash.clone(),
            locale: source.to_owned(),
            generator: json!({"provider": "source"}),
            tab_suffix: tab_suffix.to_owned(),
            tagline: tagline.to_owned(),
            theme_modal: source_theme,
            readme: readme.clone(),
        },
    )?;
    let mut stale = Vec::new();
    for locale in locales.iter().filter(|locale| locale.as_str() != source) {
        translator.validate_route(source, locale)?;
        let doc = read_json::<Value>(&locale_path(generated, locale))?
            .and_then(|doc| serde_json::from_value::<GenDoc>(doc).ok());
        if !doc
            .as_ref()
            .is_some_and(|doc| is_current(doc, locale, source, &source_hash, &meta))
        {
            stale.push(locale);
        }
    }
    if stale.is_empty() {
        publish(locales, config, generated, public)?;
        println!("Translations are up to date.");
        return Ok(());
    }
    println!(
        "Generating: {}",
        stale
            .iter()
            .map(|locale| locale.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    );
    for locale in stale {
        println!("Translating {source} -> {locale}...");
        let values = translator.translate_many(&[tab_suffix, tagline], source, locale)?;
        let mut translated = readme.clone();
        translated.html = translator.translate_html(&readme.html, source, locale)?;
        let theme_modal = translate_theme(&mut translator, &theme, locale)?;
        write_json(
            &locale_path(generated, locale),
            &GenDoc {
                locale_src: source.to_owned(),
                src_hash: source_hash.clone(),
                locale: locale.clone(),
                generator: meta.clone(),
                tab_suffix: values
                    .get(tab_suffix)
                    .map_or(tab_suffix, String::as_str)
                    .to_owned(),
                tagline: values
                    .get(tagline)
                    .map_or(tagline, String::as_str)
                    .to_owned(),
                theme_modal,
                readme: translated,
            },
        )?;
    }
    publish(locales, config, generated, public)?;
    println!("Profile translations complete.");
    Ok(())
}
