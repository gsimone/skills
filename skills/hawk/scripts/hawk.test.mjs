import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { boardLines, buildSnapshot, composeTitle, EMOJI_POOL, namingPlan, pickEmoji, reviewBrief, sendOptionsFor, settlePlan, splitTitle } from "./lib.mjs";

const HAWK = join(dirname(fileURLToPath(import.meta.url)), "hawk.mjs");
const REPO = "acme/app";
const effort = { slug: "fx", tag: "✉️ email", hawk: "h", repo: REPO, t3Project: "p", threads: [], reviewers: [] };
const first = () => 0;

describe("titles", () => {
  it("splitTitle strips effort groups and legacy prefixes, and keeps multi-codepoint emoji", () => {
    assert.deepEqual(splitTitle("[🔺 hawk // ✉️ email] 🐢 Assess #2"), { emoji: "🐢", text: "Assess #2" });
    assert.deepEqual(splitTitle("✉️ [email-composers] 🦊 old"), { emoji: "🦊", text: "old" });
    assert.deepEqual(splitTitle("[✉️ email] 🛡️ ENG-7"), { emoji: "🛡️", text: "ENG-7" });
    assert.deepEqual(splitTitle("🧑‍💻 dev"), { emoji: "🧑‍💻", text: "dev" });
    assert.deepEqual(splitTitle("Preview Task Email"), { emoji: null, text: "Preview Task Email" });
  });

  it("composeTitle adds the prefix, keeps a free suggested emoji, and replaces a taken one", () => {
    assert.equal(composeTitle({ effort, suggestion: "🐝 Preview", random: first }), "[✉️ email] 🐝 Preview");
    assert.equal(composeTitle({ effort, suggestion: "[✉️ email] 🐝 Preview", used: new Set(["🐝"]), random: first }), "[✉️ email] 🦚 Preview");
    assert.equal(composeTitle({ effort, role: "hawk", suggestion: "Assess", used: new Set(["🐝"]), random: first }), "[🔺 hawk // ✉️ email] 🦚 Assess");
    assert.throws(() => composeTitle({ effort: { slug: "x" }, suggestion: "a" }), /has no tag/);
  });

  it("pickEmoji treats the variation selector as the same emoji, and the pool has no bare halves", () => {
    assert.ok(EMOJI_POOL.includes("🐿️") && !EMOJI_POOL.includes("️"));
    const allButLast = new Set(EMOJI_POOL.slice(0, -1).map((emoji) => emoji.replace(/️/g, "")));
    assert.equal(pickEmoji(allButLast, first), EMOJI_POOL.at(-1));
  });

  it("namingPlan fixes missing prefixes and duplicate emoji; the oldest thread keeps its emoji", () => {
    const plan = namingPlan(effort, [
      { id: "a", title: "[✉️ email] 🐝 one", createdAt: "1" },
      { id: "b", title: "[✉️ email] 🐝 dup", createdAt: "2" },
      { id: "c", title: "Preview Task Email Before Sending", createdAt: "3" },
      { id: "h", title: "[✉️ email] 🐢 hawk", createdAt: "0" },
      { id: "d", title: "✉️ [email-composers] 🦊 old", createdAt: "4" },
    ], first);
    assert.deepEqual(Object.fromEntries(plan.map((step) => [step.thread, step.to])), {
      h: "[🔺 hawk // ✉️ email] 🐢 hawk",
      b: "[✉️ email] 🦚 dup",
      c: "[✉️ email] 🐙 Preview Task Email Before Sending",
      d: "[✉️ email] 🦊 old",
    });
    assert.deepEqual(namingPlan(effort, [{ id: "a", title: "[✉️ email] 🐝 one", createdAt: "1" }]), []);
  });

  it("a live thread keeps its emoji over a settled, replaced one, and settled threads are left alone", () => {
    const threads = [
      { id: "old", title: "[✉️ email] 🐝 Fix #42", createdAt: "1", settledAt: "x" },
      { id: "new", title: "[✉️ email] 🐝 #42 Preview→Confirm", createdAt: "2" },
      { id: "dead", title: "🦉 Fable review", createdAt: "0", settledAt: "x" },
    ];
    assert.deepEqual(namingPlan(effort, threads, first), [{ thread: "dead", from: "🦉 Fable review", to: "[✉️ email] 🦉 Fable review" }]);
  });

  it("the newest unsettled thread on a branch owns its PR, even after settling bumped an older one", () => {
    const issue = { identifier: "ENG-1", title: "t", url: "u", state: { type: "started" }, attachments: { nodes: [{ url: `https://github.com/${REPO}/pull/1` }] } };
    const pr = { number: 1, url: `https://github.com/${REPO}/pull/1`, title: "p", body: "Fixes ENG-1", state: "OPEN", isDraft: true, headRefName: "b", headRefOid: "s", mergeable: "MERGEABLE", reviewThreads: { nodes: [] } };
    const old = { id: "old", title: "🐝 old", branch: "b", createdAt: "2026-10-01", updatedAt: "2026-10-02T09:45", settledAt: "x", latestTurn: { turnId: "t", state: "error" } };
    const fresh = { id: "new", title: "🐝 new", branch: "b", createdAt: "2026-10-01T16:50", updatedAt: "2026-10-02T09:00", latestTurn: { turnId: "t", state: "completed" } };
    const snapshot = buildSnapshot({ effort, issues: [issue], prs: [pr], threads: [old, fresh], now: Date.now() });
    assert.equal(snapshot.threads.new.pr, 1);
    assert.equal(snapshot.threads.old.pr, null);
  });
});

