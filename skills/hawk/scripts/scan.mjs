#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildSnapshot, diffEvents, formatEvent, prNumberFromUrl, summaryLine, titlePrefix } from "./lib.mjs";
import { listThreads } from "./t3.mjs";

const USAGE = `usage:
  scan.mjs --effort <slug> [--baseline] [--json] [--state-dir <dir>]
  scan.mjs --effort <slug> --init --linear-project <uuid> --repo <owner/name> --t3-project <t3code project id> [--tag "<emoji> <name>"] [--hawk <thread id|self>]
  scan.mjs --effort <slug> --register-thread <t3code thread id> [--reviewer]
  scan.mjs --effort <slug> --set-hawk <thread id|self>
  scan.mjs --effort <slug> --set-tag "<emoji> <name>"

--baseline  write the snapshot without emitting events (first run on an effort with history)
--json      print the new events as JSON lines instead of the summary line
--set-hawk  record the thread on hawk duty; "self" resolves T3CODE_THREAD_ID, else the thread whose worktree holds the cwd
exit: 0 ok, 2 error, 3 another scan holds the lock`;

const { values: args } = parseArgs({
  options: {
    effort: { type: "string" },
    init: { type: "boolean", default: false },
    "linear-project": { type: "string" },
    repo: { type: "string" },
    "t3-project": { type: "string" },
    "register-thread": { type: "string" },
    reviewer: { type: "boolean", default: false },
    tag: { type: "string" },
    hawk: { type: "string" },
    "set-hawk": { type: "string" },
    "set-tag": { type: "string" },
    baseline: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    "state-dir": { type: "string", default: join(homedir(), ".t3", "desk") },
    help: { type: "boolean", default: false },
  },
});

function fail(message, code = 2) {
  process.stderr.write(`scan: ${message}\n`);
  process.exit(code);
}

if (args.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
if (!args.effort || !/^[a-z0-9][a-z0-9-]*$/.test(args.effort)) fail(`--effort <slug> is required (lowercase, digits, dashes)\n${USAGE}`);

const dir = join(args["state-dir"], args.effort);
const effortPath = join(dir, "effort.json");
const snapshotPath = join(dir, "snapshot.json");
const eventsPath = join(dir, "events.ndjson");
const lockPath = join(dir, "scan.lock");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
function writeJsonAtomic(path, value) {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

function resolveThread(value, project) {
  if (value !== "self") return value;
  if (process.env.T3CODE_THREAD_ID) return process.env.T3CODE_THREAD_ID;
  let root;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    fail("--set-hawk self: T3CODE_THREAD_ID is empty and the cwd is not a git worktree. pass the thread id");
  }
  const matches = listThreads(project).filter((thread) => !thread.archivedAt && thread.worktreePath === root);
  if (matches.length !== 1) fail(`--set-hawk self: ${matches.length} threads use worktree ${root}. pass the thread id`);
  return matches[0].id;
}

if (args.init) {
  if (!args["linear-project"] || !args.repo || !args["t3-project"]) fail("--init needs --linear-project <uuid>, --repo <owner/name>, and --t3-project <id> (see: t3cli project list)");
  if (existsSync(effortPath)) fail(`${effortPath} already exists; edit it or pick another slug`);
  mkdirSync(dir, { recursive: true });
  const hawk = args.hawk ? resolveThread(args.hawk, args["t3-project"]) : null;
  writeJsonAtomic(effortPath, { slug: args.effort, linearProjectId: args["linear-project"], repo: args.repo, t3Project: args["t3-project"], tag: args.tag ?? null, hawk, threads: [], reviewers: [] });
  process.stdout.write(`created ${effortPath}. next: scan.mjs --effort ${args.effort} --baseline\n`);
  process.exit(0);
}

if (!existsSync(effortPath)) fail(`${effortPath} not found. run: scan.mjs --effort ${args.effort} --init --linear-project <uuid> --repo <owner/name> --t3-project <id>`);
const effort = readJson(effortPath);
if (!effort.t3Project) fail(`${effortPath} has no "t3Project". add the t3code project id (see: t3cli project list)`);

if (args["register-thread"]) {
  const field = args.reviewer ? "reviewers" : "threads";
  const ids = new Set(effort[field] ?? []);
  ids.add(args["register-thread"]);
  writeJsonAtomic(effortPath, { ...effort, [field]: [...ids] });
  process.stdout.write(`registered ${args["register-thread"]} on ${args.effort}${args.reviewer ? " as a reviewer" : ""}\n`);
  process.exit(0);
}

if (args["set-hawk"]) {
  const hawk = resolveThread(args["set-hawk"], effort.t3Project);
  writeJsonAtomic(effortPath, { ...effort, hawk });
  const prefix = titlePrefix({ ...effort, hawk }, hawk);
  process.stdout.write(`hawk for ${args.effort} is now ${hawk} (was ${effort.hawk ?? "none"})${prefix ? `. its title must start with ${prefix}` : ""}\n`);
  process.exit(0);
}

if (args["set-tag"]) {
  writeJsonAtomic(effortPath, { ...effort, tag: args["set-tag"] });
  process.stdout.write(`tag for ${args.effort} is now [${args["set-tag"]}]\n`);
  process.exit(0);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  try {
    mkdirSync(lockPath);
  } catch {
    const pidFile = join(lockPath, "pid");
    const holder = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim() || 0) : 0;
    if (holder && pidAlive(holder)) fail(`scan already running (pid ${holder})`, 3);
    rmSync(lockPath, { recursive: true, force: true });
    mkdirSync(lockPath);
  }
  writeFileSync(join(lockPath, "pid"), String(process.pid));
}

