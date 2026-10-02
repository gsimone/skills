#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { boardLines, composeTitle, DEFAULT_PROFILES, emojisInUse, namingPlan, profileFor, providerArgs, reviewBrief, sendOptionsFor, settlePlan, splitTitle } from "./lib.mjs";
import { listThreads, setTitle, settleThread, showThread, startedThreadId, t3 } from "./t3.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const USAGE = `usage: hawk.mjs <command> [flags]   (every command takes --json; sweeps change nothing without --apply)

  name    --effort <slug> [--role child|hawk] "<suggested title>"   print the effort title, with a free emoji
  names   --effort <slug> [--apply]                                 naming pass over the effort's live threads
  spawn   --effort <slug> --title "<suggested>" --brief-file <path> [--base origin/main] [--dry-run]
          worktree with --no-track, start the thread, register it, hold its title, arm its callback
  review  --effort <slug> --pr <number> [--focus "<text>"] [--dry-run]
          reviewer thread on a detached worktree at the PR head, registered as a reviewer, callback armed
  send    --thread <id> [--effort <slug>] (--stdin | "<message>")   t3cli send with the options the thread's provider needs
  settle  --effort <slug> [--apply]                                 settle sweep from the last scan
  board   --effort <slug>                                           report lines with GitHub and Linear links, from the last scan
  scan …  | watch …                                                 run scan.mjs or watch.mjs

  spawn and review take [--provider <id>] [--model <id>] [--option key=value]… over the effort.json
  "spawn" / "review" profile, over the defaults:
    spawn  ${JSON.stringify(DEFAULT_PROFILES.spawn)}
    review ${JSON.stringify(DEFAULT_PROFILES.review)}
    send   ${JSON.stringify(DEFAULT_PROFILES.send)} (per provider; effort.json "send" replaces it)`;

const [command, ...rest] = process.argv.slice(2);

if (command === "scan" || command === "watch") {
  const result = spawnSync(process.execPath, [join(HERE, `${command}.mjs`), ...rest], { stdio: "inherit" });
  process.exit(result.status ?? 2);
}

const { values: args, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    effort: { type: "string" },
    role: { type: "string", default: "child" },
    apply: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    title: { type: "string" },
    "brief-file": { type: "string" },
    base: { type: "string", default: "origin/main" },
    provider: { type: "string" },
    model: { type: "string" },
    option: { type: "string", multiple: true },
    pr: { type: "string" },
    focus: { type: "string" },
    thread: { type: "string" },
    stdin: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    "repo-dir": { type: "string" },
    "worktree-root": { type: "string" },
    "state-dir": { type: "string", default: join(homedir(), ".t3", "desk") },
    help: { type: "boolean", default: false },
  },
});

function fail(message) {
  process.stderr.write(`hawk: ${message}\n`);
  process.exit(2);
}

if (!command || args.help || command === "help") {
  process.stdout.write(`${USAGE}\n`);
  process.exit(command ? 0 : 2);
}

const emit = (value, text) => process.stdout.write(args.json ? `${JSON.stringify(value)}\n` : `${text}\n`);
const run = (file, argv, options = {}) => execFileSync(file, argv, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...options });
const node = (script, argv) => run(process.execPath, [join(HERE, script), ...argv, "--state-dir", args["state-dir"]]);

function loadEffort() {
  if (!args.effort) fail(`${command} needs --effort <slug>`);
  const path = join(args["state-dir"], args.effort, "effort.json");
  if (!existsSync(path)) fail(`${path} not found. run: hawk.mjs scan --effort ${args.effort} --init …`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadSnapshot() {
  const path = join(args["state-dir"], args.effort, "snapshot.json");
  if (!existsSync(path)) fail(`${path} not found. run: hawk.mjs scan --effort ${args.effort}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function effortThreads(effort) {
  const snapshotPath = join(args["state-dir"], effort.slug, "snapshot.json");
  const snapshotIds = existsSync(snapshotPath) ? Object.keys(JSON.parse(readFileSync(snapshotPath, "utf8")).threads ?? {}) : [];
  const ids = new Set([...(effort.threads ?? []), ...(effort.reviewers ?? []), ...(effort.hawk ? [effort.hawk] : []), ...snapshotIds]);
  return listThreads(effort.t3Project).filter((thread) => ids.has(thread.id) && !thread.archivedAt);
}

function repoDir() {
  if (args["repo-dir"]) return args["repo-dir"];
  try {
    return dirname(run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim());
  } catch {
    fail("run from inside the repo, or pass --repo-dir <path>");
  }
}

const overrides = () => ({ provider: args.provider, model: args.model, options: args.option ?? [] });

function startThread({ effort, title, worktree, brief, providerArgs }) {
  const argv = ["start", "--stdin", "--project", effort.t3Project, "--worktree", worktree, "--title", title, ...providerArgs, "--format", "json"];
  const id = startedThreadId(t3(argv, brief));
  if (!id) fail("t3cli start returned no thread id");
  return id;
}

function adopt({ effort, id, title, reviewer }) {
  node("scan.mjs", ["--effort", effort.slug, "--register-thread", id, ...(reviewer ? ["--reviewer"] : [])]);
  node("watch.mjs", ["retitle", "--effort", effort.slug, "--thread", id, "--title", title]);
  if (effort.hawk) node("watch.mjs", ["rearm", "--effort", effort.slug, "--thread", id]);
}