describe("routing helpers", () => {
  it("codex threads always get high effort and the default tier; Claude threads get nothing", () => {
    assert.deepEqual(sendOptionsFor({ modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } }), ["reasoningEffort=high", "serviceTier=default"]);
    assert.deepEqual(sendOptionsFor({ modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" } }), []);
  });

  it("the review brief is read-only and asks for architecture vs code-level findings", () => {
    const brief = reviewBrief({ pr: { number: 42, url: "https://github.com/x/pull/42", title: "feat", headRefOid: "abc" }, focus: "reuse" });
    assert.match(brief, /Read-only/);
    assert.match(brief, /git diff origin\/main\.\.\.HEAD/);
    assert.match(brief, /Focus: reuse/);
    assert.match(brief, /architecture-level/);
  });

  it("boardLines names threads by emoji with GitHub and Linear links, and shows blockers or ready", () => {
    const checks = (state, skipped = 0) => ({ commits: { nodes: [{ commit: { statusCheckRollup: { state, contexts: { totalCount: 1 + skipped, nodes: [{ __typename: "CheckRun", name: "Checks", conclusion: state }, ...Array.from({ length: skipped }, () => ({ __typename: "CheckRun", name: "skip", conclusion: "SKIPPED" }))] } } } }] } });
    const pr = (number, extra) => ({ number, url: `https://github.com/${REPO}/pull/${number}`, title: `pr ${number}`, body: `Fixes ENG-${number}`, state: "OPEN", isDraft: false, headRefName: `b${number}`, headRefOid: `s${number}`, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewThreads: { nodes: [] }, ...checks("SUCCESS"), ...extra });
    const issue = (n) => ({ identifier: `ENG-${n}`, title: "t", url: `https://linear.app/x/issue/ENG-${n}`, state: { type: "started" }, attachments: { nodes: [{ url: `https://github.com/${REPO}/pull/${n}` }] } });
    const thread = (id, title, branch, extra = {}) => ({ id, title, branch, latestTurn: { turnId: "t", state: "completed" }, session: { status: "ready" }, createdAt: "1", updatedAt: "1", ...extra });
    const snapshot = buildSnapshot({
      effort: { ...effort, reviewers: ["r"] },
      issues: [issue(1), issue(2)],
      prs: [pr(1), pr(2, { isDraft: true, mergeable: "CONFLICTING", ...checks("SUCCESS", 3) })],
      threads: [thread("o1", "[✉️ email] 🎯 one", "b1"), thread("o2", "[✉️ email] 🐝 two", "b2", { latestTurn: { turnId: "t", state: "running" } }), thread("r", "[✉️ email] 🦚 Review #2", null)],
      now: Date.now(),
    });
    const lines = boardLines(snapshot);
    assert.equal(lines[0], `- 🎯 [#1](https://github.com/${REPO}/pull/1) pr 1 · [ENG-1](https://linear.app/x/issue/ENG-1) · **ready for you** · thread idle`);
    assert.match(lines[1], /^- 🐝 \[#2\].* · draft, CI skipped \(draft\), conflicts · thread running$/);
    assert.equal(lines[2], "- 🦚 Review #2 · reviewer · idle");
    assert.deepEqual(settlePlan(snapshot), [{ thread: "o1", title: "[✉️ email] 🎯 one", reason: "waits-on-human" }, { thread: "r", title: "[✉️ email] 🦚 Review #2", reason: "reviewer-done" }]);
  });
});

const FAKE_T3CLI = `#!/usr/bin/env node
const fs = require("node:fs");
const dir = process.env.FAKE_T3_DIR;
const argv = process.argv.slice(2);
const statePath = dir + "/state.json";
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const flag = (name) => argv[argv.indexOf(name) + 1];
const stdin = argv.includes("--stdin") ? fs.readFileSync(0, "utf8") : null;
fs.appendFileSync(dir + "/calls.ndjson", JSON.stringify({ argv, stdin }) + "\\n");
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
if (argv[0] === "list") return process.stdout.write(JSON.stringify({ threads: Object.values(state) }));
if (argv[0] === "show") return process.stdout.write(JSON.stringify(state[flag("--thread")] ?? null));
if (argv[0] === "start") {
  const id = "new-" + Object.keys(state).length;
  state[id] = { id, title: "Auto Generated Title", createdAt: "9", latestTurn: { turnId: "t1", state: "running" }, modelSelection: { instanceId: flag("--provider"), model: flag("--model") } };
  save();
  return process.stdout.write(JSON.stringify({ thread: { id } }));
}
if (argv[0] === "thread" && argv[1] === "update") { state[flag("--thread")].title = flag("--title"); save(); }
if (argv[0] === "thread" && argv[1] === "settle") { state[flag("--thread")].settledAt = "now"; save(); }
process.stdout.write("{}");
`;

function fixture(threads) {
  const root = mkdtempSync(join(tmpdir(), "hawk-cli-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "t3cli"), FAKE_T3CLI);
  chmodSync(join(bin, "t3cli"), 0o755);
  writeFileSync(join(root, "state.json"), JSON.stringify(Object.fromEntries(threads.map((thread) => [thread.id, thread]))));
  const stateDir = join(root, "desk");
  mkdirSync(join(stateDir, "fx"), { recursive: true });
  writeFileSync(join(stateDir, "fx", "effort.json"), JSON.stringify({ ...effort, threads: threads.map((thread) => thread.id).filter((id) => id !== "h") }));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_T3_DIR: root, HAWK_POLL_MS: "30", HAWK_TITLE_HOLD_POLLS: "2" };
  const hawk = (...argv) => execFileSync(process.execPath, [HAWK, ...argv, "--state-dir", stateDir], { encoding: "utf8", env, cwd: root });
  const calls = () => readFileSync(join(root, "calls.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const state = () => JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
  return { root, stateDir, env, hawk, calls, state };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return false;
}

function gitRepo(root) {
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  const git = (cwd, ...argv) => execFileSync("git", argv, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(root, "init", "--bare", "-b", "main", origin);
  git(root, "clone", origin, repo);
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init");
  git(repo, "push", "origin", "main");
  return { repo, git };
}

describe("hawk.mjs", () => {
  it("name picks an emoji no effort thread uses", () => {
    const fx = fixture([{ id: "a", title: "[✉️ email] 🐝 one", createdAt: "1" }]);
    const { title } = JSON.parse(fx.hawk("name", "--effort", "fx", "--json", "🐝 Preview before send"));
    assert.match(title, /^\[✉️ email\] (?!🐝)\S+ Preview before send$/u);
  });

  it("names is a dry run until --apply", () => {
    const fx = fixture([{ id: "a", title: "Preview Task Email", createdAt: "1" }, { id: "h", title: "[🔺 hawk // ✉️ email] 🐢 hawk", createdAt: "0" }]);
    assert.match(fx.hawk("names", "--effort", "fx"), /would rename a: "Preview Task Email" -> "\[✉️ email\] \S+ Preview Task Email"/u);
    assert.equal(fx.state().a.title, "Preview Task Email");
    fx.hawk("names", "--effort", "fx", "--apply");
    assert.match(fx.state().a.title, /^\[✉️ email\] \S+ Preview Task Email$/u);
    assert.match(fx.hawk("names", "--effort", "fx"), /all titles carry/);
  });

  it("send adds the codex options on every message", () => {
    const fx = fixture([{ id: "r", title: "[✉️ email] 🦚 Review", modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } }]);
    fx.hawk("send", "--thread", "r", "re-check the fix");
    const send = fx.calls().find((call) => call.argv[0] === "send");
    assert.deepEqual(send.argv, ["send", "--thread", "r", "--stdin", "--option", "reasoningEffort=high", "--option", "serviceTier=default", "--format", "json"]);
    assert.equal(send.stdin, "re-check the fix");
  });

  it("spawn makes a --no-track worktree, starts the thread, registers it, and re-applies the title t3code replaced", async () => {
    const fx = fixture([{ id: "h", title: "[🔺 hawk // ✉️ email] 🐢 hawk", createdAt: "0", latestTurn: { turnId: "x", state: "completed" } }]);
    const { repo, git } = gitRepo(fx.root);
    writeFileSync(join(fx.root, "brief.md"), "Do the thing.");
    const out = JSON.parse(fx.hawk("spawn", "--effort", "fx", "--title", "Split #42", "--brief-file", join(fx.root, "brief.md"), "--repo-dir", repo, "--worktree-root", join(fx.root, "wt"), "--json"));
    assert.match(out.title, /^\[✉️ email\] \S+ Split #42$/u);
    assert.throws(() => git(out.worktree, "rev-parse", "--abbrev-ref", "@{u}"), "the worktree branch must not track origin/main");
    const start = fx.calls().find((call) => call.argv[0] === "start");
    assert.equal(start.stdin, "Do the thing.");
    assert.ok(start.argv.includes("--no-track") === false && start.argv.includes(out.worktree));
    const registered = JSON.parse(readFileSync(join(fx.stateDir, "fx", "effort.json"), "utf8"));
    assert.ok(registered.threads.includes(out.thread));
    assert.ok(await until(() => fx.state()[out.thread].title === out.title), "retitle watcher re-applied the title");
    assert.ok(existsSync(join(fx.stateDir, "fx", "watch", `rearm-${out.thread}.pid`)), "callback armed");
    execFileSync(process.execPath, [join(dirname(HAWK), "watch.mjs"), "stop", "--effort", "fx", "--state-dir", fx.stateDir], { env: fx.env });
  });

  it("review dry-run uses the default reviewer profile on a detached worktree at the PR head", () => {
    const fx = fixture([]);
    const gh = join(fx.root, "bin", "gh");
    writeFileSync(gh, `#!/bin/sh\necho '{"number":42,"url":"https://github.com/${REPO}/pull/42","title":"feat","headRefOid":"0123456789abcdef","headRefName":"t3code/x"}'\n`);
    chmodSync(gh, 0o755);
    const plan = JSON.parse(fx.hawk("review", "--effort", "fx", "--pr", "42", "--dry-run", "--json", "--worktree-root", "/tmp"));
    assert.deepEqual(plan.provider, ["--provider", "codex", "--model", "gpt-6.1-sol", "--option", "reasoningEffort=high", "--option", "serviceTier=default"]);
    assert.equal(plan.worktree, "/tmp/fx-review-42-01234567");
    assert.match(plan.title, /^\[✉️ email\] \S+ Review #42 \(gpt-6\.1-sol\)$/u);
  });

  it("effort.json profiles replace the defaults, and flags replace both", () => {
    const fx = fixture([]);
    const effortPath = join(fx.stateDir, "fx", "effort.json");
    writeFileSync(effortPath, JSON.stringify({ ...JSON.parse(readFileSync(effortPath, "utf8")), review: { provider: "claudeAgent", model: "claude-fable-5-1", options: ["effort=max"] } }));
    const gh = join(fx.root, "bin", "gh");
    writeFileSync(gh, `#!/bin/sh\necho '{"number":7,"url":"https://github.com/${REPO}/pull/7","title":"feat","headRefOid":"abcdef0123456789","headRefName":"x"}'\n`);
    chmodSync(gh, 0o755);
    const fromEffort = JSON.parse(fx.hawk("review", "--effort", "fx", "--pr", "7", "--dry-run", "--json"));
    assert.deepEqual(fromEffort.provider, ["--provider", "claudeAgent", "--model", "claude-fable-5-1", "--option", "effort=max"]);
    const fromFlags = JSON.parse(fx.hawk("review", "--effort", "fx", "--pr", "7", "--dry-run", "--json", "--model", "claude-opus-5-5", "--option", "effort=high"));
    assert.deepEqual(fromFlags.provider, ["--provider", "claudeAgent", "--model", "claude-opus-5-5", "--option", "effort=high"]);
  });

  it("settle sweeps only with --apply", () => {
    const thread = { id: "r", title: "[✉️ email] 🦚 Review", createdAt: "1", updatedAt: "1", latestTurn: { turnId: "t", state: "completed" }, session: { status: "ready" } };
    const fx = fixture([thread]);
    const snapshot = buildSnapshot({ effort: { ...effort, reviewers: ["r"] }, issues: [], prs: [], threads: [thread], now: Date.now() });
    writeFileSync(join(fx.stateDir, "fx", "snapshot.json"), JSON.stringify(snapshot));
    assert.match(fx.hawk("settle", "--effort", "fx"), /would settle: \[✉️ email\] 🦚 Review \(reviewer-done\)/u);
    assert.equal(fx.state().r.settledAt, undefined);
    assert.match(fx.hawk("settle", "--effort", "fx", "--apply"), /^settled: /);
    assert.equal(fx.state().r.settledAt, "now");
  });
});
