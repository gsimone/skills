# Effort operations

## PRs and reviews

Associate implementation work with its issue and link every PR worked on using
`link_pull_request`, including each layer of a stack. Link from the owning
thread as well as the coordinator when their tools are available. Check
`list_thread_pull_requests` before finishing PR work for missing links. Keep
the coordinator pinned so automatic settlement does not park it after a merge.

Give a review worker the exact PR URL, head SHA, relevant spec, and review
scope. Require findings tied to files and lines, with evidence and severity.
Prefer reading the PR diff remotely when the shared checkout has active writers;
use an isolated reviewer thread when a different checkout is needed. Keep the
review read-only unless fixes were assigned. A review of an older SHA does
not cover a later push; reassess affected changes before declaring readiness.

Ready for merge means a non-draft PR whose current head has the required checks
completed successfully, no conflicts, and no unresolved blocking review findings or outstanding review
work. Inspect actual check conclusions: skipped or absent checks are not
evidence they passed. Report unknown mergeability as unknown. Preserve the
user's draft policy; readiness does not authorize merging or deployment.
Recheck dependent PRs after a merge or rebase. Rerun an apparent CI flake once;
if it fails again, report it with the job link and route the failure to its owner.

## Recurring work

Use the app scheduler when the user requests recurring coordination. First
inspect `list_scheduled_tasks` to reuse an existing schedule. Use `schedule_task`
with `bindToCurrentThread: true` and a structured schedule, for example
`{type: "interval", everyMs: 3600000}`. Fixed schedules use the server's timezone;
confirm it matches the requested wall-clock time. Report the returned cadence
and `nextRunAt`, with timezone.

The prompt should read the ledger, reconcile live tasks and PRs, and dispatch
only ready work without an existing owner. Save `scheduledTaskId`; update or
pause it with `update_scheduled_task`. Original asynchronous delegated tasks
already wake the parent; ordinary threads and follow-up runs need their own
reporting or observation. Snoozing organizes a thread; it does not schedule
execution. `schedule_task` is recurring, not a one-shot wake-up.

## Recovery and takeover

Prefer continuing the existing coordinator: delegated task IDs belong to
their creating parent. T3 owns queued delivery, background-work tracking, and
usage-limit recovery through its app controls. Report a limit and the observed
reset time; use the app's resume-at-reset option when available rather than
inventing a timer. After interruption or a reset, read live state and the
ledger; resume only work that actually stopped and still needs doing. Idle,
waiting on children, awaiting the user, and usage-limited are different states.
Use observed reset times rather than an assumed provider usage window.

For a user-requested takeover into another thread:

1. Read the old coordinator's ledger and relevant messages. List and read all
   owned workers, including subagents. Capture pending decisions and schedules.
2. Pause the old coordinator's schedules and account for queued dispatches.
   Send it a stand-down instruction: forward delivered results to the new
   coordinator ID, with the new coordinator becoming the sole ledger writer.
   Confirm it has stopped dispatching before starting new work; if it is
   unresponsive, resolve or interrupt its active run and record pending delivery
   ownership before proceeding.
3. Reconcile active runs before sending anything to workers. The new coordinator
   can read same-project child threads, but cannot use `task_status` on the old parent's
   tasks. Automatic child completion still targets the old parent.
4. Establish reporting to the new coordinator with `t3_thread_send`, using
   `queue` for a follow-up or `steer` only for an intended live update. Preserve
   existing work. Do not respawn a worker just to obtain new lineage.
5. Rebind relevant schedules from the new coordinator with
   `update_scheduled_task` and `bindToCurrentThread: true`, updating prompts
   that refer to the old coordinator. Verify `boundThreadId` with
   `list_scheduled_tasks` before re-enabling them. Record the new
   coordinator ID and reporting arrangement in the ledger.
6. Retire the old coordinator once its pending deliveries and work are
   accounted for. A fork preserves context; it does not reparent existing tasks
   or merge code.

## Existing Hawk efforts

Reuse house rules and `handoff.md`. Read an existing `effort.json` only to
recover issue, repository, worker, reviewer, and preferred-model mappings;
validate selections against the live capability catalog. Inspect workers and
PRs directly instead of treating `snapshot.json` or `events.ndjson` as current.

When retiring a live Hawk setup, identify its exact legacy watcher processes
and pending deliveries before stopping the effort's helpers. Preserve unrelated
processes and existing worker runs. These helpers have no role in a new
Kestrel effort: T3 owns delegation, completion delivery, naming mutations,
workspace binding, and scheduling. Changing this skill alone does not migrate
live threads or stop already-running watchers.
