---
name: stacked-prs
description: Discover a linear GitHub stacked-PR chain and keep a marked stack summary synchronized across every PR description. Use when creating, documenting, refreshing, or babysitting stacked pull requests.
---

# Stacked PRs

Make every PR in a stack answer three questions at a glance:

1. What does the stack accomplish overall?
2. Which row is this PR, and what does it contribute?
3. Which PRs make up the stack, in merge order?

The bundled harness discovers the chain from GitHub branch relationships, asks
`gpt-5.6-luna` at high reasoning effort on Fast mode for concise summaries, and
renders the same stack table into each PR body, highlighting the current row.
It preserves all text outside:

```html
<!-- stacked-prs:start -->
<!-- stacked-prs:end -->
```

## Run it

Pass a PR URL, number, or repository slug:

```bash
node ~/.agents/skills/stacked-prs/scripts/stacked_prs.mjs https://github.com/OWNER/REPO/pull/123
node ~/.agents/skills/stacked-prs/scripts/stacked_prs.mjs OWNER/REPO
```

The default is a preview. Inspect every rendered block, especially merge order
and summaries. When the preview is accurate and the user has asked to maintain
the GitHub descriptions, rerun with `--write`:

```bash
node ~/.agents/skills/stacked-prs/scripts/stacked_prs.mjs https://github.com/OWNER/REPO/pull/123 --write
```

For `OWNER/REPO`, the harness resolves the PR associated with the current local
branch. For a bare PR number, it resolves the repository from the current
checkout. It requires `gh` and `codex` on `PATH`, authenticated for the target
repository. Use `--repo OWNER/REPO` with a bare number when repository inference
is undesirable.

## Stack identity

GitHub has no first-class stack object. The harness treats open PR branch
relationships as the source of truth:

- a PR whose head branch is another PR's base branch comes earlier;
- a PR based on another PR's head branch comes later;
- traversal stops where no matching open PR exists.

The chain must be linear. If one head branch has multiple child PRs, the harness
stops and reports the ambiguity instead of inventing an order. Before writing,
check that each adjacent row's base branch equals the preceding row's head
branch. Branch retargeting and merged or closed PRs can change the discovered
chain, so rerun after either event.

## Summary contract

Luna receives the title, existing unmarked description, branches, commit
subjects, file paths, and change counts for the entire chain. Its structured
response contains:

- one sentence for the stack's shared outcome;
- one short, parallel-phrased sentence per PR, describing only that PR's
  incremental contribution.

Treat generated summaries as proposed documentation, not evidence about code.
Correct any material mismatch before `--write`. To revise summaries without
another model call, save the preview's `summary_model` JSON and pass it with
`--summaries FILE`.

## Marker safety

The managed region is append-only on first run and replacement-only afterward.
The harness refuses malformed, nested, or duplicate markers. Repair such a body
deliberately, then rerun. A write updates PRs sequentially; if GitHub rejects an
update, it reports the PRs already changed and stops. Rerunning is safe because
the marked region is idempotent.

For deterministic local behavior and the example data model, see
[`references/mock-stack.json`](references/mock-stack.json) and run:

```bash
node --test ~/.agents/skills/stacked-prs/scripts/stacked_prs.test.mjs
```
