---
name: github-pr-fastpath
description: Parse a GitHub pull-request URL into its exact repository and number, then inspect that PR directly with gh without searching for or rediscovering it.
---

# GitHub PR Fast Path

Use this skill as soon as the user provides a GitHub pull-request link and asks to inspect, review, summarize, debug, or decompose it.

## Resolve the target immediately

Parse the URL before using any tool. For a link such as:

```text
https://github.com/OWNER/REPO/pull/123/files
```

extract:

```text
host: github.com
repo: OWNER/REPO
number: 123
target: OWNER/REPO#123
```

Ignore a trailing PR subpage (`files`, `commits`, `checks`, and similar), query string, fragment, or trailing slash. Accept GitHub Enterprise links too; retain the host for `gh --repo` when it is not `github.com`.

State the resolved target in the first progress update. For multiple links, resolve every target independently before fetching any of them.

## Use gh as the first lookup

Run a direct lookup against the parsed repository and number:

```bash
gh pr view NUMBER --repo OWNER/REPO --json number,title,state,author,body,baseRefName,headRefName,isDraft,mergeable,reviewDecision,statusCheckRollup,changedFiles,additions,deletions,commits,files,reviews,comments,url
```

For an Enterprise host, pass `HOST/OWNER/REPO` to `--repo`. Use the parsed number, not the raw URL, in the command. Quote shell arguments.

Do not begin with any of these discovery steps:

- `gh pr list`
- `gh search prs`
- `gh repo view` to find the repository
- web search, browser navigation, or GitHub search
- asking the user to repeat the repository or PR number already present in the link

If the direct lookup fails, report the exact parsed target and the `gh` error. Check only the relevant local cause, such as `gh auth status` or repository access. Do not silently fall back to search.

## Gather only the evidence needed

After the metadata lookup, continue with the user's requested work. Use direct commands when more evidence is needed:

```bash
gh pr diff NUMBER --repo OWNER/REPO
gh pr checks NUMBER --repo OWNER/REPO
gh api --paginate repos/OWNER/REPO/pulls/NUMBER/files
```

Use the diff for code or change analysis, checks for CI status, and the API file list only when per-file details are needed. Do not check out the PR or mutate the worktree unless the user asks for that.

For a review or decomposition, connect the result to the exact PR target and cover the relevant metadata, changed files, behavior, risks, tests, and unresolved questions. The skill accelerates identification; it does not replace the user's requested analysis.
