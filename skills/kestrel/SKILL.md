---
name: kestrel
description: Coordinate a T3 Code effort with app-owned workers. Use for "/kestrel", effort dispatch or status checks, and coordinator takeover.
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
providers, models, and options. Honor the user's model choices. If T3 tools are
absent from discovery, make one direct capability call through the environment's
supported T3 transport. Report an unavailable capability before dispatching.

Work inside the effort's T3 project; thread management is project-scoped. Pin the
coordinator with `t3_thread_organize` to prevent automatic settlement. Name it
`[kestrel // <effort>] <emoji> <title>` and workers `[<effort>] <emoji> <title>`.
Give active workers distinct emojis and rename through `t3_thread_update`.
Use returned IDs to track threads.

## Dispatch workers

Use `delegate_task` for T3-owned children, including same-provider work. Choose
an assignment role and use `mode: "async"` for substantial work. Retain `taskId`
and `childThreadId`, and reuse `clientRequestId` when retrying the same request.

Children receive the brief without the parent conversation. Include the outcome,
agreed decisions, relevant sources, file ownership, dependencies, and acceptance
checks. Request a final report with changed files, validation, unresolved issues,
and commit or PR links. Assign a lead worker before allowing nested delegation.

Establish the effort branch before starting writers. Parallel workers may edit
separate files; overlapping edits need an order. Tell writers to preserve each
other's changes. In a shared checkout, one integration worker owns the Git index,
commits, pushes, and PR creation after writers finish. Coordinate branch changes
and rebases with active workers.

For user-requested separate threads, read
[Separate threads](references/operations.md#separate-threads) before launching.
`delegate_task` has no workspace selector.

## Handle results

T3 wakes this thread when an asynchronous delegated task finishes. If those tasks
are the only remaining work, save the next actions and end the turn. Use
`task_status` for a result needed mid-turn. A wait timeout leaves the task alive;
`workState: "waiting_for_children"` means work remains after a turn finishes.

Read `t3_thread_read` for detail. Page through results and recover truncated
messages before acting. Record handled run IDs in the ledger to avoid duplicate
reviews or follow-ups.

| Result | Action |
| --- | --- |
| Implementation finished | Check the evidence and dispatch independent review for substantial changes. Read [PRs and reviews](references/operations.md#prs-and-reviews) before reviewing a PR or declaring it ready. Return findings to the owner. |
| Blocked | Resolve routine code and coordination questions. Bring product decisions, material architecture changes, and permission requests to the user. Record decisions for their return if they are away. |
| Failed, limited, or no progress | Inspect the child's activity and current state before retrying; distinguish unanswered requests from failed runs. Read [Recovery](references/operations.md#recovery-and-takeover). |
| Finished, result consumed, no pending work or request | Settle the worker with `t3_thread_organize`. Keep the active coordinator unsettled. |

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
worker/task/run IDs and ownership; issue and PR links; dependencies, handled
results, pending decisions, and next actions. Add schedule IDs when needed.
Read T3 for current execution state and use the ledger to recover intent.

Report changes and decisions that need the user. Refer to workers by emoji,
link PRs to GitHub and issues to Linear, and keep raw IDs in the ledger.
After compaction, reread house rules and the ledger, then check live state before
sending more work.

For a coordinator change, read [Takeover](references/operations.md#recovery-and-takeover).
For a live Hawk effort, read [Hawk migration](references/operations.md#existing-hawk-efforts).
