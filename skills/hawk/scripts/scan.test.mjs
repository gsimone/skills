import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { armedAfter, buildSnapshot, callbackPrompt, diffEvents, formatEvent, holdDelivery, isProviderMismatch, prMentionsIssue, prNumberFromUrl, summaryLine, watchVerdict } from "./lib.mjs";

const REPO = "acme/app";
const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const minutesAgo = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const effort = (threads = [], extra = {}) => ({ slug: "fixture", linearProjectId: "p", repo: REPO, threads, ...extra });

const issue = (identifier, stateType, prNumbers = []) => ({
  identifier,
  title: `${identifier} title`,
  url: `https://linear.app/acme/issue/${identifier}`,
  priority: 2,
  state: { type: stateType, name: stateType },
  attachments: { nodes: prNumbers.map((number) => ({ url: `https://github.com/${REPO}/pull/${number}` })) },
});

const checkRun = (name, conclusion) => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion, detailsUrl: `https://github.com/${REPO}/actions/runs/1/job/${encodeURIComponent(name)}` });

const pr = (number, overrides = {}) => ({
  number,
  url: `https://github.com/${REPO}/pull/${number}`,
  title: `feat: pr ${number}`,
  body: `## Summary\n\nFixes ENG-${number}`,
  state: "OPEN",
  isDraft: false,
  headRefName: `t3code/pr-${number}`,
  headRefOid: `sha${number}`,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING", contexts: { totalCount: 1, nodes: [{ __typename: "CheckRun", name: "Checks", status: "IN_PROGRESS", conclusion: null }] } } } }] },
  reviewThreads: { nodes: [] },
  ...overrides,
});

const rollup = (state, nodes) => ({ commits: { nodes: [{ commit: { statusCheckRollup: { state, contexts: { totalCount: nodes.length, nodes } } } }] } });

const thread = (id, overrides = {}) => ({
  id,
  title: `thread ${id}`,
  branch: null,
  worktreePath: null,
  modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
  session: { status: "running", providerInstanceId: "claudeAgent", lastError: null },
  latestTurn: { turnId: `turn-${id}`, state: "running", completedAt: null },
  createdAt: minutesAgo(60),
  updatedAt: minutesAgo(1),
  archivedAt: null,
  ...overrides,
});

function snap({ issues = [], prs = [], threads = [], upstreams = {}, registered = [], extra = {}, prev = null, now = NOW }) {
  return buildSnapshot({ effort: effort(registered, extra), issues, prs, threads, upstreams, prev, now });
}

const typesOf = (events) => events.map((event) => event.type).sort();

describe("prNumberFromUrl", () => {
  it("reads PR numbers from the effort's repo only", () => {
    assert.equal(prNumberFromUrl(`https://github.com/${REPO}/pull/101`, REPO), 101);
    assert.equal(prNumberFromUrl("https://github.com/other/repo/pull/1", REPO), null);
    assert.equal(prNumberFromUrl("https://x.com/poteto/status/1", REPO), null);
  });
});

describe("issue ownership", () => {
  it("an attached PR belongs to an issue only when its body, title, or branch names the key", () => {
    assert.equal(prMentionsIssue({ body: "Fixes ENG-346", title: "", headRefName: "" }, "ENG-338"), false);
    assert.equal(prMentionsIssue({ body: "", title: "", headRefName: "someone/eng-338-feature-map" }, "ENG-338"), true);
  });

  it("drops attached PRs that name another issue, so they raise no pr.no-issue", () => {
    const next = snap({
      issues: [issue("ENG-338", "started", [102])],
      prs: [pr(102, { body: "Fixes ENG-346", state: "CLOSED" })],
    });
    assert.deepEqual(Object.keys(next.prs), []);
    assert.deepEqual(typesOf(diffEvents(null, next)), ["issue.no-pr"]);
  });
});

