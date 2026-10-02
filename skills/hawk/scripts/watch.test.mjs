import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const WATCH = join(dirname(fileURLToPath(import.meta.url)), "watch.mjs");
const FAKE_T3CLI = `#!/usr/bin/env node
const fs = require("node:fs");
const dir = process.env.FAKE_T3_DIR;
const argv = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(dir + "/state.json", "utf8"));
const flag = (name) => argv[argv.indexOf(name) + 1];
if (argv[0] === "show") { process.stdout.write(JSON.stringify(state[flag("--thread")] ?? null)); process.exit(0); }
if (argv[0] === "list") { process.stdout.write(JSON.stringify({ threads: [] })); process.exit(0); }
const stdin = argv.includes("--stdin") ? fs.readFileSync(0, "utf8") : null;
fs.appendFileSync(dir + "/calls.ndjson", JSON.stringify({ argv, stdin, threadEnv: process.env.T3CODE_THREAD_ID ?? null }) + "\\n");
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hawk-watch-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "t3cli"), FAKE_T3CLI);
  chmodSync(join(bin, "t3cli"), 0o755);
  const stateDir = join(root, "desk");
  mkdirSync(join(stateDir, "fx"), { recursive: true });
  const effort = (hawk) => writeFileSync(join(stateDir, "fx", "effort.json"), JSON.stringify({ slug: "fx", t3Project: "p", hawk, threads: [] }));
  const state = (value) => writeFileSync(join(root, "state.json"), JSON.stringify(value));
  const calls = () => (existsSync(join(root, "calls.ndjson")) ? readFileSync(join(root, "calls.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_T3_DIR: root, HAWK_POLL_MS: "40", T3CODE_THREAD_ID: "h1" };
  const run = (...argv) => execFileSync(process.execPath, [WATCH, ...argv, "--effort", "fx", "--state-dir", stateDir], { encoding: "utf8", env });
  return { root, stateDir, effort, state, calls, run };
}

async function until(predicate, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return false;
}

const child = (turnId, state, extra = {}) => ({ id: "c", title: "[fx] 🐝 child", latestTurn: { turnId, state }, ...extra });

describe("watch.mjs", () => {
  it("rearm follows a takeover, holds while the new hawk has an open question, then delivers once", async () => {
    const fx = fixture();
    fx.effort("h1");
    fx.state({ c: child("t2", "running"), h1: { hasPendingUserInput: false }, h2: { hasPendingUserInput: true } });
    const armed = fx.run("rearm", "--thread", "c");
    assert.match(armed, /rearm-c pid \d+/);

    fx.effort("h2");
    fx.state({ c: child("t2", "completed"), h1: { hasPendingUserInput: false }, h2: { hasPendingUserInput: true } });
    await sleep(300);
    assert.deepEqual(fx.calls(), []);
    assert.match(readFileSync(join(fx.stateDir, "fx", "watch", "rearm-c.log"), "utf8"), /has an open question; holding delivery/);

    fx.state({ c: child("t2", "completed"), h1: { hasPendingUserInput: false }, h2: { hasPendingUserInput: false } });
    assert.ok(await until(() => fx.calls().length > 0));
    await sleep(200);
    const calls = fx.calls();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].argv.slice(0, 4), ["send", "--thread", "h2", "--force"]);
    assert.equal(calls[0].threadEnv, null);
    assert.match(calls[0].stdin, /"\[fx\] 🐝 child" \(c\) ended turn t2 \(completed\)/);
    assert.ok(await until(() => !existsSync(join(fx.stateDir, "fx", "watch", "rearm-c.pid"))));
  });

  it("rearm on an idle child waits for its next turn, and re-arming replaces the old watcher", async () => {
    const fx = fixture();
    fx.effort("h1");
    fx.state({ c: child("t1", "completed"), h1: {} });
    fx.run("rearm", "--thread", "c");
    const second = fx.run("rearm", "--thread", "c");
    assert.match(second, /replaced rearm-c/);
    await sleep(250);
    assert.deepEqual(fx.calls(), []);
    fx.state({ c: child("t2", "completed"), h1: {} });
    assert.ok(await until(() => fx.calls().length > 0));
    await sleep(200);
    assert.equal(fx.calls().length, 1);
  });

  it("wake sends the prompt file to the current hawk", async () => {
    const fx = fixture();
    fx.effort("h1");
    fx.state({ h1: {} });
    const prompt = join(fx.root, "wake.md");
    writeFileSync(prompt, "⏰ wake-up: resume dead threads");
    fx.run("wake", "--in", "0.002", "--prompt-file", prompt);
    assert.ok(await until(() => fx.calls().length > 0));
    assert.equal(fx.calls()[0].stdin, "⏰ wake-up: resume dead threads");
  });
});
