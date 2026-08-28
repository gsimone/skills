#!/usr/bin/env bash
set -euo pipefail

base_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="${1:-}"
mode="${2:-open}"

if [[ -z "$repo" ]]; then
  repo="$("$base_dir/resolve-repo.sh")"
fi

if ! command -v gitcrawl >/dev/null 2>&1; then
  echo "gitcrawl is not installed. Install with: brew install openclaw/tap/gitcrawl" >&2
  exit 127
fi

case "$mode" in
  open)
    exec gitcrawl sync "$repo" --state open --include-comments --json
    ;;
  all)
    exec gitcrawl sync "$repo" --state all --include-comments --json
    ;;
  *)
    echo "Usage: $0 [owner/repo] [open|all]" >&2
    exit 2
    ;;
esac