describe("events", () => {
  it("a run with no changes emits nothing", () => {
    const input = { issues: [issue("ENG-1", "started", [1])], prs: [pr(1, { body: "Fixes ENG-1" })], threads: [thread("a", { branch: "t3code/pr-1" })] };
    const first = snap(input);
    const second = snap({ ...input, prev: first });
    assert.deepEqual(diffEvents(first, second), []);
  });

  it("checks.red names the failing jobs and fires again on a new head", () => {
    const red = { body: "Fixes ENG-1", ...rollup("FAILURE", [checkRun("Unit tests (2)", "FAILURE"), checkRun("Lint", "SUCCESS")]) };
    const first = snap({ issues: [issue("ENG-1", "started", [1])], prs: [pr(1, red)] });
    const events = diffEvents(null, first);
    assert.deepEqual(typesOf(events), ["checks.red"]);
    assert.deepEqual(events[0].failing.map((check) => check.name), ["Unit tests (2)"]);
    assert.match(events[0].failing[0].url, /actions\/runs/);
    const pushed = snap({ issues: [issue("ENG-1", "started", [1])], prs: [pr(1, { ...red, headRefOid: "sha1b" })], prev: first });
    assert.deepEqual(typesOf(diffEvents(first, pushed)), ["checks.red"]);
  });

  it("checks.green on a ready PR, draft.vacuous-green on a draft with skipped jobs", () => {
    const green = rollup("SUCCESS", [checkRun("Checks", "SUCCESS"), checkRun("Unit tests", "SKIPPED")]);
    const ready = snap({ issues: [issue("ENG-1", "started", [1])], prs: [pr(1, { body: "Fixes ENG-1", ...green })] });
    assert.deepEqual(typesOf(diffEvents(null, ready)), ["checks.green", "pr.ready"]);
    const draft = snap({ issues: [issue("ENG-1", "started", [1])], prs: [pr(1, { body: "Fixes ENG-1", isDraft: true, ...green })] });
    assert.deepEqual(typesOf(diffEvents(null, draft)), ["draft.vacuous-green"]);
    const realDraftGreen = rollup("SUCCESS", [checkRun("Checks", "SUCCESS")]);
    const draftNoSkips = snap({ issues: [issue("ENG-1", "started", [1])], prs: [pr(1, { body: "Fixes ENG-1", isDraft: true, ...realDraftGreen })] });
    assert.deepEqual(typesOf(diffEvents(null, draftNoSkips)), ["checks.green"]);
  });

  it("mergeability.unknown fires only after 10 minutes on the same head", () => {
    const unknown = { body: "Fixes ENG-1", mergeable: "UNKNOWN" };
    const issues = [issue("ENG-1", "started", [1])];
    const first = snap({ issues, prs: [pr(1, unknown)], now: NOW - 11 * 60_000 });
    assert.deepEqual(diffEvents(null, first), []);
    const later = snap({ issues, prs: [pr(1, unknown)], prev: first });
    assert.deepEqual(typesOf(diffEvents(first, later)), ["mergeability.unknown"]);
    const newHead = snap({ issues, prs: [pr(1, { ...unknown, headRefOid: "sha1b" })], prev: first });
    assert.deepEqual(diffEvents(first, newHead), []);
  });

  it("review.thread.new fires once per unresolved thread", () => {
    const threads = { reviewThreads: { nodes: [
      { id: "RT_1", isResolved: false, comments: { nodes: [{ author: { login: "cursor" }, url: "u1" }] } },
      { id: "RT_2", isResolved: true, comments: { nodes: [] } },
    ] } };
    const issues = [issue("ENG-1", "started", [1])];
    const first = snap({ issues, prs: [pr(1, { body: "Fixes ENG-1", ...threads })] });
    const events = diffEvents(null, first);
    assert.deepEqual(typesOf(events), ["review.thread.new"]);
    assert.equal(events[0].author, "cursor");
    assert.deepEqual(diffEvents(first, snap({ issues, prs: [pr(1, { body: "Fixes ENG-1", ...threads })], prev: first })), []);
  });

  it("pr.merged and pr.closed", () => {
    const issues = [issue("ENG-1", "completed", [1]), issue("ENG-2", "canceled", [2])];
    const next = snap({ issues, prs: [pr(1, { body: "Fixes ENG-1", state: "MERGED" }), pr(2, { body: "Fixes ENG-2", state: "CLOSED" })] });
    assert.deepEqual(typesOf(diffEvents(null, next)), ["pr.closed", "pr.merged"]);
  });

  it("issue.no-pr for a started issue, pr.no-issue for a registered thread's unlinked PR", () => {
    const next = snap({
      issues: [issue("ENG-1", "started"), issue("ENG-2", "backlog")],
      prs: [pr(9, { body: "no key here", headRefName: "t3code/loose" })],
      threads: [thread("a", { branch: "t3code/loose" })],
      registered: ["a"],
    });
    assert.deepEqual(typesOf(diffEvents(null, next)), ["issue.no-pr", "pr.no-issue"]);
  });

  it("thread.error, thread.interrupted, thread.stalled, thread.dead-ask", () => {
    const next = snap({
      threads: [
        thread("err", { latestTurn: { turnId: "t1", state: "error", completedAt: null } }),
        thread("int", { latestTurn: { turnId: "t2", state: "interrupted", completedAt: null } }),
        thread("stall", { updatedAt: minutesAgo(31) }),
        thread("busy", { updatedAt: minutesAgo(5) }),
        thread("ask", { latestTurn: null, session: { status: "ready", providerInstanceId: "claudeAgent" }, createdAt: minutesAgo(6) }),
        thread("fresh", { latestTurn: null, session: { status: "ready", providerInstanceId: "claudeAgent" }, createdAt: minutesAgo(1) }),
      ],
      registered: ["err", "int", "stall", "busy", "ask", "fresh"],
    });
    assert.deepEqual(typesOf(diffEvents(null, next)), ["thread.dead-ask", "thread.error", "thread.interrupted", "thread.stalled"]);
  });

  it("thread.provider-mismatch for a Claude model on codex", () => {
    assert.equal(isProviderMismatch({ provider: "codex", sessionProvider: "codex", model: "claude-fable-5-1" }), true);
    assert.equal(isProviderMismatch({ provider: "cursor", sessionProvider: "cursor", model: "gpt-5.6-sol" }), false);
    assert.equal(isProviderMismatch({ provider: "claudeAgent", sessionProvider: "codex", model: "claude-opus-5-5" }), true);
    const next = snap({ threads: [thread("r", { modelSelection: { instanceId: "codex", model: "claude-fable-5-1" }, session: { status: "running", providerInstanceId: "codex" } })], registered: ["r"] });
    assert.deepEqual(typesOf(diffEvents(null, next)), ["thread.provider-mismatch"]);
  });

  it("thread.tracks-main when the worktree branch tracks origin/main", () => {
    const next = snap({ threads: [thread("w")], upstreams: { w: "origin/main" }, registered: ["w"] });
    assert.deepEqual(typesOf(diffEvents(null, next)), ["thread.tracks-main"]);
  });

  it("owner.reported once per completed turn, and threads attach to their PR by branch", () => {
    const issues = [issue("ENG-1", "started", [1])];
    const done = (turnId) => thread("o", { branch: "t3code/pr-1", latestTurn: { turnId, state: "completed", completedAt: minutesAgo(1) } });
    const first = snap({ issues, prs: [pr(1, { body: "Fixes ENG-1" })], threads: [done("t1")] });
    assert.equal(first.threads.o.pr, 1);
    assert.deepEqual(typesOf(diffEvents(null, first)), ["owner.reported"]);
    const second = snap({ issues, prs: [pr(1, { body: "Fixes ENG-1" })], threads: [done("t2")], prev: first });
    assert.deepEqual(typesOf(diffEvents(first, second)), ["owner.reported"]);
  });

  it("ignores archived threads and threads outside the effort", () => {
    const next = snap({ threads: [thread("x", { latestTurn: { turnId: "t", state: "error" } }), thread("y", { archivedAt: minutesAgo(1) })], registered: ["y"] });
    assert.deepEqual(diffEvents(null, next), []);
  });
});