try {
  switch (command) {
    case "name": {
      const effort = loadEffort();
      const suggestion = positionals.join(" ");
      if (!suggestion) fail('name needs a suggested title: hawk.mjs name --effort <slug> "<title>"');
      if (!["child", "hawk"].includes(args.role)) fail("--role is child or hawk");
      const title = composeTitle({ effort, role: args.role, suggestion, used: emojisInUse(effortThreads(effort)) });
      emit({ title, emoji: splitTitle(title).emoji }, title);
      break;
    }

    case "names": {
      const effort = loadEffort();
      const plan = namingPlan(effort, effortThreads(effort));
      for (const step of plan) {
        if (args.apply) setTitle(step.thread, step.to);
        emit({ ...step, applied: args.apply }, `${args.apply ? "renamed" : "would rename"} ${step.thread}: "${step.from}" -> "${step.to}"`);
      }
      if (!plan.length) emit({ ok: true }, "all titles carry the effort prefix and a unique emoji");
      break;
    }

    case "spawn": {
      const effort = loadEffort();
      if (!args.title || !args["brief-file"]) fail("spawn needs --title and --brief-file");
      const brief = readFileSync(args["brief-file"], "utf8");
      const repo = repoDir();
      const hex = randomBytes(4).toString("hex");
      const worktree = join(args["worktree-root"] ?? join(homedir(), ".t3", "worktrees", basename(repo)), `t3code-${hex}`);
      const branch = `t3code/${hex}`;
      const title = composeTitle({ effort, suggestion: args.title, used: emojisInUse(effortThreads(effort)) });
      const launch = providerArgs(profileFor(effort, "spawn", overrides()));
      const plan = { title, worktree, branch, base: args.base, provider: launch };
      if (args["dry-run"]) {
        emit(plan, JSON.stringify(plan, null, 2));
        break;
      }
      const [remote, ...baseRef] = args.base.split("/");
      run("git", ["-C", repo, "fetch", remote, baseRef.join("/")]);
      run("git", ["-C", repo, "worktree", "add", "--no-track", "-b", branch, worktree, args.base]);
      const id = startThread({ effort, title, worktree, brief, providerArgs: launch });
      adopt({ effort, id, title, reviewer: false });
      emit({ ...plan, thread: id }, `spawned ${title} (${id}) in ${worktree} on ${branch}. title held, callback armed`);
      break;
    }

    case "review": {
      const effort = loadEffort();
      if (!args.pr) fail("review needs --pr <number>");
      const pr = JSON.parse(run("gh", ["pr", "view", args.pr, "--repo", effort.repo, "--json", "number,url,title,headRefOid,headRefName"]));
      const worktree = join(args["worktree-root"] ?? "/tmp", `${effort.slug}-review-${pr.number}-${pr.headRefOid.slice(0, 8)}`);
      const profile = profileFor(effort, "review", overrides());
      const title = composeTitle({ effort, suggestion: `Review #${pr.number} (${profile.model})`, used: emojisInUse(effortThreads(effort)) });
      const launch = providerArgs(profile);
      const brief = reviewBrief({ pr, focus: args.focus ?? null });
      const plan = { title, worktree, sha: pr.headRefOid, provider: launch, brief };
      if (args["dry-run"]) {
        emit(plan, JSON.stringify(plan, null, 2));
        break;
      }
      const repo = repoDir();
      if (!existsSync(worktree)) {
        run("git", ["-C", repo, "fetch", "origin", "main", `pull/${pr.number}/head`]);
        run("git", ["-C", repo, "worktree", "add", "--detach", worktree, pr.headRefOid]);
      }
      const id = startThread({ effort, title, worktree, brief, providerArgs: launch });
      adopt({ effort, id, title, reviewer: true });
      emit({ ...plan, thread: id }, `started ${title} (${id}) on ${worktree}. registered as a reviewer, callback armed`);
      break;
    }

    case "send": {
      if (!args.thread) fail("send needs --thread <id>");
      const message = args.stdin ? readFileSync(0, "utf8") : positionals.join(" ");
      if (!message.trim()) fail("send needs a message or --stdin");
      const thread = showThread(args.thread);
      if (!thread) fail(`t3cli show --thread ${args.thread} failed`);
      const options = sendOptionsFor(thread, args.effort ? (loadEffort().send ?? DEFAULT_PROFILES.send) : DEFAULT_PROFILES.send);
      t3(["send", "--thread", args.thread, "--stdin", ...options.flatMap((option) => ["--option", option]), "--format", "json"], message);
      emit({ thread: args.thread, options }, `sent to "${thread.title}"${options.length ? ` with ${options.join(" ")}` : ""}`);
      break;
    }

    case "settle": {
      loadEffort();
      const snapshot = loadSnapshot();
      const plan = settlePlan(snapshot);
      for (const step of plan) {
        let outcome = "would settle";
        if (args.apply) {
          const live = showThread(step.thread);
          if (live && (live.latestTurn?.state === "running" || live.hasPendingUserInput)) {
            node("watch.mjs", ["settle", "--effort", args.effort, "--thread", step.thread]);
            outcome = "settles when idle";
          } else {
            settleThread(step.thread);
            outcome = "settled";
          }
          const worktree = snapshot.threads[step.thread]?.worktreePath;
          if (step.reason === "reviewer-done" && worktree?.startsWith("/tmp/") && existsSync(worktree)) {
            try {
              run("git", ["-C", worktree, "worktree", "remove", worktree]);
              outcome += ", worktree removed";
            } catch {
              outcome += ", worktree kept (not clean)";
            }
          }
        }
        emit({ ...step, outcome }, `${outcome}: ${step.title} (${step.reason})`);
      }
      if (!plan.length) emit({ ok: true }, "nothing to settle");
      break;
    }

    case "board": {
      loadEffort();
      const lines = boardLines(loadSnapshot());
      emit({ lines }, lines.length ? lines.join("\n") : "no open PRs or live threads");
      break;
    }

    default:
      fail(`unknown command ${command}\n${USAGE}`);
  }
} catch (error) {
  fail(String(error?.stderr || error?.message || error).trim().split("\n").slice(0, 3).join(" | "));
}
