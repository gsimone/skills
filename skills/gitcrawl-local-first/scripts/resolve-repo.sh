#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${GITHUB_REPOSITORY:-}" ]]; then
  printf '%s\n' "$GITHUB_REPOSITORY"
  exit 0
fi

url="$(git remote get-url origin 2>/dev/null || true)"
if [[ -z "$url" ]]; then
  echo "Could not resolve GitHub repository: no origin remote" >&2
  exit 1
fi

case "$url" in
  git@github.com:*) path="${url#git@github.com:}" ;;
  ssh://git@github.com/*) path="${url#ssh://git@github.com/}" ;;
  https://github.com/*) path="${url#https://github.com/}" ;;
  http://github.com/*) path="${url#http://github.com/}" ;;
  *)
    echo "Could not resolve GitHub owner/repo from origin: $url" >&2
    exit 1
    ;;
esac

path="${path%.git}"
path="${path%/}"

if [[ "$path" != */* ]]; then
  echo "Resolved origin is not owner/repo: $path" >&2
  exit 1
fi

printf '%s\n' "$path"
