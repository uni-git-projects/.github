#!/usr/bin/env bash
set -euo pipefail

src_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
repo="${1:-profile-icons/github-profile-site}"
src_sha="${2:-$(git -C "$src_dir" rev-parse HEAD)}"

if [[ ! "$src_sha" =~ ^[0-9a-f]{40}$ || ! "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  printf '%s\n' '::error::Expected a GitHub repository and a full source commit SHA.' >&2
  exit 1
fi

case "$(uname -s)/$(uname -m)" in
  Linux/x86_64)
    platform="linux-x64"
    ;;
  Linux/aarch64)
    platform="linux-arm64"
    ;;
  *)
    printf '%s\n' '::error::Prebuilt localization supports Linux x64 and ARM64 only.' >&2
    exit 1
    ;;
esac

asset="gh-profile-i18n-$platform.tar.gz"
tag="binary-$src_sha"
url="https://github.com/$repo/releases/download/$tag"
bin_dir="$src_dir/.cache/i18n"
tmp_dir="$(mktemp -d)"

trap 'rm -rf -- "$tmp_dir"' EXIT

mkdir -p "$tmp_dir/extract"

for file in "$asset.sha256" "$asset"; do
  if ! curl --fail --location --retry 3 \
    --proto '=https' --proto-redir '=https' --tlsv1.2 \
    "$url/$file" \
    --output "$tmp_dir/$file"; then
    printf '::error::Missing %s in %s. Publish %s or build locally with scripts/build-i18n.sh.\n' \
      "$file" "$repo" "$tag" >&2
    exit 1
  fi
done

(
  cd "$tmp_dir"

  sha256sum --check --strict "$asset.sha256"
)

tar --extract --gzip --no-same-owner --no-same-permissions \
  --file "$tmp_dir/$asset" \
  --directory "$tmp_dir/extract" \
  gh-profile-i18n run-i18n SOURCE_COMMIT lib model-cache

extracted="$tmp_dir/extract"

for file in \
  gh-profile-i18n \
  run-i18n \
  SOURCE_COMMIT \
  lib/libonnxruntime.so.1.31.1 \
  lib/libonnxruntime_providers_shared.so \
  model-cache/small100/a0d8498/tokenizer.json \
  model-cache/small100/a0d8498/lang_tokens.json \
  model-cache/small100/a0d8498/encoder_model.onnx \
  model-cache/small100/a0d8498/decoder_model_merged.onnx; do
  if [[ -L "$extracted/$file" || ! -s "$extracted/$file" ]]; then
    printf '::error::Localization bundle is missing required file: %s\n' "$file" >&2
    exit 1
  fi
done

if [[ "$(cat "$extracted/SOURCE_COMMIT")" != "$src_sha" ]]; then
  printf '%s\n' '::error::Localization bundle does not match the source commit.' >&2
  exit 1
fi

mkdir -p "$bin_dir"

install -m 755 "$extracted/gh-profile-i18n" "$bin_dir/gh-profile-i18n"
install -m 755 "$extracted/run-i18n" "$bin_dir/run-i18n"
install -m 644 "$extracted/SOURCE_COMMIT" "$bin_dir/SOURCE_COMMIT"

rm -rf -- "$bin_dir/lib" "$bin_dir/model-cache"
mv -- "$extracted/lib" "$extracted/model-cache" "$bin_dir/"

if [[ -n "${GITHUB_ENV:-}" ]]; then
  printf 'I18N_BIN=%s\n' "$bin_dir/run-i18n" >> "$GITHUB_ENV"
fi

printf 'Ready: %s (%s)\n' "$tag" "$platform"
