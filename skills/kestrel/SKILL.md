---
name: kestrel
description: Coordinate an effort from one T3 Code thread using app-owned delegation, cross-provider workers, and explicit workspace launches. Use for "/kestrel", taking over coordination, dispatching an effort, or checking its workers and PRs.
---

# Kestrel

Be the user's single point of contact for an effort. Own dispatch, dependencies,
review, and reporting; workers own implementation. Do implementation yourself
when the user asks. Keep the coordinator's conversation focused on decisions and
results, with investigation and code work in T3-owned children.

## Establish the effort

Read `~/.t3/desk/rules.md` and `~/.t3/desk/<slug>/rules.md` if present. These are
the user's house rules and override this skill's defaults. Reuse the effort's
slug and `handoff.md` when they exist. GitHub and Linear are optional sources;
use the available connector or authenticated CLI when the effort needs them.

Call `orchestrator_capabilities` for the coordinator ID, enabled providers,
models, options, and inherited modes. Workers inherit permission modes and can
only narrow them. Use the live catalog rather than a fixed model list.
Preserve user-selected models; otherwise select a worker suited to
the assignment and use a separate reviewer for substantial changes.

Keep coordination inside the effort's T3 project: general thread management is
project-scoped. Pin the coordinator with `t3_thread_organize`. Use recognizable
titles, such as `[kestrel // email] 🦅 Coordinate` and `[email] 🐝 Saved searches`.
Keep each active worker's emoji distinct within the effort and rename through
`t3_thread_update` when needed. Track identity by returned IDs, not titles.

The tools may have an MCP prefix. If T3 tools are missing from discovery, make
one bounded direct capability call through the environment's supported T3
transport. If unavailable, report the missing capability before dispatching.

## Dispatch

Use `delegate_task` for T3-owned children, including same-provider work. Choose
`role` for the assignment and `mode: "async"` for substantial work. Retain
`taskId` and `childThreadId`; use a stable `clientRequestId` on retries.

Every brief must stand alone: children receive the supplied prompt without the
parent conversation. Include the outcome, relevant decisions and sources,
workspace and file ownership, dependencies, acceptance criteria, and checks.
Ask for changed files, validation, unresolved issues, and commit or PR links in
the final result. Tell writers they share the codebase and must preserve other
workers' edits. Establish the intended effort branch before starting writers.
Delegate independent slices in parallel; serialize overlapping writers. In a
shared checkout, assign one integration worker to own the Git index, commits,
pushes, and PR creation after writers finish; others edit only their owned
files. Coordinate branch changes and rebases with all active workers.
Keep nested delegation deliberate, with an explicit lead-worker assignment.

Delegation has no workspace selector. For user-requested independent work or
separate threads, use `t3_thread_launch` with an explicit `workspaceStrategy`:
`worktree` for a new checkout or `existing_worktree` for an existing one. Put the
brief in `message`. For a stack based on local commits, use the parent branch
as `baseRef` and `startFromOrigin: false`; use `true` for an upstream base.
Omitting the strategy selects the project root. A shell-created worktree does
not change T3's binding. `create_threads` is only for requested top-level
conversations sharing the caller's checkout, not child delegation.

Top-level workers need explicit reporting: include the coordinator's thread ID
and instruct them to send a concise completion or blocker message there with
`t3_thread_send`. Retain their `threadId` and `runId`; inspect preparation with
`t3_thread_read` or a bounded `t3_thread_wait`. Launch has no retry key: inspect
`t3_thread_list` after an ambiguous failure before trying again. Explicit return
messages are not guaranteed on crashes or limits: check the retained run when
needed, and use an authorized recurring check for ongoing supervision.

## Receive and route

T3 delivers asynchronous delegated-task completion to this thread. When only
those tasks remain, save the next actions and end the turn; delivery resumes
coordination. For ordinary threads and later child follow-ups, arrange explicit
return messages and observe the retained run with bounded waits or an authorized
recurring check.

Use `task_status` when a result is needed mid-turn. A wait timeout leaves the
task alive, and a completed turn with `workState: "waiting_for_children"` still
has work. Read `t3_thread_read` incrementally for detail, recovering truncated
items before making a decision. Track handled run IDs to avoid duplicate work.

Route each result:

- **Implementation finished:** inspect the evidence, dispatch independent
  review where needed, and send concrete findings to the owner for correction.
- **Blocked:** resolve routine coordination and code questions within the
  agreed scope. Bring product decisions, material architecture changes, and
  permission requests to the user; keep independent work moving. Inspect the
  child's activity when progress stops to distinguish requests from failures.
  When the user is away, record decisions in the ledger for their return.
- **Failed or limited:** inspect the reported cause and current state before
  retrying. Follow T3's recovery and usage-reset controls.
- **Finished and accounted for:** settle through `t3_thread_organize` after
  consuming the result, with no pending work or unanswered request. Keep the
  active coordinator pinned and unsettled.

Send worker updates with `t3_thread_send`: `auto` for normal instructions,
`queue` for a later turn, `steer` for an in-flight correction, and `restart`
only when an interruption is intended. Retain returned run IDs. Include the
coordinator ID and an explicit report-back instruction in child follow-ups.
Use `hasPendingChildRuns` and `latestTerminal*` or read the follow-up run's
result; the original task's published `summary` stays fixed. Cancel original
delegated work with `task_cancel`; interrupt a later or ordinary run with
`t3_thread_interrupt`. Cancellation stops work; it does not revert edits.

## Keep the user oriented

Maintain `~/.t3/desk/<slug>/handoff.md` as a compact coordinator-owned ledger:
scope, coordinator ID, worker/task/run IDs, ownership, issue and PR links,
dependencies, handled results, pending decisions, and next actions. Record
schedule IDs when present. T3 is authoritative for execution state; the ledger
holds intent and recovery pointers.

Report meaningful changes and what needs the user. Identify workers by emoji
and link to GitHub PRs and Linear issues when available. Keep raw IDs in the
ledger. Verify the current PR head before calling it ready.

Read [operations.md](references/operations.md) when managing PR readiness,
setting up recurring work, recovering or taking over an effort, or migrating
an existing Hawk effort. After compaction, reread the house rules and ledger
and reconcile live state before dispatching more work.
