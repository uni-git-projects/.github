#!/usr/bin/env bash
set -euo pipefail

case "$(uname -s)/$(uname -m)" in
  Linux/x86_64)
    platform="linux-x64"
    ;;
  Linux/aarch64)
    platform="linux-arm64"
    ;;
  *)
    printf '%s\n' 'ONNX Runtime setup supports Linux x64 and ARM64 only.' >&2
    exit 1
    ;;
esac

lib_dir="${1:?ONNX library directory is required}"

mkdir -p "$lib_dir"

if [[ ! -s "$lib_dir/libonnxruntime.so.1.22.0" || ! -s "$lib_dir/libonnxruntime_providers_shared.so" ]]; then
  tmp_dir="$(mktemp -d)"

  trap 'rm -rf -- "$tmp_dir"' EXIT

  curl --fail --location --retry 3 \
    --proto '=https' --proto-redir '=https' --tlsv1.2 \
    'https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/1.31.1/microsoft.ml.onnxruntime.1.31.1.nupkg' \
    --output "$tmp_dir/runtime.nupkg"

  unzip -jo "$tmp_dir/runtime.nupkg" \
    "runtimes/$platform/native/*.so*" \
    -d "$tmp_dir"

  install -m 644 "$tmp_dir/libonnxruntime.so" "$lib_dir/libonnxruntime.so.1.31.1"
  install -m 644 "$tmp_dir/libonnxruntime_providers_shared.so" "$lib_dir/libonnxruntime_providers_shared.so"

  for notice in LICENSE ThirdPartyNotices.txt; do
    if unzip -p "$tmp_dir/runtime.nupkg" "$notice" > "$tmp_dir/$notice" 2>/dev/null; then
      install -m 644 "$tmp_dir/$notice" "$lib_dir/$notice"
    fi
  done
fi
