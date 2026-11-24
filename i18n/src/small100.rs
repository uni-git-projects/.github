use crate::Request;
use anyhow::{Context, Result, ensure};
use ort::{
    session::{Session, SessionInputValue},
    value::{DynValue, Tensor},
};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

const EOS: i64 = 2;
const MAX_POSITIONS: usize = 1024;

#[derive(Deserialize)]
struct LanguageTokens {
    lang_to_id: BTreeMap<String, i64>,
}

pub(super) struct Small100 {
    tokenizer: tokenizers::Tokenizer,
    languages: BTreeMap<String, i64>,
    encoder: Session,
    decoder: Session,
}

impl Small100 {
    pub fn load(dir: &Path) -> Result<Self> {
        let runtime = PathBuf::from(
            std::env::var_os("ORT_DYLIB_PATH").context("ORT_DYLIB_PATH is required")?,
        );
        ensure!(runtime.is_file(), "ONNX Runtime library not found");
        let environment = ort::init_from(&runtime)?
            .with_name("profile-i18n")
            .build()?;
        let tokenizer = tokenizers::Tokenizer::from_file(dir.join("tokenizer.json"))
            .map_err(|err| anyhow::anyhow!("SMaLL-100 tokenization: {err}"))?;
        let languages: LanguageTokens =
            serde_json::from_slice(&fs::read(dir.join("lang_tokens.json"))?)?;
        Ok(Self {
            tokenizer,
            languages: languages.lang_to_id,
            encoder: Session::builder(&environment)?
                .commit_from_file(dir.join("encoder_model.onnx"))?,
            decoder: Session::builder(&environment)?
                .commit_from_file(dir.join("decoder_model_merged.onnx"))?,
        })
    }

    pub fn translate(&mut self, request: &Request) -> Result<String> {
        let target = *self
            .languages
            .get(&request.target)
            .with_context(|| format!("Unsupported SMaLL-100 locale: {}", request.target))?;
        ensure!(
            request.max_new_tokens > 0 && request.max_new_tokens < MAX_POSITIONS,
            "invalid output token budget"
        );
        ensure!(
            request.repetition_penalty.is_finite() && request.repetition_penalty > 0.0,
            "invalid repetition penalty"
        );
        let encoded = self
            .tokenizer
            .encode(request.text.as_str(), true)
            .map_err(|err| anyhow::anyhow!("SMaLL-100 tokenization: {err}"))?;
        let mut ids = vec![target];
        ids.extend(encoded.get_ids().iter().copied().map(i64::from));
        ensure!(
            ids.len() <= MAX_POSITIONS,
            "SMaLL-100 input exceeds model capacity"
        );
        let len = ids.len();
        let mask = Tensor::<i64>::from_array(([1, len], vec![1_i64; len]))?;
        let output = self.encoder.run(ort::inputs![
            "input_ids" => Tensor::from_array(([1, len], ids))?,
            "attention_mask" => mask.view()
        ])?;
        let hidden = output
            .into_iter()
            .find(|(name, _)| *name == "last_hidden_state")
            .map(|(_, value)| value)
            .context("SMaLL-100 encoder returned no hidden state")?;
        let empty = Tensor::<f32>::from_array(([1, 16, 1, 64], vec![0.0_f32; 16 * 64]))?;
        let mut cache: BTreeMap<String, DynValue> = BTreeMap::new();
        let mut generated = vec![EOS];
        for step in 0..request.max_new_tokens {
            let current = *generated.last().context("missing decoder input")?;
            let input = Tensor::<i64>::from_array(([1, 1], vec![current]))?;
            let use_cache = Tensor::<bool>::from_array(([1], vec![step > 0]))?;
            let mut feed: Vec<(String, SessionInputValue<'_>)> = Vec::new();
            for spec in self.decoder.inputs() {
                let value: SessionInputValue<'_> = match spec.name() {
                    "input_ids" | "decoder_input_ids" => (&input).into(),
                    "encoder_attention_mask" | "attention_mask" => (&mask).into(),
                    "encoder_hidden_states" => (&hidden).into(),
                    "use_cache_branch" => (&use_cache).into(),
                    name if step == 0 && name.starts_with("past_key_values.") => (&empty).into(),
                    name => cache
                        .get(name)
                        .with_context(|| format!("missing decoder state: {name}"))?
                        .into(),
                };
                feed.push((spec.name().to_owned(), value));
            }
            let output = self.decoder.run(feed)?;
            let logits = output
                .get("logits")
                .context("SMaLL-100 decoder returned no logits")?;
            let (shape, values) = logits.try_extract_tensor::<f32>()?;
            let width = usize::try_from(*shape.last().context("missing vocabulary dimension")?)?;
            ensure!(width > 0 && width <= values.len(), "invalid logits shape");
            let next = next_token(&values[values.len() - width..], &generated, request)?;
            if next == EOS {
                break;
            }
            generated.push(next);
            for (name, value) in output {
                if let Some(suffix) = name.strip_prefix("present.")
                    && (step == 0 || !suffix.contains(".encoder."))
                {
                    cache.insert(format!("past_key_values.{suffix}"), value);
                }
            }
        }
        let tokens = generated[1..]
            .iter()
            .map(|&id| u32::try_from(id))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        self.tokenizer
            .decode(&tokens, true)
            .map_err(|err| anyhow::anyhow!("SMaLL-100 decoding: {err}"))
    }
}

fn next_token(values: &[f32], generated: &[i64], request: &Request) -> Result<i64> {
    let repeated: BTreeSet<i64> = generated.iter().copied().collect();
    let n = request.no_repeat_ngram_size;
    let banned: BTreeSet<i64> = if n > 0 && generated.len() >= n - 1 {
        let prefix = &generated[generated.len() - (n - 1)..];
        generated
            .windows(n)
            .filter(|window| &window[..n - 1] == prefix)
            .map(|window| window[n - 1])
            .collect()
    } else {
        BTreeSet::new()
    };
    let mut best: Option<(i64, f32)> = None;
    for (index, &value) in values.iter().enumerate() {
        let id = i64::try_from(index)?;
        if !value.is_finite() || banned.contains(&id) {
            continue;
        }
        let score = if repeated.contains(&id) {
            if value < 0.0 {
                value * request.repetition_penalty
            } else {
                value / request.repetition_penalty
            }
        } else {
            value
        };
        if best.is_none_or(|(_, previous)| score > previous) {
            best = Some((id, score));
        }
    }
    best.map(|(id, _)| id)
        .context("SMaLL-100 decoder returned no available token")
}