function linearKey() {
  if (process.env.LINEAR_API_KEY) return process.env.LINEAR_API_KEY.trim();
  const path = join(homedir(), ".config", "linear", "api_key");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  fail(`no Linear key: set LINEAR_API_KEY or write one to ${path}`);
}

async function linearIssues(projectId) {
  const key = linearKey();
  const query = `query($id: String!, $after: String) { project(id: $id) { issues(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { identifier title url priority state { type name } attachments { nodes { url } } } } } }`;
  const issues = [];
  let after = null;
  for (;;) {
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { Authorization: key, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { id: projectId, after } }),
    });
    const body = await response.json();
    if (body.errors || !body.data?.project) fail(`Linear: ${JSON.stringify(body.errors ?? "project not found")}`);
    const page = body.data.project.issues;
    issues.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return issues;
    after = page.pageInfo.endCursor;
  }
}

const PR_FIELDS = `number url title body state isDraft headRefName headRefOid mergeable mergeStateStatus reviewDecision
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { totalCount nodes {
    __typename ... on CheckRun { name status conclusion detailsUrl } ... on StatusContext { context state targetUrl } } } } } } }
  reviewThreads(first: 100) { nodes { id isResolved comments(first: 1) { nodes { author { login } url } } } }`;

function gh(query) {
  const out = execFileSync("gh", ["api", "graphql", "-f", `query=${query}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out).data.repository;
}

function fetchPrs(repo, numbers, branches) {
  const [owner, name] = repo.split("/");
  const prs = new Map();
  const numberList = [...numbers];
  for (let start = 0; start < numberList.length; start += 20) {
    const chunk = numberList.slice(start, start + 20);
    const fields = chunk.map((number) => `pr${number}: pullRequest(number: ${number}) { ${PR_FIELDS} }`).join("\n");
    const repository = gh(`query { repository(owner: "${owner}", name: "${name}") { ${fields} } }`);
    for (const pr of Object.values(repository)) if (pr) prs.set(pr.number, pr);
  }
  const branchList = [...branches];
  for (let start = 0; start < branchList.length; start += 20) {
    const chunk = branchList.slice(start, start + 20);
    const fields = chunk
      .map((branch, index) => `b${index}: pullRequests(headRefName: ${JSON.stringify(branch)}, first: 1, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } }`)
      .join("\n");
    const repository = gh(`query { repository(owner: "${owner}", name: "${name}") { ${fields} } }`);
    for (const connection of Object.values(repository)) for (const pr of connection?.nodes ?? []) prs.set(pr.number, pr);
  }
  return [...prs.values()];
}

function upstreamOf(worktreePath) {
  if (!worktreePath || !existsSync(worktreePath)) return null;
  try {
    return execFileSync("git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

acquireLock();
try {
  const now = Date.now();
  const prev = existsSync(snapshotPath) ? readJson(snapshotPath) : null;
  const [issues, threads] = await Promise.all([linearIssues(effort.linearProjectId), Promise.resolve(listThreads(effort.t3Project))]);

  const registered = new Set([...(effort.threads ?? []), ...(effort.reviewers ?? []), ...(effort.hawk ? [effort.hawk] : [])]);
  const attachedNumbers = new Set(
    issues.flatMap((issue) => (issue.attachments?.nodes ?? []).map((attachment) => prNumberFromUrl(attachment.url, effort.repo))).filter((number) => number !== null),
  );
  const registeredBranches = new Set(threads.filter((thread) => registered.has(thread.id) && thread.branch).map((thread) => thread.branch));
  const prs = fetchPrs(effort.repo, attachedNumbers, registeredBranches);

  const prBranches = new Set(prs.map((pr) => pr.headRefName));
  const upstreams = {};
  for (const thread of threads) {
    if (thread.archivedAt || !(registered.has(thread.id) || prBranches.has(thread.branch))) continue;
    upstreams[thread.id] = upstreamOf(thread.worktreePath);
  }

  const snapshot = buildSnapshot({ effort, issues, prs, threads, upstreams, prev, now });
  const events = args.baseline ? [] : diffEvents(prev, snapshot);
  writeJsonAtomic(snapshotPath, snapshot);
  if (events.length) appendFileSync(eventsPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n");

  if (args.json) {
    for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
  } else {
    process.stdout.write(`${summaryLine(snapshot, events)}${args.baseline ? " [baseline]" : ""}\n`);
    for (const event of events) process.stdout.write(`- ${formatEvent(event)}\n`);
  }
} catch (error) {
  fail(error?.stack ?? String(error));
} finally {
  rmSync(lockPath, { recursive: true, force: true });
}
