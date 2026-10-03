# Effort operations

## Model profiles

Use the user's request, then house rules or effort profiles, then the defaults
below. Default workers to Opus and reviewers to Sol. Sol is also available for
workers when requested or selected in the effort profile.

| Profile | Provider and model | Options |
| --- | --- | --- |
| Opus | `claudeAgent`, `claude-opus-5-5` | `effort: "high"` |
| Sol | `codex`, `gpt-6.1-sol` | `reasoningEffort: "high"`, `serviceTier: "default"` |

Validate every choice against `orchestrator_capabilities`. Use a provider with
`canRunChildTask`, and for cross-provider work also `canRunCrossProviderChildTask`.
Use the advertised option IDs; defaults in the catalog may differ from the
coordinator's current settings. If a preferred profile is unavailable, report
it and choose an available equivalent within the user's model constraints.
Record selected profiles in the ledger.

## Effort workspace

Call `t3_worktree_status` before starting writers. Reuse the effort's existing
binding and establish its branch. If the coordinator is at project root, move
it into an effort worktree unless the user chose that shared checkout.

Use `t3_worktree_handoff` as the last action of the turn, with a
`continuationPrompt` containing the remaining setup and dispatch. It moves only
the calling thread and cannot move a thread already attached to a worktree.
Set `baseRef` and `startFromOrigin` deliberately; local stack parents need
`startFromOrigin: false`. Uncommitted edits are not copied to the new worktree.
Children created before a move keep their previous binding. Resolve an existing
workspace mismatch before dispatching writers.

Delegation shares one checkout; it cannot produce several independent branches
at once. Sequence branch work there, or use user-requested separate worktree
threads as described below.

## Separate threads

Launch ordinary top-level conversations only when the user requests separate
threads. Use `t3_thread_launch` with the brief in `message` and an explicit
`workspaceStrategy`: `worktree` for a new checkout, `existing_worktree` for an
existing one. Set the parent branch as `baseRef` and `startFromOrigin: false`
for a stack built on local commits; use `true` for an upstream base.

Without a workspace strategy, launch selects the project root. Creating a
worktree in a shell does not update T3's thread binding. `create_threads` is
for requested top-level conversations sharing the caller's checkout.

Retain `threadId` and `runId`, and check preparation with `t3_thread_read` or
`t3_thread_wait`. Launch has no retry key: inspect `t3_thread_list` after an
ambiguous failure before retrying. Follow the skill's instructions for returning
results from these workers.

## PRs and reviews

Keep one PR per issue and one implementation owner per PR; supporting workers
can own smaller slices. Split work that outgrows its issue. Register PRs with
`link_pull_request` from the owner and coordinator threads, including each stack
layer. Check `list_thread_pull_requests` for missing links before finishing.

Give the reviewer the PR URL and head SHA, the relevant spec, and a review scope.
Request findings with file and line references, evidence, and severity. Keep
reviews read-only unless fixes were assigned, using `interactionMode: "plan"`
when the selected provider supports read-only review in that mode. With active
writers in a shared checkout, delegate review of the remote PR diff. A different
checkout requires a user-requested separate thread. Reassess affected changes
after a new push.

Forward code-level findings to the owner. Bring product and architecture changes
to the user before assigning those fixes.

Call a PR ready for merge when it is out of draft, its current head has passed
required checks, it has no conflicts, and blocking findings and review work are
resolved. Skipped or absent checks do not count as passes. Report unknown
mergeability as unknown. Preserve the user's draft policy and promote a draft
only when authorized. Merge or deploy only within the user's authorization.

Recheck dependent PRs after a merge or rebase. Rerun an apparent CI flake once;
a second failure goes to the owner and user with the job link.

## Recurring work

For user-requested recurring coordination, inspect `list_scheduled_tasks` and
reuse a matching schedule. Otherwise call `schedule_task` with
`bindToCurrentThread: true` and a structured schedule. Fixed wall-clock schedules
use the server's timezone; verify it before relying on a local clock time, or
use an interval. Report the returned cadence and `nextRunAt` with timezone.

