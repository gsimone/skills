#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { armedAfter, callbackPrompt, holdDelivery, watchVerdict } from "./lib.mjs";
import { listThreads, setTitle, settleThread, showThread as show, t3 } from "./t3.mjs";

const USAGE = `usage:
  watch.mjs rearm  --effort <slug> --thread <child id> [--after <turn id>] [--note <text>]
  watch.mjs wake   --effort <slug> --in <minutes> --prompt-file <path>
  watch.mjs settle --effort <slug> --thread <id>
  watch.mjs retitle --effort <slug> --thread <id> --title <title>
  watch.mjs list   --effort <slug>
  watch.mjs stop   --effort <slug> [--thread <id>]

rearm   when the child ends a turn or asks a question that the hawk has not seen, send the standard
        callback to the effort's current hawk. --after <turn id> marks that turn as seen; the default
        marks what the child shows now (its idle turn, or its open question). One rearm per child.
wake    after <minutes>, send the prompt file to the effort's current hawk.
settle  settle the thread once its turn stops running.
retitle keep re-applying <title> until it has held for 2 minutes after the first turn started
        (t3code replaces a thread's title on its first turn).
Every delivery reads the hawk from effort.json when it fires and waits while the hawk has an open question.
Watchers detach by themselves. State and logs: <state-dir>/<slug>/watch/.`;

const [command, ...rest] = process.argv.slice(2);
const { values: args } = parseArgs({
  args: rest,
  options: {
    effort: { type: "string" },
    thread: { type: "string" },
    after: { type: "string" },
    note: { type: "string" },
    in: { type: "string" },
    "prompt-file": { type: "string" },
    title: { type: "string" },
    attached: { type: "boolean", default: false },
    "state-dir": { type: "string", default: join(homedir(), ".t3", "desk") },
  },
});

function fail(message) {
  process.stderr.write(`watch: ${message}\n`);
  process.exit(2);
}

if (!["rearm", "wake", "settle", "retitle", "list", "stop"].includes(command)) fail(`unknown command ${command ?? "(none)"}\n${USAGE}`);
if (!args.effort) fail(`--effort <slug> is required\n${USAGE}`);

const effortDir = join(args["state-dir"], args.effort);
const effortPath = join(effortDir, "effort.json");
const watchDir = join(effortDir, "watch");
if (!existsSync(effortPath)) fail(`${effortPath} not found. run scan.mjs --init first`);
mkdirSync(watchDir, { recursive: true });

const POLL_MS = Number(process.env.HAWK_POLL_MS ?? 20_000);
const LIMIT_MS = { rearm: 8 * 3_600_000, settle: 2 * 3_600_000, wake: 24 * 3_600_000, retitle: 3_600_000 };
const TITLE_HOLD_POLLS = Number(process.env.HAWK_TITLE_HOLD_POLLS ?? 6);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => process.stdout.write(`${new Date().toISOString()} ${message}\n`);
const short = (id) => String(id).slice(0, 8);

function backgroundOf(threadId, project) {
  try {
    return listThreads(project).find((thread) => thread.id === threadId)?.backgroundLiveness ?? null;
  } catch {
    return null;
  }
}

const readEffort = () => JSON.parse(readFileSync(effortPath, "utf8"));

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function watchers() {
  return readdirSync(watchDir)
    .filter((name) => name.endsWith(".pid"))
    .map((name) => ({ name: name.slice(0, -4), pid: Number(readFileSync(join(watchDir, name), "utf8").trim()) }))
    .filter((watcher) => {
      if (pidAlive(watcher.pid)) return true;
      rmSync(join(watchDir, `${watcher.name}.pid`), { force: true });
      return false;
    });
}

async function deliver(prompt) {
  for (;;) {
    const hawkId = readEffort().hawk;
    if (!hawkId) fail(`effort.json has no hawk. run scan.mjs --effort ${args.effort} --set-hawk self`);
    if (!holdDelivery(show(hawkId))) {
      t3(["send", "--thread", hawkId, "--force", "--stdin", "--format", "json"], prompt);
      log(`delivered to hawk ${hawkId}`);
      return;
    }
    log(`hawk ${short(hawkId)} has an open question; holding delivery`);
    await sleep(POLL_MS);
  }
}