describe("formatEvent", () => {
  it("PR events link GitHub and Linear; thread events link the PR and never a t3 URL", () => {
    const red = { body: "Fixes ENG-1", ...rollup("FAILURE", [checkRun("Lint", "FAILURE")]) };
    const withThread = { reviewThreads: { nodes: [{ id: "RT_1", isResolved: false, comments: { nodes: [{ author: { login: "greptile-apps" }, url: `https://github.com/${REPO}/pull/1#discussion_r1` }] } }] } };
    const next = snap({
      issues: [issue("ENG-1", "started", [1]), issue("ENG-2", "started"), issue("ENG-3", "completed", [3])],
      prs: [pr(1, { ...red, ...withThread }), pr(3, { body: "Fixes ENG-3", state: "MERGED" })],
      threads: [thread("o", { branch: "t3code/pr-1", latestTurn: { turnId: "t", state: "error" } }), thread("s", { updatedAt: minutesAgo(40) })],
      upstreams: { s: "origin/main" },
      registered: ["s"],
    });
    const events = diffEvents(null, next);
    assert.ok(events.length >= 6);
    for (const event of events.filter((event) => !event.thread || event.pr)) assert.match(formatEvent(event), /https:\/\//, `${event.type} has no link: ${formatEvent(event)}`);
    for (const event of events) assert.doesNotMatch(formatEvent(event), /127\.0\.0\.1|t3code:\/\//);
    const redLine = formatEvent(events.find((event) => event.type === "checks.red"));
    assert.match(redLine, /pull\/1/);
    assert.match(redLine, /actions\/runs/);
    assert.match(redLine, /linear\.app\/.*ENG-1/);
    assert.match(formatEvent(events.find((event) => event.type === "thread.error")), /thread o.*pull\/1/);
  });
});

describe("hawk duty events", () => {
  const issues = [issue("ENG-1", "started", [1])];
  const greenReady = { body: "Fixes ENG-1", ...rollup("SUCCESS", [checkRun("Checks", "SUCCESS")]) };
  const idle = (id, overrides = {}) => thread(id, { session: { status: "ready", providerInstanceId: "claudeAgent" }, latestTurn: { turnId: `turn-${id}`, state: "completed", completedAt: minutesAgo(1) }, ...overrides });

  it("pr.ready needs real CI, no conflicts, and no unresolved review threads; pr.conflicts on CONFLICTING", () => {
    assert.ok(typesOf(diffEvents(null, snap({ issues, prs: [pr(1, greenReady)] }))).includes("pr.ready"));
    const blockers = [
      { isDraft: true },
      { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" },
      { mergeStateStatus: "BEHIND" },
      { reviewThreads: { nodes: [{ id: "RT_9", isResolved: false, comments: { nodes: [] } }] } },
    ];
    for (const blocker of blockers) {
      assert.ok(!typesOf(diffEvents(null, snap({ issues, prs: [pr(1, { ...greenReady, ...blocker })] }))).includes("pr.ready"), JSON.stringify(blocker));
    }
    assert.ok(typesOf(diffEvents(null, snap({ issues, prs: [pr(1, { ...greenReady, mergeable: "CONFLICTING" })] }))).includes("pr.conflicts"));
  });

  it("thread.untagged when a title lost the effort prefix; the hawk carries the hawk badge", () => {
    const extra = { tag: "✉️ email", hawk: "h" };
    const next = snap({
      threads: [
        idle("good", { title: "[✉️ email] 🐝 Preview before send" }),
        idle("renamed", { title: "Preview Task Email Before Sending" }),
        idle("h", { title: "[🔺 hawk // ✉️ email] 🐢 Assess Email PR Status" }),
        idle("h2", { title: "[✉️ email] 🐢 hawk without badge" }),
      ],
      registered: ["good", "renamed", "h2"],
      extra,
    });
    const untagged = diffEvents(null, next).filter((event) => event.type === "thread.untagged");
    assert.deepEqual(untagged.map((event) => event.thread).sort(), ["renamed"]);
    const hawkWrong = snap({ threads: [idle("h", { title: "[✉️ email] 🐢 Assess" })], extra });
    assert.equal(diffEvents(null, hawkWrong).find((event) => event.type === "thread.untagged")?.expected, "[🔺 hawk // ✉️ email]");
  });

  it("thread.settleable for merged or closed PRs, finished reviewers, and threads that wait only on a human", () => {
    const merged = { ...greenReady, state: "MERGED" };
    const next = snap({
      issues: [issue("ENG-1", "completed", [1]), issue("ENG-2", "started", [2])],
      prs: [pr(1, merged), pr(2, { ...greenReady, body: "Fixes ENG-2" })],
      threads: [
        idle("merged", { branch: "t3code/pr-1" }),
        idle("ready", { branch: "t3code/pr-2" }),
        idle("rev"),
        idle("done-settled", { settledAt: minutesAgo(1) }),
        thread("running-rev"),
        idle("monitoring-rev", { backgroundLiveness: "monitoring" }),
        idle("asking-rev", { hasPendingUserInput: true }),
      ],
      extra: { reviewers: ["rev", "done-settled", "running-rev", "monitoring-rev", "asking-rev"] },
    });
    const settleable = Object.fromEntries(diffEvents(null, next).filter((event) => event.type === "thread.settleable").map((event) => [event.thread, event.reason]));
    assert.deepEqual(settleable, { merged: "pr-merged", ready: "waits-on-human", rev: "reviewer-done" });
  });

  it("the hawk is never settleable, never owns a PR, and raises no owner.reported", () => {
    const next = snap({ issues, prs: [pr(1, { ...greenReady, state: "MERGED" })], threads: [idle("h", { branch: "t3code/pr-1", title: "x" })], extra: { hawk: "h" } });
    assert.equal(next.threads.h.pr, null);
    assert.deepEqual(diffEvents(null, next).filter((event) => event.thread === "h"), []);
  });

  it("thread.awaiting-input for an open question, and no thread.stalled while it waits", () => {
    const next = snap({ threads: [thread("q", { hasPendingUserInput: true, updatedAt: minutesAgo(90) })], registered: ["q"] });
    assert.deepEqual(typesOf(diffEvents(null, next)), ["thread.awaiting-input"]);
  });

  it("thread.error marks usage and capacity limits", () => {
    const next = snap({ threads: [thread("cap", { latestTurn: { turnId: "t", state: "error" }, session: { status: "error", providerInstanceId: "codex", lastError: "Selected model is at capacity" }, modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } })], registered: ["cap"] });
    const event = diffEvents(null, next).find((event) => event.type === "thread.error");
    assert.equal(event.limit, true);
    assert.match(formatEvent(event), /resume after the reset/);
  });
});

describe("watcher logic", () => {
  const child = (turnId, state, extra = {}) => ({ id: "c", title: "[✉️ email] 🐝 child", latestTurn: { turnId, state }, ...extra });

  it("arms past what the child shows now", () => {
    assert.equal(armedAfter(child("t1", "completed")), "t1");
    assert.equal(armedAfter(child("t2", "running")), "");
    assert.equal(armedAfter(child("t2", "running", { hasPendingUserInput: true })), "t2:input");
    assert.equal(armedAfter({ latestTurn: null }), "");
  });

  it("delivers once per turn end and once per question, never on the seen one", () => {
    assert.equal(watchVerdict(child("t1", "completed"), "t1"), "wait");
    assert.equal(watchVerdict(child("t2", "running"), "t1"), "wait");
    assert.equal(watchVerdict(child("t2", "completed"), "t1"), "deliver");
    assert.equal(watchVerdict(child("t2", "interrupted"), ""), "deliver");
    assert.equal(watchVerdict(child("t2", "running", { hasPendingUserInput: true }), "t1"), "deliver");
    assert.equal(watchVerdict(child("t2", "running", { hasPendingUserInput: true }), "t2:input"), "wait");
    assert.equal(watchVerdict(child("t2", "completed"), "t2:input"), "deliver");
  });

  it("holds delivery while the hawk has an open question", () => {
    assert.equal(holdDelivery({ hasPendingUserInput: true }), true);
    assert.equal(holdDelivery({ hasPendingApprovals: true }), true);
    assert.equal(holdDelivery({ hasPendingUserInput: false }), false);
  });

  it("the callback prompt points at hawk duty instead of restating the rules", () => {
    const prompt = callbackPrompt({ slug: "email", child: child("t9", "completed"), background: "monitoring", note: "#42 stays a draft." });
    assert.match(prompt, /email: "\[✉️ email\] 🐝 child" \(c\) ended turn t9 \(completed\), background monitoring/);
    assert.match(prompt, /Hawk duty/);
    assert.match(prompt, /#42 stays a draft\./);
  });
});

describe("summaryLine", () => {
  it("counts events by type", () => {
    const next = snap({ issues: [issue("ENG-1", "started")] });
    assert.equal(summaryLine(next, diffEvents(null, next)), "fixture: 1 issues, 0 open PRs, 0 threads, 1 new events (issue.no-pr×1)");
  });
});