Write a prompt that reads the ledger, checks live tasks, pending questions,
queues and PRs, and dispatches ready work that has no owner. If an earlier run
already resumed the work, check status only. Retain `scheduledTaskId`; use
`update_scheduled_task` to change or pause it. The scheduler creates recurring
work, not a one-shot wake-up. Snoozing a thread does not schedule execution.

## Away or low usage

When the user says they are leaving, AFK, or running low on usage:

1. Save the ledger before ending the turn. For each worker, record its emoji,
   IDs, PR, next step, and condition for resuming. Include decisions awaiting
   the user and any observed usage reset time, with timezone.
2. Do not open an interactive question for the absent user. Put decisions
   in the handoff and message text. Keep authorized independent work moving;
   park work that needs a human decision or approval. Do not answer on their
   behalf to clear an existing pending request.
3. Let asynchronous delegated completions return through T3. For usage limits,
   use T3's resume-at-reset control when available. AFK alone does not request
   a recurring schedule; use [Recurring work](#recurring-work) only when the
   user has requested continued checks.

On return or a scheduled check, reconcile the ledger with live runs, queues,
pending requests, and every open PR's CI, conflicts, and reviews. Resume only
work that stopped and has no live or queued continuation. Settle finished or parked
threads once they have no active work or unanswered request, then report.

## Recovery and takeover

Prefer resuming the existing coordinator: delegated task IDs belong to their
creating parent. Report usage limits and observed reset times. Check T3's
automatic reset recovery setting through available app controls, plus the
worker's live runs and queue, before retrying. `t3_environment_read` does not
guarantee access to that setting. Leave confirmed automatic recovery to T3.
If recovery state is unknown, wait until the observed reset time has passed,
then recheck the worker and queue. If it still has no continuation, send one
resume message to that worker with a stable `clientRequestId`. If no reset time
is available, record the missing information and ask when the user is available.
Do not assume a fixed usage window or change recovery preferences without
the user.
After a reset or interruption, read the ledger and live state. Resume incomplete
work that stopped, leaving runs waiting on children or the user in their
existing state.

For a user-requested takeover:

1. Read the old coordinator's ledger and messages. List and read its workers,
   including subagents, and identify pending decisions and schedules. Compare
   the new coordinator's `t3_worktree_status` with the old thread's binding.
   If they differ, do not delegate writers from the new coordinator. Existing
   workers can continue in their checkout. A replacement in the same checkout
   needs a user-requested launch using the `existing_worktree` workspace strategy;
   `t3_worktree_handoff` cannot attach this thread to that existing checkout.
2. Pause its schedules. Inspect `t3_queue_list` and cancel obsolete dispatches
   with `t3_queue_cancel`, preserving result deliveries. Send a queued stand-down
   instruction: forward original-task results to the new coordinator, which
   now owns the ledger. Write the ownership change to the shared ledger before
   new dispatch. Confirm the old coordinator has stopped dispatching before
   starting new work. If it is unresponsive, resolve or interrupt the active run
   and record that the new coordinator will observe original child results
   directly instead of relying on forwarding.
3. Check active runs before messaging workers. The new coordinator can read
   same-project child threads, but cannot use `task_status` or `task_cancel` on
   the old parent's tasks. Automatic completion still targets the old parent.
   Use `t3_thread_interrupt` if a child's active run must stop.
4. Keep existing workers running. Original results use the forwarding or direct
   observation route chosen above. Only new follow-ups sent with
   `t3_thread_send` report directly to the new coordinator. Record run IDs and
   consumed results so each result is acted on once. Direct observation needs
   bounded `t3_thread_wait` checks or an existing user-requested recurring check;
   original tasks cannot wake the new parent automatically.
5. Rebind schedules with `update_scheduled_task` and
   `bindToCurrentThread: true`, updating prompts that name the old coordinator.
   Verify `boundThreadId` through `list_scheduled_tasks` before re-enabling them.
   Record the coordinator ID and reporting arrangements in the ledger.
6. Unpin and settle the old coordinator after pending results are consumed and
   schedules have moved. Archive only after all original deliveries are drained;
   archiving earlier can drop them. Forking preserves context; it does not
   reparent tasks or merge code.
