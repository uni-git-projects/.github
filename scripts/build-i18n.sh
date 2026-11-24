#!/usr/bin/env bash
set -euo pipefail

src_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
bin_dir="${1:-$src_dir/.cache/i18n}"

mkdir -p "$bin_dir"
bin_dir="$(cd -- "$bin_dir" && pwd)"

model_dir="$bin_dir/model-cache/small100/a0d8498"
model_url='https://huggingface.co/casawolice/small100-onnx/resolve/a0d8498bbf489866eeff5e53b53f6997d2b299db'

if [[ ! -f "$src_dir/i18n/Cargo.lock" ]]; then
  cargo generate-lockfile --manifest-path "$src_dir/i18n/Cargo.toml"
fi

cargo build --locked \
  --manifest-path "$src_dir/i18n/Cargo.toml" \
  --release \
  --target-dir "$src_dir/.cache/i18n-target"

install -m 755 "$src_dir/.cache/i18n-target/release/gh-profile-i18n" "$bin_dir/gh-profile-i18n"
install -m 755 "$src_dir/scripts/run-i18n.sh" "$bin_dir/run-i18n"

bash "$src_dir/scripts/setup-onnx.sh" "$bin_dir/lib"
mkdir -p "$model_dir"

hf_headers=()

if [[ -n "${HF_TOKEN:-}" ]]; then
  hf_headers=(-H "Authorization: Bearer $HF_TOKEN")
fi

for remote in tokenizer.json lang_tokens.json onnx/encoder_model.onnx onnx/decoder_model_merged.onnx; do
  file="$model_dir/${remote##*/}"

  if [[ ! -s "$file" ]]; then
    curl --fail --location --retry 3 \
      --proto '=https' --proto-redir '=https' --tlsv1.2 \
      "${hf_headers[@]}" \
      "$model_url/$remote" \
      --output "$file.part"

    mv -- "$file.part" "$file"
  fi
done

(
  cd "$model_dir"

  sha256sum --check --strict <<'CHECKSUMS'
a130f553106646e56c1908094074f354353c45d86b3e8d222b037784035e6dcd  encoder_model.onnx
f966ce4f1f484c2307dc007ef0beadc3a1651220c1ff9b33ea8dddbce468a4b0  decoder_model_merged.onnx
CHECKSUMS
)

git -C "$src_dir" rev-parse HEAD > "$bin_dir/SOURCE_COMMIT"

"$bin_dir/run-i18n" --smoke-test

printf 'Ready: %s\n' "$bin_dir/run-i18n"
