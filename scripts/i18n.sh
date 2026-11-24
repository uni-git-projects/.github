#!/usr/bin/env bash
set -euo pipefail

bin="${I18N_BIN:-.cache/i18n/run-i18n}"

if [[ "$bin" != /* ]]; then
  bin="$PWD/$bin"
fi

if [[ ! -x "$bin" ]]; then
  printf '%s\n' \
    'Localization binary not found. Run: bash scripts/setup-bin.sh or bash scripts/build-i18n.sh.' >&2
  exit 1
fi

exec "$bin" "$@"