async function runAttached(name) {
  const pidPath = join(watchDir, `${name}.pid`);
  writeFileSync(pidPath, String(process.pid));
  const deadline = Date.now() + LIMIT_MS[command];
  try {
    if (command === "wake") {
      const minutes = Number(args.in);
      await sleep(minutes * 60_000);
      await deliver(readFileSync(args["prompt-file"], "utf8"));
      return;
    }
    let held = 0;
    while (Date.now() < deadline) {
      const child = show(args.thread);
      if (command === "retitle" && child) {
        if (child.title !== args.title) {
          setTitle(args.thread, args.title);
          log(`retitled from "${child.title}"`);
          held = 0;
        } else if (child.latestTurn && ++held >= TITLE_HOLD_POLLS) {
          log("title held");
          return;
        }
      }
      if (command === "rearm" && child && watchVerdict(child, args.after) === "deliver") {
        const background = backgroundOf(args.thread, readEffort().t3Project);
        await deliver(callbackPrompt({ slug: args.effort, child, background, note: args.note ?? null }));
        return;
      }
      if (command === "settle" && child && child.latestTurn?.state !== "running" && !child.hasPendingUserInput) {
        settleThread(args.thread);
        log(`settled ${args.thread}`);
        return;
      }
      await sleep(POLL_MS);
    }
    log(`timed out after ${LIMIT_MS[command] / 3_600_000} h`);
  } finally {
    if (existsSync(pidPath) && readFileSync(pidPath, "utf8").trim() === String(process.pid)) rmSync(pidPath, { force: true });
  }
}

if (command === "list") {
  for (const watcher of watchers()) process.stdout.write(`${watcher.name} pid ${watcher.pid}\n`);
  process.exit(0);
}

if (command === "stop") {
  for (const watcher of watchers()) {
    if (args.thread && !watcher.name.endsWith(args.thread)) continue;
    process.kill(watcher.pid, "SIGTERM");
    rmSync(join(watchDir, `${watcher.name}.pid`), { force: true });
    process.stdout.write(`stopped ${watcher.name} pid ${watcher.pid}\n`);
  }
  process.exit(0);
}

if (["rearm", "settle", "retitle"].includes(command) && !args.thread) fail(`${command} needs --thread <id>`);
if (command === "retitle" && !args.title) fail("retitle needs --title <title>");
if (command === "wake" && (!(Number(args.in) > 0) || !args["prompt-file"] || !existsSync(args["prompt-file"]))) fail("wake needs --in <minutes> and an existing --prompt-file");
if (!readEffort().hawk && (command === "rearm" || command === "wake")) fail(`effort.json has no hawk. run scan.mjs --effort ${args.effort} --set-hawk self`);

const name = command === "wake" ? `wake-${Date.now()}` : `${command}-${args.thread}`;

if (args.attached) {
  await runAttached(name);
  process.exit(0);
}

let after = args.after;
if (command === "rearm" && after === undefined) {
  const child = show(args.thread);
  if (!child) fail(`t3cli show --thread ${args.thread} failed`);
  after = armedAfter(child);
}
for (const watcher of watchers()) {
  if (watcher.name !== name) continue;
  process.kill(watcher.pid, "SIGTERM");
  log(`replaced ${name} pid ${watcher.pid}`);
}
const logPath = join(watchDir, `${name}.log`);
const out = openSync(logPath, "a");
const argv = [fileURLToPath(import.meta.url), command, ...rest, "--attached", ...(command === "rearm" && args.after === undefined ? ["--after", after] : [])];
const child = spawn(process.execPath, argv, { detached: true, stdio: ["ignore", out, out] });
child.unref();
writeFileSync(join(watchDir, `${name}.pid`), String(child.pid));
const when = { wake: `in ${args.in} min`, rearm: `on the next turn end or question after ${after || "now"}`, settle: "when idle", retitle: "until the title holds" }[command];
process.stdout.write(`${name} pid ${child.pid}, fires ${when}. log: ${logPath}\n`);
