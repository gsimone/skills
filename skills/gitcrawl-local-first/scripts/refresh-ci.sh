#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 <pr-number> [owner/repo]" >&2
  exit 2
fi

base_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ref="$1"
repo="${2:-}"

if [[ -z "$repo" ]]; then
  repo="$("$base_dir/resolve-repo.sh")"
fi

exec gitcrawl sync "$repo" \
  --numbers "$ref" \
  --with pr-details \
  --json
