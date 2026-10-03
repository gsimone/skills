export const DEFAULTS = {
  stalledMinutes: 30,
  deadAskMinutes: 5,
  mergeabilityUnknownMinutes: 10,
};

const MINUTE = 60_000;
const RED_ROLLUP = new Set(["FAILURE", "ERROR"]);
const RED_CONCLUSION = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "ERROR"]);
const LIMIT_ERROR = /usage limit|rate.?limit|limit reached|at capacity|overloaded/i;
export const HAWK_BADGE = "🔺 hawk";

export function prNumberFromUrl(url, repo) {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url ?? "");
  if (!match || match[1].toLowerCase() !== repo.toLowerCase()) return null;
  return Number(match[2]);
}

export function prMentionsIssue(pr, issueKey) {
  const key = issueKey.toLowerCase();
  return [pr.body, pr.title, pr.headRefName].some((text) => (text ?? "").toLowerCase().includes(key));
}

export function summarizeChecks(rollup) {
  const nodes = rollup?.contexts?.nodes ?? [];
  const outcome = (node) => node.conclusion ?? node.state ?? node.status ?? "UNKNOWN";
  const failing = nodes
    .filter((node) => RED_CONCLUSION.has(outcome(node)))
    .map((node) => ({ name: node.name ?? node.context, url: node.detailsUrl ?? node.targetUrl ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    state: rollup?.state ?? "NONE",
    total: rollup?.contexts?.totalCount ?? nodes.length,
    success: nodes.filter((node) => outcome(node) === "SUCCESS").length,
    skipped: nodes.filter((node) => outcome(node) === "SKIPPED").length,
    failing,
  };
}

function normalizePr(raw, prevPr, now) {
  const headSha = raw.headRefOid;
  const unknown = raw.mergeable === "UNKNOWN";
  const carried = unknown && prevPr?.headSha === headSha ? prevPr.unknownSince : null;
  return {
    number: raw.number,
    url: raw.url,
    title: raw.title,
    state: raw.state,
    isDraft: raw.isDraft,
    headRefName: raw.headRefName,
    headSha,
    mergeable: raw.mergeable,
    mergeState: raw.mergeStateStatus,
    reviewDecision: raw.reviewDecision ?? null,
    checks: summarizeChecks(raw.commits?.nodes?.[0]?.commit?.statusCheckRollup),
    unresolvedThreads: (raw.reviewThreads?.nodes ?? [])
      .filter((thread) => !thread.isResolved)
      .map((thread) => ({
        id: thread.id,
        author: thread.comments?.nodes?.[0]?.author?.login ?? null,
        url: thread.comments?.nodes?.[0]?.url ?? null,
      })),
    unknownSince: unknown ? (carried ?? new Date(now).toISOString()) : null,
    issueKeys: [],
  };
}

export function titlePrefix(effort, threadId) {
  if (!effort.tag) return null;
  return threadId === effort.hawk ? `[${HAWK_BADGE} // ${effort.tag}]` : `[${effort.tag}]`;
}

function roleOf(effort, threadId) {
  if (threadId === effort.hawk) return "hawk";
  if ((effort.reviewers ?? []).includes(threadId)) return "reviewer";
  return null;
}

function normalizeThread(raw, upstream, effort) {
  return {
    id: raw.id,
    role: roleOf(effort, raw.id),
    title: raw.title,
    titlePrefix: titlePrefix(effort, raw.id),
    branch: raw.branch ?? null,
    worktreePath: raw.worktreePath ?? null,
    model: raw.modelSelection?.model ?? null,
    provider: raw.modelSelection?.instanceId ?? null,
    sessionProvider: raw.session?.providerInstanceId ?? null,
    sessionStatus: raw.session?.status ?? null,
    lastError: raw.session?.lastError ?? null,
    turn: raw.latestTurn
      ? { id: raw.latestTurn.turnId, state: raw.latestTurn.state, completedAt: raw.latestTurn.completedAt ?? null }
      : null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    upstream: upstream ?? null,
    settled: Boolean(raw.settledAt),
    pendingInput: Boolean(raw.hasPendingUserInput || raw.hasPendingApprovals),
    background: raw.backgroundLiveness ?? null,
    pr: null,
  };
}

export function buildSnapshot({ effort, issues, prs, threads, upstreams = {}, prev = null, now }) {
  const prevPrs = prev?.prs ?? {};
  const prByNumber = {};
  for (const raw of prs) prByNumber[raw.number] = normalizePr(raw, prevPrs[raw.number], now);

  const snapshotIssues = issues.map((issue) => {
    const owned = (issue.attachments?.nodes ?? [])
      .map((attachment) => prNumberFromUrl(attachment.url, effort.repo))
      .filter((number) => number !== null && prByNumber[number] && prMentionsIssue(prs.find((pr) => pr.number === number), issue.identifier));
    const uniqueOwned = [...new Set(owned)].sort((a, b) => a - b);
    for (const number of uniqueOwned) prByNumber[number].issueKeys.push(issue.identifier);
    return {
      key: issue.identifier,
      title: issue.title,
      url: issue.url ?? null,
      stateType: issue.state?.type ?? null,
      stateName: issue.state?.name ?? null,
      priority: issue.priority ?? 0,
      prs: uniqueOwned,
    };
  });

  const registered = new Set([...(effort.threads ?? []), ...(effort.reviewers ?? []), ...(effort.hawk ? [effort.hawk] : [])]);
  const registeredBranches = new Set(threads.filter((thread) => registered.has(thread.id)).map((thread) => thread.branch));
  for (const [number, pr] of Object.entries(prByNumber)) {
    if (pr.issueKeys.length === 0 && !registeredBranches.has(pr.headRefName)) delete prByNumber[number];
  }
  const branchToPr = new Map(Object.values(prByNumber).map((pr) => [pr.headRefName, pr.number]));
  const snapshotThreads = {};
  const candidates = threads
    .filter((thread) => !thread.archivedAt)
    .filter((thread) => registered.has(thread.id) || branchToPr.has(thread.branch))
    .sort((a, b) => Number(Boolean(a.settledAt)) - Number(Boolean(b.settledAt)) || String(b.createdAt).localeCompare(String(a.createdAt)));
  const ownerTaken = new Set();
  for (const raw of candidates) {
    const thread = normalizeThread(raw, upstreams[raw.id], effort);
    const number = branchToPr.get(thread.branch);
    if (number !== undefined && thread.role !== "hawk" && !ownerTaken.has(number)) {
      thread.pr = number;
      ownerTaken.add(number);
    }
    snapshotThreads[thread.id] = thread;
  }

  const snapshot = {
    version: 1,
    effort: effort.slug,
    hawk: effort.hawk ?? null,
    takenAt: new Date(now).toISOString(),
    issues: snapshotIssues,
    prs: prByNumber,
    threads: snapshotThreads,
  };
  snapshot.conditions = conditionsOf(snapshot, now);
  return snapshot;
}

const minutesSince = (iso, now) => (now - Date.parse(iso)) / MINUTE;

export function conditionsOf(snapshot, now, options = DEFAULTS) {
  const found = {};
  const add = (type, key, detail) => {
    found[`${type}:${key}`] = { type, key: `${type}:${key}`, ...detail };
  };

  const issueUrl = Object.fromEntries(snapshot.issues.map((issue) => [issue.key, issue.url]));
  for (const pr of Object.values(snapshot.prs)) {
    const ref = { pr: pr.number, url: pr.url, title: pr.title, issues: pr.issueKeys.map((key) => ({ key, url: issueUrl[key] ?? null })) };
    if (pr.state === "MERGED") {
      add("pr.merged", pr.number, ref);
      continue;
    }
    if (pr.state === "CLOSED") {
      add("pr.closed", pr.number, ref);
      continue;
    }
    const sha = pr.headSha;
    if (RED_ROLLUP.has(pr.checks.state)) {
      add("checks.red", `${pr.number}:${sha}`, { ...ref, sha, failing: pr.checks.failing });
    } else if (pr.checks.state === "SUCCESS" && pr.isDraft && pr.checks.skipped > 0) {
      add("draft.vacuous-green", `${pr.number}:${sha}`, { ...ref, sha, skipped: pr.checks.skipped, success: pr.checks.success });
    } else if (pr.checks.state === "SUCCESS") {
      add("checks.green", `${pr.number}:${sha}`, { ...ref, sha });
    }
    if (pr.mergeable === "CONFLICTING") add("pr.conflicts", `${pr.number}:${sha}`, { ...ref, sha });
    if (isReady(pr)) add("pr.ready", `${pr.number}:${sha}`, { ...ref, sha });
    if (pr.unknownSince && minutesSince(pr.unknownSince, now) >= options.mergeabilityUnknownMinutes) {
      add("mergeability.unknown", `${pr.number}:${sha}`, { ...ref, sha, since: pr.unknownSince });
    }
    for (const thread of pr.unresolvedThreads) {
      add("review.thread.new", thread.id, { ...ref, author: thread.author, threadUrl: thread.url });
    }
    if (pr.issueKeys.length === 0) add("pr.no-issue", pr.number, ref);
  }

  for (const issue of snapshot.issues) {
    if (issue.stateType === "started" && issue.prs.length === 0) add("issue.no-pr", issue.key, { issue: issue.key, title: issue.title, url: issue.url });
  }

  for (const thread of Object.values(snapshot.threads)) {
    const ref = { thread: thread.id, title: thread.title, pr: thread.pr, prUrl: snapshot.prs[thread.pr]?.url ?? null };
    const turnId = thread.turn?.id ?? "none";
    if (thread.titlePrefix && !String(thread.title ?? "").startsWith(thread.titlePrefix)) {
      add("thread.untagged", `${thread.id}:${thread.title}`, { ...ref, expected: thread.titlePrefix });
    }
    if (thread.role === "hawk") continue;
    if (thread.turn?.state === "error" || thread.lastError) {
      add("thread.error", `${thread.id}:${turnId}`, { ...ref, error: thread.lastError, limit: LIMIT_ERROR.test(String(thread.lastError ?? "")) });
    }
    if (thread.turn?.state === "interrupted") add("thread.interrupted", `${thread.id}:${turnId}`, ref);
    if (thread.turn?.state === "running" && !thread.pendingInput && minutesSince(thread.updatedAt, now) >= options.stalledMinutes) {
      add("thread.stalled", `${thread.id}:${turnId}`, { ...ref, idleMinutes: Math.floor(minutesSince(thread.updatedAt, now)) });
    }
    if (thread.pendingInput) add("thread.awaiting-input", `${thread.id}:${turnId}`, ref);
    if (!thread.turn && minutesSince(thread.createdAt, now) >= options.deadAskMinutes) add("thread.dead-ask", thread.id, ref);
    if (isProviderMismatch(thread)) add("thread.provider-mismatch", thread.id, { ...ref, provider: thread.provider, model: thread.model });
    if (thread.upstream === "origin/main" || thread.upstream === "main") add("thread.tracks-main", thread.id, { ...ref, upstream: thread.upstream });
    if (thread.turn?.state === "completed" && thread.turn.completedAt) add("owner.reported", `${thread.id}:${turnId}`, { ...ref, at: thread.turn.completedAt });
    const reason = settleReason(thread, snapshot.prs[thread.pr]);
    if (reason) add("thread.settleable", `${thread.id}:${turnId}:${reason}`, { ...ref, reason });
  }

  return found;
}

export function isReady(pr) {
  if (pr.state !== "OPEN" || pr.isDraft) return false;
  if (pr.checks.state !== "SUCCESS" || pr.mergeable !== "MERGEABLE") return false;
  if (pr.mergeState === "DIRTY" || pr.mergeState === "BEHIND") return false;
  return pr.unresolvedThreads.length === 0;
}

export function settleReason(thread, pr) {
  if (thread.settled || thread.role === "hawk" || !thread.turn) return null;
  if (thread.turn.state === "running" || thread.pendingInput || thread.background) return null;
  if (pr?.state === "MERGED") return "pr-merged";
  if (pr?.state === "CLOSED") return "pr-closed";
  if (thread.role === "reviewer" && thread.turn.state === "completed") return "reviewer-done";
  if (pr && isReady(pr) && thread.turn.state === "completed") return "waits-on-human";
  return null;
}

export function isProviderMismatch(thread) {
  if (thread.sessionProvider && thread.provider && thread.sessionProvider !== thread.provider) return true;
  const model = thread.model ?? "";
  if (model.startsWith("claude-") && thread.provider === "codex") return true;
  if (model.startsWith("gpt-") && thread.provider === "claudeAgent") return true;
  return false;
}

export function diffEvents(prev, next) {
  const before = prev?.conditions ?? {};
  return Object.values(next.conditions)
    .filter((event) => !(event.key in before))
    .map((event) => ({ at: next.takenAt, ...event }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function summaryLine(snapshot, events) {
  const counts = {};
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  const parts = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => `${type}×${count}`);
  const open = Object.values(snapshot.prs).filter((pr) => pr.state === "OPEN").length;
  return `${snapshot.effort}: ${snapshot.issues.length} issues, ${open} open PRs, ${Object.keys(snapshot.threads).length} threads, ${events.length} new events${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

const prLabel = (event) => (event.pr ? `#${event.pr}${event.title ? ` ${event.title}` : ""}` : "");
const issueList = (event) => (event.issues ?? []).map((issue) => `${issue.key} ${issue.url ?? ""}`.trim()).join(", ");

export function formatEvent(event) {
  const parts = [event.type];
  switch (event.type) {
    case "checks.red":
      parts.push(prLabel(event), event.url, `failing: ${event.failing.map((check) => `${check.name} ${check.url ?? ""}`.trim()).join("; ")}`);
      break;
    case "review.thread.new":
      parts.push(prLabel(event), event.threadUrl ?? event.url, event.author ? `by ${event.author}` : "");
      break;
    case "issue.no-pr":
      parts.push(event.issue, event.title, event.url);
      break;
    case "draft.vacuous-green":
      parts.push(prLabel(event), event.url, `${event.skipped} skipped, ${event.success} passed`);
      break;
    case "mergeability.unknown":
      parts.push(prLabel(event), event.url, `unknown since ${event.since}`);
      break;
    default:
      if (event.thread) {
        parts.push(event.title, `thread ${event.thread}`);
        if (event.pr) parts.push(`PR #${event.pr} ${event.prUrl ?? ""}`.trim());
        if (event.idleMinutes !== undefined) parts.push(`idle ${event.idleMinutes} min`);
        if (event.upstream) parts.push(`tracks ${event.upstream}`);
        if (event.model) parts.push(`${event.model} on ${event.provider}`);
        if (event.expected) parts.push(`expected prefix ${event.expected}`);
        if (event.reason) parts.push(event.reason);
        if (event.limit) parts.push("usage or capacity limit: resume after the reset");
        if (event.error) parts.push(String(event.error).slice(0, 160));
      } else {
        parts.push(prLabel(event), event.url);
      }
  }
  if (event.issues?.length && event.type !== "issue.no-pr") parts.push(issueList(event));
  return parts.filter(Boolean).join(" · ");
}

const asking = (thread) => Boolean(thread?.hasPendingUserInput || thread?.hasPendingApprovals);

export function armedAfter(child) {
  const turn = child?.latestTurn;
  if (!turn) return "";
  if (asking(child)) return `${turn.turnId}:input`;
  return turn.state === "running" ? "" : turn.turnId;
}

export function watchVerdict(child, seen = "") {
  const turn = child?.latestTurn;
  if (!turn) return "wait";
  if (asking(child)) return seen === `${turn.turnId}:input` ? "wait" : "deliver";
  if (turn.state === "running") return "wait";
  return seen === turn.turnId ? "wait" : "deliver";
}

export function holdDelivery(hawk) {
  return asking(hawk);
}

export function callbackPrompt({ slug, child, background = null, note = null }) {
  const turn = child.latestTurn ?? {};
  const state = asking(child) ? "is waiting on a question" : `ended turn ${turn.turnId} (${turn.state})`;
  const lines = [
    `Hawk callback · ${slug}: "${child.title}" (${child.id}) ${state}${background ? `, background ${background}` : ""}.`,
    `Run hawk duty for it (hawk skill, "Hawk duty"). If you already handled this, reply nothing and stop.`,
  ];
  if (note) lines.push(note);
  return lines.join("\n");
}

export const EMOJI_POOL = [...new Intl.Segmenter().segment("🐝🦚🐙🦩🦜🐍🐢🦊🦉🐳🦔🦦🦥🐌🦀🐡🦑🐞🦋🐊🦭🐧🦒🦓🦘🐿️🦫🦬🐉🌵🌶️🍄🌻🪴🍋🥝🫐🍉🧊🔭🧪🧯📎🎯🛡️🪵📮🧲🪐🎈🧭🪁🎲🧩🪄🔦🧵🪡🛰️🚂⛵🎻🥁🪘🎺🧨🏮🪩🍩🥨🧁🫖🍵🪨🌋🌊🌙🌈❄️🔥⚓🪃🗝️🧸")].map((part) => part.segment);
const bare = (emoji) => emoji.replace(/\uFE0F/g, "");

const LEADING_GROUP = /^\s*\[[^\]]*\]\s*/u;
const EMOJI = "\\p{Extended_Pictographic}\\uFE0F?(?:\\u200D\\p{Extended_Pictographic}\\uFE0F?)*";
const LEADING_EMOJI = new RegExp(`^(${EMOJI})\\s*`, "u");
const LEADING_TAGGED_GROUP = new RegExp(`^\\s*${EMOJI}\\s*\\[[^\\]]*\\]\\s*`, "u");

export function splitTitle(title) {
  let rest = String(title ?? "");
  for (;;) {
    const group = LEADING_GROUP.exec(rest) ?? LEADING_TAGGED_GROUP.exec(rest);
    if (!group) break;
    rest = rest.slice(group[0].length);
  }
  const match = LEADING_EMOJI.exec(rest);
  return { emoji: match ? match[1] : null, text: (match ? rest.slice(match[0].length) : rest).trim() };
}

export function pickEmoji(used, random = Math.random) {
  const taken = new Set([...used].map(bare));
  const free = EMOJI_POOL.filter((emoji) => !taken.has(bare(emoji)));
  const pool = free.length ? free : EMOJI_POOL;
  return pool[Math.floor(random() * pool.length) % pool.length];
}

export function composeTitle({ effort, role = "child", suggestion, used = new Set(), random = Math.random }) {
  if (!effort.tag) throw new Error(`effort ${effort.slug} has no tag. run scan.mjs --effort ${effort.slug} --set-tag "<emoji> <name>"`);
  const { emoji, text } = splitTitle(suggestion);
  if (!text) throw new Error("the suggested title is empty");
  const bareUsed = new Set([...used].map(bare));
  const chosen = emoji && !bareUsed.has(bare(emoji)) ? emoji : pickEmoji(used, random);
  const prefix = role === "hawk" ? `[${HAWK_BADGE} // ${effort.tag}]` : `[${effort.tag}]`;
  return `${prefix} ${chosen} ${text}`;
}

export function emojisInUse(threads, exceptId = null) {
  return new Set(threads.filter((thread) => thread.id !== exceptId).map((thread) => splitTitle(thread.title).emoji).filter(Boolean));
}

export function namingPlan(effort, threads, random = Math.random) {
  if (!effort.tag) throw new Error(`effort ${effort.slug} has no tag. run scan.mjs --effort ${effort.slug} --set-tag "<emoji> <name>"`);
  const order = [...threads].sort((a, b) => Number(Boolean(a.settledAt)) - Number(Boolean(b.settledAt)) || String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
  const claimed = new Set();
  const keeps = new Set();
  for (const thread of order) {
    const { emoji } = splitTitle(thread.title);
    if (emoji && !claimed.has(bare(emoji))) {
      claimed.add(bare(emoji));
      keeps.add(thread.id);
    }
  }
  const plan = [];
  for (const thread of order) {
    const role = thread.id === effort.hawk ? "hawk" : "child";
    const keep = keeps.has(thread.id) || (thread.settledAt && splitTitle(thread.title).emoji);
    if (keep && String(thread.title).startsWith(`${titlePrefix(effort, thread.id)} `)) continue;
    const { emoji, text } = splitTitle(thread.title);
    const used = keep ? new Set([...claimed].filter((value) => value !== bare(emoji))) : claimed;
    const title = composeTitle({ effort, role, suggestion: keep ? thread.title : text, used, random });
    claimed.add(bare(splitTitle(title).emoji));
    plan.push({ thread: thread.id, from: thread.title, to: title });
  }
  return plan;
}

export const DEFAULT_PROFILES = {
  spawn: { provider: "claudeAgent", model: "claude-opus-5-5", options: ["effort=high"] },
  review: { provider: "codex", model: "gpt-6.1-sol", options: ["reasoningEffort=high", "serviceTier=default"] },
  send: { codex: ["reasoningEffort=high", "serviceTier=default"] },
};

export function profileFor(effort, kind, overrides = {}) {
  const base = { ...DEFAULT_PROFILES[kind], ...(effort?.[kind] ?? {}) };
  return {
    provider: overrides.provider ?? base.provider,
    model: overrides.model ?? base.model,
    options: overrides.options?.length ? overrides.options : base.options,
  };
}

export const providerArgs = (profile) => ["--provider", profile.provider, "--model", profile.model, ...profile.options.flatMap((option) => ["--option", option])];

export function sendOptionsFor(thread, table = DEFAULT_PROFILES.send) {
  const provider = thread?.modelSelection?.instanceId ?? thread?.provider ?? null;
  return table[provider] ?? [];
}

export function settlePlan(snapshot) {
  return Object.values(snapshot.conditions ?? {})
    .filter((condition) => condition.type === "thread.settleable")
    .map((condition) => ({ thread: condition.thread, title: condition.title, reason: condition.reason }))
    .sort((a, b) => a.thread.localeCompare(b.thread));
}

function threadState(thread) {
  if (thread.pendingInput) return "asking you";
  if (thread.lastError || thread.turn?.state === "error") return "errored";
  if (thread.turn?.state === "interrupted") return "interrupted";
  if (thread.turn?.state === "running") return "running";
  return thread.background ? `idle, background ${thread.background}` : "idle";
}

function prBlockers(pr) {
  const blockers = [];
  if (pr.isDraft) blockers.push("draft");
  if (pr.checks.state === "SUCCESS" && pr.isDraft && pr.checks.skipped > 0) blockers.push("CI skipped (draft)");
  else if (pr.checks.state === "FAILURE" || pr.checks.state === "ERROR") blockers.push(`CI red: ${pr.checks.failing.map((check) => check.name).join(", ")}`);
  else if (pr.checks.state !== "SUCCESS") blockers.push(`CI ${pr.checks.state.toLowerCase()}`);
  if (pr.mergeable === "CONFLICTING") blockers.push("conflicts");
  else if (pr.mergeable === "UNKNOWN") blockers.push("mergeability unknown");
  if (pr.mergeState === "BEHIND") blockers.push("behind main");
  if (pr.unresolvedThreads.length) blockers.push(`${pr.unresolvedThreads.length} open review thread${pr.unresolvedThreads.length === 1 ? "" : "s"}`);
  return blockers;
}

export function boardLines(snapshot) {
  const issueUrl = Object.fromEntries(snapshot.issues.map((issue) => [issue.key, issue.url]));
  const threads = Object.values(snapshot.threads);
  const ownerOf = Object.fromEntries(threads.filter((thread) => thread.pr).map((thread) => [thread.pr, thread]));
  const lines = [];
  for (const pr of Object.values(snapshot.prs).filter((pr) => pr.state === "OPEN").sort((a, b) => a.number - b.number)) {
    const owner = ownerOf[pr.number];
    const emoji = owner ? splitTitle(owner.title).emoji : null;
    const issues = pr.issueKeys.map((key) => (issueUrl[key] ? `[${key}](${issueUrl[key]})` : key)).join(", ");
    const status = isReady(pr) ? "**ready for you**" : prBlockers(pr).join(", ");
    const parts = [`${emoji ? `${emoji} ` : ""}[#${pr.number}](${pr.url}) ${pr.title}`, issues, status, owner ? `thread ${threadState(owner)}` : "no thread"];
    lines.push(`- ${parts.filter(Boolean).join(" · ")}`);
  }
  for (const thread of threads.filter((thread) => !thread.pr && thread.role !== "hawk" && !thread.settled)) {
    const { emoji, text } = splitTitle(thread.title);
    lines.push(`- ${emoji ? `${emoji} ` : ""}${text} · ${thread.role ?? "no PR"} · ${threadState(thread)}`);
  }
  return lines;
}

export function reviewBrief({ pr, focus = null }) {
  return [
    `Review PR #${pr.number} (${pr.url}), "${pr.title}", at ${pr.headRefOid}. This worktree is detached at that commit.`,
    "Read-only: do not edit files, commit, push, or comment on GitHub.",
    "Run `git fetch origin main` and then `git diff origin/main...HEAD` yourself.",
    focus ? `Focus: ${focus}` : "Focus: correctness, reuse of existing primitives, and whether the change matches its Linear issue.",
    "Report findings ranked P0–P3. Give each one a file:line, a concrete failure scenario, and a fix. Mark each as architecture-level (endpoints, state machines, data layer, package boundaries) or code-level. End with a one-line verdict.",
  ].join("\n");
}
