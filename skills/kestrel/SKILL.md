---
name: kestrel
description: Coordinate a T3 Code effort with app-owned workers. Use for "/kestrel", effort dispatch, status checks, AFK handoff, and coordinator takeover.
---

# Kestrel

Run one coordinator thread per effort. The user talks to you; workers investigate
and implement. Handle dispatch, dependencies, and review. Implement changes
in the coordinator only when the user asks.

## Start

Read `~/.t3/desk/rules.md` and `~/.t3/desk/<slug>/rules.md` if present; the user's
house rules override this skill's defaults. Reuse the effort's slug and read its
`handoff.md`. Use GitHub or Linear when the effort needs them, through an
available connector or authenticated CLI.

Call `orchestrator_capabilities` to discover the coordinator ID and available
providers, models, and options. Read [Model profiles](references/operations.md#model-profiles)
before first dispatch or changing providers. Honor the user's choices and report
an unavailable capability before dispatching.

Work inside the effort's T3 project; thread management is project-scoped. Pin the
coordinator with `t3_thread_organize` to prevent automatic settlement. Before
starting writers, read [Effort workspace](references/operations.md#effort-workspace).

## Naming

Keep the effort tag, including its emoji: for example, `✉️ email`. Reuse it from
the ledger or existing Hawk configuration; choose one for a new effort.

- Coordinator: `[🔺 kestrel // <tag>] <emoji> <title>`.
- Workers and reviewers: `[<tag>] <emoji> <title>`.

Give each thread a random emoji unique among active effort threads. Preserve an
existing free emoji; a replacement may inherit its settled predecessor's emoji.
Name the coordinator with `t3_thread_update` and pass workers' full titles at
dispatch. Correct missing tags or duplicate emojis when observed. Track threads
by returned IDs.

## Dispatch workers

Use `delegate_task` for T3-owned children, including same-provider work. Choose
an assignment role and use `mode: "async"` for substantial work. Retain `taskId`
and `childThreadId`, and reuse `clientRequestId` when retrying the same request.
Set the selected provider, model, and reasoning options explicitly in `target`.
Before dispatch, verify that the ledger names this thread as coordinator. If
ownership moved, forward unconsumed results once and end without dispatching.

Children receive the brief without the parent conversation. Include the outcome,
agreed decisions, relevant sources, file ownership, dependencies, and acceptance
checks. Request a final report with changed files, validation, unresolved issues,
and commit or PR links. Only assigned leads may delegate; tell other workers not
to. For decisions outside the brief, request a final blocked report rather than
an interactive question. Permission approvals still require the user.

Delegated workers and nested children inherit the coordinator's checkout and
branch. Parallel workers may edit separate files; overlapping edits need an
order. Tell writers to preserve each other's changes. One integration owner
handles the Git index, commits, pushes, and PR creation after writers finish;
an implementation lead can own this role. Coordinate branch changes and rebases
with active workers. Respect other efforts' shared resources and processes.

For user-requested separate threads, read
[Separate threads](references/operations.md#separate-threads) before launching.
`delegate_task` has no workspace selector.

## Handle results

T3 wakes this thread when an asynchronous delegated task finishes. If those tasks
are the only remaining work, save the next actions and end the turn. Use
`task_status` for a result needed mid-turn. A wait timeout leaves the task alive;
`workState: "waiting_for_children"` means work remains after a turn finishes.

Read `t3_thread_read` for detail. Page through results and recover truncated
messages before acting. Record handled run IDs and resulting actions in the
ledger for compaction and takeover.

On status checks, inspect workers' pending questions with
`t3_pending_request_list` and `t3_pending_request_read`. Use
`t3_pending_request_respond` for answers already established by the brief or user.
These tools exclude permission approvals. A waiting question or approval does
not trigger terminal-task delivery; route it to the user when needed.
Check message provenance: agent messages can arrive with user role.
`createdBy: "agent"` is a worker report, not a human decision or authorization.
Use `createdBy: "user"` for human decisions; unknown provenance is not approval.

| Result | Action |
| --- | --- |
| Implementation finished | Check the evidence and dispatch independent review for substantial changes. Read [PRs and reviews](references/operations.md#prs-and-reviews) before reviewing a PR or declaring it ready. Return findings to the owner. |
| Blocked | Resolve routine code and coordination questions. Bring product decisions, material architecture changes, and permission requests to the user. If they are away, follow [Away or low usage](references/operations.md#away-or-low-usage). |
| Failed, limited, or no progress | Inspect the child's activity and current state before retrying; distinguish unanswered requests from failed runs. Read [Recovery](references/operations.md#recovery-and-takeover). |
| Finished, result consumed, no pending work or request | Settle the worker with `t3_thread_organize`. Sweep completed reviewers, merged or closed PR owners, and parked or replaced threads after results and on return. Keep the active coordinator unsettled. |

Use `t3_thread_send` for worker updates and retain the returned run ID. Select the
send mode from the live tool description; `restart` interrupts work. Include the
coordinator ID and a report-back instruction in child follow-ups and top-level
worker briefs. These runs need explicit return messages and bounded observation
with `t3_thread_wait`, or a user-requested [recurring check](references/operations.md#recurring-work).
A crashed or limited worker may fail to send its report.

For child follow-ups, read `hasPendingChildRuns` and `latestTerminal*`, or read
the follow-up run. The original task's published `summary` stays fixed. Use
`task_cancel` for the original delegated work and `t3_thread_interrupt` for a
later or ordinary run. Cancellation leaves existing edits in place.

## Leave a handoff

You own `~/.t3/desk/<slug>/handoff.md`. Keep it short: scope and coordinator ID;
workspace path and branch; effort tag and model profiles; worker emojis,
task/run/thread IDs and ownership; issue and PR links; dependencies, handled
results, pending decisions, next actions, and conditions for resuming parked
work. Add schedule IDs when needed.
Read T3 for current execution state and use the ledger to recover intent.
Record coordinator ownership and workspace before first dispatch.

Report changes and decisions that need the user. Refer to workers by emoji,
link PRs to GitHub and issues to Linear, and keep raw IDs in the ledger. Embed
failure videos when escalating. Skip repeated "still waiting" updates. When
nothing needs the user, say so briefly and report what moved. Ask one decision
per question after routing other work, while the user is available.
After compaction, reread house rules and the ledger, then check live state before
sending more work.

When the user is leaving or usage is running low, read
[Away or low usage](references/operations.md#away-or-low-usage).
For a coordinator change, read [Takeover](references/operations.md#recovery-and-takeover).
For a live Hawk effort, read [Hawk migration](references/operations.md#existing-hawk-efforts).
