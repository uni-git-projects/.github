#!/usr/bin/env bash
set -euo pipefail

bin_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

export ORT_DYLIB_PATH="$bin_dir/lib/libonnxruntime.so.1.31.1"

exec "$bin_dir/gh-profile-i18n" \
  "$bin_dir/model-cache/small100/a0d8498" \
  "$@"
