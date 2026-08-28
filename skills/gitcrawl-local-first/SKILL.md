---
name: gitcrawl-local-first
description: Use Gitcrawl as the local-first read path for GitHub issues, pull requests, comments, reviews, changed-file metadata, checks, and workflow runs. Use for GitHub discovery or repeated metadata reads when a local SQLite mirror can avoid live requests; use live GitHub for exact current state before writes or when the archive cannot answer.
---

# GitHub, local first

Treat Gitcrawl's SQLite archive as the normal GitHub read model. Pay network
latency only when freshness or a missing surface requires it.

## Contract

1. Resolve the repository locally and inspect the archive before using `gh`,
   REST, GraphQL, or web search for discovery.
2. Refresh only the data domain and thread numbers the task needs.
3. Treat Gitcrawl maintainer actions such as `close-thread`, `close-cluster`,
   exclusions, and canonical-member choices as local-only state.
4. Use read-only SQLite only when the CLI cannot express a precise archive
   query. Never mutate Gitcrawl's database directly.
5. Immediately before a GitHub write, verify the minimum relevant state live,
   write with `gh`, then targeted-sync the affected thread.

If `gitcrawl` is missing, see [Failure handling](#failure-handling). Do not let
the preference for local reads block the user's task when the archive cannot
answer it.

## Resolve the repository

Prefer an explicit `owner/repo`. In a Git checkout, resolve `origin` without a
network request:

```bash
repo="$(~/.agents/skills/gitcrawl-local-first/scripts/resolve-repo.sh)"
```

The helper also honors `GITHUB_REPOSITORY`.

## Freshness budgets

Freshness is per domain. These are defaults; the user's requirement wins, and
the task may justify a tighter or looser budget.

| Domain | Default maximum age | Refresh |
| --- | ---: | --- |
| Thread metadata | 5m | bounded metadata sync |
| Comments and reviews | 2m | exact thread with `--include-comments` |
| Checks and workflow runs | 60s | exact PR with `--with pr-details` |

A freshness budget is the maximum acceptable age, not a polling interval. If
the archive does not expose a reliable age and freshness affects the answer,
perform the smallest targeted refresh.

`--sync-if-stale` establishes bounded freshness for broad thread metadata. It
does not establish fresh discussion, files, checks, or workflow runs.

## Read workflow

Check whether the archive exists before assuming it is empty:

```bash
gitcrawl doctor --json
gitcrawl status --json
```

For a repository that has never been mirrored, prefer a bounded first sync:

```bash
gitcrawl sync "$repo" --state open --include-comments --json
```

Use `--state all` only when historical or closed-thread coverage is needed.
Do not deep-hydrate PR details across an entire repository by default.

### Local discovery

```bash
gitcrawl search "$repo" \
  --query "cache invalidation" \
  --scope threads \
  --mode keyword \
  --json

gitcrawl search prs "cache invalidation" \
  -R "$repo" \
  --state open \
  --sync-if-stale 5m \
  --json number,title,state,url,updatedAt,isDraft,author

gitcrawl threads "$repo" --numbers 123 --include-closed --json
```

Use hybrid search only when semantic vectors already exist or semantic recall
would materially help. Do not start embedding work for a simple metadata query.

### Exact thread hydration

Hydrate discussion only:

```bash
gitcrawl sync "$repo" --numbers 123 --include-comments --json
```

Hydrate PR files, commits, checks, workflow runs, and review-thread state only:

```bash
gitcrawl sync "$repo" --numbers 123 --with pr-details --json
```

Hydrate both domains:

```bash
gitcrawl sync "$repo" \
  --numbers 123 \
  --include-comments \
  --with pr-details \
  --json
```

For a shortlist, pass comma-separated numbers rather than widening to a full
repository refresh.

The bundled helpers perform the two common deep refreshes:

```bash
~/.agents/skills/gitcrawl-local-first/scripts/refresh-ci.sh 123 "$repo"
~/.agents/skills/gitcrawl-local-first/scripts/refresh-thread.sh 123 "$repo"
```

### Coverage and exact local queries

When missing data could change the answer:

```bash
gitcrawl coverage "$repo" --json
```

If a hydrated field is not exposed by the CLI, discover the database and
inspect its current schema before issuing read-only SQL:

```bash
db="$(gitcrawl doctor --json | jq -r '.db_path // .database.path // empty')"
sqlite3 -readonly "$db" '.tables'
sqlite3 -readonly "$db" '.schema comments'
```

Report material coverage gaps instead of silently treating absent data as
negative evidence.

## GitHub mutations

Reason locally, verify the smallest relevant live state, mutate, then restore
the archive as the read path:

```bash
gitcrawl threads "$repo" --numbers 123 --include-closed --json

gh pr view 123 -R "$repo" --json number,state,isDraft,headRefOid
gh pr comment 123 -R "$repo" --body-file /tmp/comment.md

gitcrawl sync "$repo" \
  --numbers 123 \
  --include-comments \
  --with pr-details \
  --json
```

Cached state is evidence for reasoning, not sufficient live verification for a
write.

## Failure handling

If Gitcrawl is unavailable, recommend or, when authorized, install it:

```bash
brew install openclaw/tap/gitcrawl
gitcrawl init
gitcrawl doctor
```

Sync uses `GITHUB_TOKEN` or an authenticated `gh` token. Diagnose local config
or lock problems with:

```bash
gitcrawl doctor --locks --json
```

If repair or targeted sync cannot supply the requested field, use the narrowest
live GitHub read that finishes the task. State what was stale or unavailable
when that distinction affects the conclusion.
