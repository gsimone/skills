---
name: stacked-prs
description: Discover a linear GitHub stacked-PR chain and keep a marked stack summary synchronized across every PR description. Use when creating, documenting, refreshing, or babysitting stacked pull requests.
---

# Stacked PRs

Make every PR in a stack answer three questions at a glance:

1. What does the stack accomplish overall?
2. Which row is this PR, and what does it contribute?
3. Which PRs make up the stack, in merge order?

The bundled harness reads GitHub's native stack membership and order, asks
`gpt-5.6-luna` at high reasoning effort on Fast mode for concise summaries, and
renders the same stack table into each PR body, highlighting the current row. It
preserves all text outside:

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

The default is a preview. Save its summary model, then inspect every rendered
block. When the preview is accurate and the user has asked to maintain the
GitHub descriptions, write that exact saved model:

```bash
node ~/.agents/skills/stacked-prs/scripts/stacked_prs.mjs OWNER/REPO --save-summaries /tmp/stacked-prs.json
node ~/.agents/skills/stacked-prs/scripts/stacked_prs.mjs OWNER/REPO --summaries /tmp/stacked-prs.json --write
```

For `OWNER/REPO`, the harness resolves the PR associated with the current local
branch. For a bare PR number, it resolves the repository from the current
checkout. It requires `gh` and `codex` on `PATH`, authenticated for the target
repository. Use `--repo OWNER/REPO` with a bare number when repository inference
is undesirable.

## Stack identity

GitHub's native stack is the source of truth. The harness queries the Stacks API
through `gh api`, using the selected PR's membership to obtain the complete
bottom-to-top order. Native stacks are strictly linear, and the returned list
can include merged or closed members. A PR that does not belong to a GitHub
stack fails explicitly instead of being grouped by branch topology.

## Summary contract

Luna receives the title, existing unmarked description, branches, commit
subjects, file paths, and change counts for the entire chain. Its structured
response contains:

- one sentence for the stack's shared outcome;
- one short, parallel-phrased sentence per PR, describing only that PR's
  incremental contribution.

Treat generated summaries as proposed documentation, not evidence about code.
Correct any material mismatch in the saved JSON before `--write`. Writes require
`--summaries FILE`, ensuring GitHub receives the same model that was previewed.

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
