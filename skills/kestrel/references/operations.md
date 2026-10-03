# Effort operations

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

Associate implementation work with its issue. Register PRs with
`link_pull_request` from the owner and coordinator threads, including each stack
layer. Check `list_thread_pull_requests` for missing links before finishing.

Give the reviewer the PR URL and head SHA, the relevant spec, and a review scope.
Request findings with file and line references, evidence, and severity. Keep
reviews read-only unless fixes were assigned. With active writers in a shared
checkout, read the PR diff remotely; use an isolated reviewer thread for a
different checkout. Reassess affected changes after a new push.

Call a PR ready for merge when it is out of draft, its current head has passed
required checks, it has no conflicts, and blocking findings and review work are
resolved. Skipped or absent checks do not count as passes. Report unknown
mergeability as unknown. Preserve the user's draft policy. Merge or deploy only
within the user's authorization.

Recheck dependent PRs after a merge or rebase. Rerun an apparent CI flake once;
a second failure goes to the owner and user with the job link.

## Recurring work

For user-requested recurring coordination, inspect `list_scheduled_tasks` and
reuse a matching schedule. Otherwise call `schedule_task` with
`bindToCurrentThread: true` and a structured schedule, such as
`{type: "interval", everyMs: 3600000}`. Check the server's timezone for fixed
wall-clock schedules. Report the returned cadence and `nextRunAt` with timezone.

Write a prompt that reads the ledger, checks live tasks and PRs, and dispatches
ready work that has no owner. Retain `scheduledTaskId`; use
`update_scheduled_task` to change or pause it. The scheduler creates recurring
work, not a one-shot wake-up. Snoozing a thread does not schedule execution.

## Recovery and takeover

Prefer resuming the existing coordinator: delegated task IDs belong to their
creating parent. Report usage limits and observed reset times; use T3's
resume-at-reset control when available. After a reset or interruption, read the
ledger and live state. Resume incomplete work that stopped, leaving runs waiting
on children or the user in their existing state.

For a user-requested takeover:

1. Read the old coordinator's ledger and messages. List and read its workers,
   including subagents, and identify pending decisions and schedules.
2. Pause its schedules and account for queued dispatches. Send a stand-down
   instruction: forward delivered results to the new coordinator, which now
   owns the ledger. Confirm the old coordinator has stopped dispatching before
   starting new work. If it is unresponsive, resolve or interrupt the active
   run and record who will handle pending deliveries before proceeding.
3. Check active runs before messaging workers. The new coordinator can read
   same-project child threads, but cannot use `task_status` on the old parent's
   tasks. Automatic completion still targets the old parent.
4. Establish reporting to the new coordinator with `t3_thread_send`; queue a
   follow-up or steer an intended live update. Keep existing workers running.
5. Rebind schedules with `update_scheduled_task` and
   `bindToCurrentThread: true`, updating prompts that name the old coordinator.
   Verify `boundThreadId` through `list_scheduled_tasks` before re-enabling them.
   Record the coordinator ID and reporting arrangements in the ledger.
6. Retire the old coordinator once its pending results have reached the new
   coordinator and its schedules have moved. Forking preserves context; it
   does not reparent tasks or merge code.

## Existing Hawk efforts

Reuse house rules and `handoff.md`. Recover issue, repository, worker, reviewer,
and preferred-model mappings from `effort.json`, checking models against the
live catalog. Read workers and PRs for current state; Hawk's snapshots and event
logs describe earlier observations.

For a migration, identify the effort's legacy watchers and pending deliveries
before stopping its helpers. Preserve unrelated processes and worker runs.
Editing or installing Kestrel leaves live Hawk efforts running until migrated.
