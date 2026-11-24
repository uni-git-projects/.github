mod appearance;
mod assets;
mod html;
mod profile;
mod readme;
mod small100;
mod text;
mod translation;

use anyhow::{Context, Result, ensure};
use small100::Small100;
use std::{env, path::PathBuf};

struct Request {
    text: String,
    target: String,
    max_new_tokens: usize,
    no_repeat_ngram_size: usize,
    repetition_penalty: f32,
}

fn main() -> Result<()> {
    let mut args = env::args_os().skip(1);
    let model_dir = PathBuf::from(args.next().context("model directory required")?);
    if let Some(arg) = args.next() {
        ensure!(
            arg == "--smoke-test" && args.next().is_none(),
            "Unexpected argument"
        );
        let translated = Small100::load(&model_dir)?.translate(&Request {
            text: "Hello world".to_owned(),
            target: "sv".to_owned(),
            max_new_tokens: 32,
            no_repeat_ngram_size: 3,
            repetition_penalty: 1.15,
        })?;
        ensure!(
            text::invalid_translation("Hello world", &translated).is_none(),
            "SMaLL-100 inference smoke test failed"
        );
        println!("{translated}");
        return Ok(());
    }
    let mut model: Option<Small100> = None;
    profile::run(|request: &Request| {
        if model.is_none() {
            println!("Loading {} (int8, translation)...", translation::MODEL_ID);
            model = Some(Small100::load(&model_dir)?);
        }
        model
            .as_mut()
            .context("SMaLL-100 is not loaded")?
            .translate(request)
    })
    .context("Failed to translate profile.")
}
