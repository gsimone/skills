#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const START_MARKER = "<!-- stacked-prs:start -->";
export const END_MARKER = "<!-- stacked-prs:end -->";

function usage() {
  return `Usage: stacked_prs.mjs [PR_URL|PR_NUMBER|OWNER/REPO] [options]

Preview or synchronize a concise stack summary across GitHub PR bodies.

Options:
  --repo OWNER/REPO       repository for a bare PR number
  --write                 update every PR after rendering (default: preview)
  --summaries FILE        use summary JSON instead of calling Codex
  --save-summaries FILE   save summary JSON for a later --write
  --stack FILE            use stack JSON instead of GitHub (preview only)
  -h, --help              show this help`;
}

function fail(message) {
  throw new Error(message);
}

export function parseArgs(argv) {
  const options = {
    target: null,
    repo: null,
    write: false,
    summaries: null,
    saveSummaries: null,
    stack: null,
  };
  const valueFlags = new Map([
    ["--repo", "repo"],
    ["--summaries", "summaries"],
    ["--save-summaries", "saveSummaries"],
    ["--stack", "stack"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "-h" || value === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (value === "--write") {
      options.write = true;
      continue;
    }
    if (valueFlags.has(value)) {
      const next = argv[index + 1];
      if (!next) fail(`${value} requires a value`);
      options[valueFlags.get(value)] = next;
      index += 1;
      continue;
    }
    if (value.startsWith("-")) fail(`unknown option: ${value}`);
    if (options.target !== null) fail(`unexpected argument: ${value}`);
    options.target = value;
  }
  if (!options.stack && !options.target) fail(`a PR URL, number, or repository is required\n\n${usage()}`);
  if (options.stack && options.write) fail("--stack is fixture input and cannot be combined with --write");
  if (options.write && !options.summaries) fail("--write requires --summaries FILE from an inspected preview");
  return options;
}

async function run(command, args, { input = null } = {}) {
  const child = spawn(command, args, {
    stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  if (input !== null) child.stdin.end(input);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).catch((error) => {
    if (error.code === "ENOENT") fail(`${command} is required on PATH`);
    throw error;
  });
  const output = Buffer.concat(stdout).toString("utf8");
  const errorOutput = Buffer.concat(stderr).toString("utf8");
  if (result.code !== 0) {
    fail(`${command} failed (${result.signal ?? `exit ${result.code}`}):\n${errorOutput.slice(-4000)}`);
  }
  return output;
}

function count(text, needle) {
  return text.split(needle).length - 1;
}

export function managedRegion(body = "") {
  const text = body ?? "";
  const startCount = count(text, START_MARKER);
  const endCount = count(text, END_MARKER);
  if (startCount === 0 && endCount === 0) return null;
  if (startCount !== 1 || endCount !== 1) {
    fail(`expected zero or one marker pair, found ${startCount} start and ${endCount} end markers`);
  }
  const start = text.indexOf(START_MARKER);
  const end = text.indexOf(END_MARKER);
  if (end < start) fail("stacked PR end marker appears before its start marker");
  return { start, end: end + END_MARKER.length };
}

export function withoutManagedRegion(body = "") {
  const text = body ?? "";
  const region = managedRegion(text);
  if (!region) return text;
  return `${text.slice(0, region.start)}${text.slice(region.end)}`;
}

export function replaceManagedRegion(body = "", block) {
  const text = body ?? "";
  const region = managedRegion(text);
  if (region) return `${text.slice(0, region.start)}${block}${text.slice(region.end)}`;
  if (text.length === 0) return `${block}\n`;
  const separator = text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return `${text}${separator}${block}\n`;
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ").trim();
}

export function validateSummaryModel(stack, summaries) {
  if (!summaries || typeof summaries.overallSummary !== "string" || !Array.isArray(summaries.prs)) {
    fail("summary model must contain overallSummary and a prs array");
  }
  const expected = stack.prs.map((pr) => pr.number);
  const actual = summaries.prs.map((pr) => pr.number);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`summary PR order must exactly match stack order: ${expected.join(", ")}`);
  }
  for (const item of summaries.prs) {
    if (typeof item.summary !== "string" || item.summary.trim().length === 0 || item.summary.includes("\n")) {
      fail(`summary for PR #${item.number} must be one non-empty line`);
    }
  }
  if (summaries.overallSummary.trim().length === 0 || summaries.overallSummary.includes("\n")) {
    fail("overallSummary must be one non-empty line");
  }
  return summaries;
}

export function renderBlock(stack, summaries, currentPrNumber) {
  validateSummaryModel(stack, summaries);
  const byNumber = new Map(summaries.prs.map((item) => [item.number, item.summary]));
  if (!byNumber.has(currentPrNumber)) fail(`no summary found for current PR #${currentPrNumber}`);
  const rows = stack.prs.map((pr) => {
    const link = `[#${pr.number}](${pr.url})`;
    const label = pr.number === currentPrNumber ? `**${link} (this PR)**` : link;
    return `| ${label} | ${escapeCell(byNumber.get(pr.number))} |`;
  });
  return [
    START_MARKER,
    `> **Stack:** ${escapeCell(summaries.overallSummary)}`,
    "",
    "| PR | What it does |",
    "| --- | --- |",
    ...rows,
    END_MARKER,
  ].join("\n");
}

export function validateStack(stack) {
  if (!stack || !Array.isArray(stack.prs) || stack.prs.length < 2) {
    fail("a GitHub stack must contain at least two pull requests");
  }
  const numbers = stack.prs.map((pr) => pr.number);
  if (new Set(numbers).size !== numbers.length) fail("stack contains duplicate pull request numbers");
  if (!numbers.includes(stack.currentPrNumber)) {
    fail(`current PR #${stack.currentPrNumber} is absent from the stack`);
  }
  return stack;
}

export function nativeStackIdentity(nativeStacks, currentPrNumber) {
  if (!Array.isArray(nativeStacks) || nativeStacks.length === 0) {
    fail(`PR #${currentPrNumber} does not belong to a GitHub stack`);
  }
  if (nativeStacks.length !== 1) {
    fail(`GitHub returned ${nativeStacks.length} stacks for PR #${currentPrNumber}`);
  }
  const nativeStack = nativeStacks[0];
  const prNumbers = nativeStack.pull_requests?.map((pr) => pr.number);
  if (!Array.isArray(prNumbers) || prNumbers.length < 2 || !prNumbers.includes(currentPrNumber)) {
    fail(`GitHub returned an invalid stack for PR #${currentPrNumber}`);
  }
  return { stackNumber: nativeStack.number, prNumbers };
}

export function parseTarget(target, explicitRepo) {
  if (/^\d+$/.test(target)) return { repo: explicitRepo, number: Number(target) };
  const repoMatch = target.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (repoMatch) return { repo: `${repoMatch[1]}/${repoMatch[2]}`, number: null };
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    fail(`invalid PR target: ${target}`);
  }
  const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/);
  if (!match) fail(`not a GitHub pull-request URL: ${target}`);
  const ownerRepo = `${match[1]}/${match[2]}`;
  return {
    repo: parsed.hostname === "github.com" ? ownerRepo : `${parsed.hostname}/${ownerRepo}`,
    number: Number(match[3]),
  };
}

async function loadGithubStack(target, explicitRepo) {
  const parsed = parseTarget(target, explicitRepo);
  const repo = parsed.repo ?? (await run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).trim();
  const branch = parsed.number === null
    ? (await run("git", ["branch", "--show-current"])).trim()
    : null;
  if (parsed.number === null && branch.length === 0) {
    fail(`cannot resolve a pull request from ${repo} while Git is in detached HEAD state`);
  }
  const number = parsed.number ?? Number((await run(
    "gh",
    ["pr", "view", branch, "--repo", repo, "--json", "number", "--jq", ".number"],
  )).trim());
  if (!Number.isInteger(number) || number < 1) {
    fail(`could not resolve the pull request for the current branch in ${repo}`);
  }
  const repoParts = repo.split("/");
  const hostname = repoParts.length === 3 ? repoParts[0] : null;
  const [owner, name] = repoParts.length === 3 ? repoParts.slice(1) : repoParts;
  if (!owner || !name || repoParts.length < 2 || repoParts.length > 3) {
    fail(`invalid repository: ${repo}`);
  }
  const apiArgs = ["api"];
  if (hostname) apiArgs.push("--hostname", hostname);
  apiArgs.push(`repos/${owner}/${name}/stacks?pull_request=${number}`);
  const nativeStacks = JSON.parse(await run("gh", apiArgs));
  const { stackNumber, prNumbers } = nativeStackIdentity(nativeStacks, number);
  const fields = "number,title,body,baseRefName,headRefName,url,isDraft";
  const detailFields = `${fields},additions,deletions,commits,files`;
  const prs = await Promise.all(prNumbers.map(async (prNumber) => JSON.parse(
    await run("gh", ["pr", "view", String(prNumber), "--repo", repo, "--json", detailFields]),
  )));
  return validateStack({ repo, stackNumber, currentPrNumber: number, prs });
}

function modelInput(stack) {
  return {
    repo: stack.repo,
    prs: stack.prs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      body: withoutManagedRegion(pr.body),
      baseRefName: pr.baseRefName,
      headRefName: pr.headRefName,
      additions: pr.additions,
      deletions: pr.deletions,
      commits: (pr.commits ?? []).map((commit) => commit.messageHeadline),
      files: (pr.files ?? []).map((file) => file.path),
    })),
  };
}

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["overallSummary", "prs"],
  properties: {
    overallSummary: { type: "string" },
    prs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["number", "summary"],
        properties: { number: { type: "integer" }, summary: { type: "string" } },
      },
    },
  },
};

async function generateSummaries(stack) {
  const directory = await mkdtemp(path.join(tmpdir(), "stacked-prs-"));
  const schemaPath = path.join(directory, "summary.schema.json");
  const outputPath = path.join(directory, "summary.json");
  await writeFile(schemaPath, JSON.stringify(OUTPUT_SCHEMA));
  const prompt = `Summarize this linear stacked-PR chain for reviewers. Return exactly the requested JSON schema.

The overall summary is one concise sentence describing the user or system outcome of the complete stack. Each PR summary is one concise sentence describing only that PR's incremental contribution. Use concrete, parallel phrasing. Infer cautiously from all supplied evidence; do not claim tests, behavior, or intent not supported by it. Preserve the input PR order and numbers exactly.

STACK JSON:
${JSON.stringify(modelInput(stack))}`;
  try {
    await run("codex", [
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--strict-config",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox", "read-only",
      "--model", "gpt-5.6-luna",
      "--config", 'model_reasoning_effort="high"',
      "--config", 'service_tier="fast"',
      "--output-schema", schemaPath,
      "--output-last-message", outputPath,
      "-",
    ], { input: prompt });
    return validateSummaryModel(stack, JSON.parse(await readFile(outputPath, "utf8")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function updateGithub(stack, rendered) {
  const directory = await mkdtemp(path.join(tmpdir(), "stacked-pr-bodies-"));
  const updated = [];
  try {
    for (const item of rendered) {
      const bodyPath = path.join(directory, `pr-${item.number}.md`);
      await writeFile(bodyPath, item.body);
      try {
        await run("gh", ["pr", "edit", String(item.number), "--repo", stack.repo, "--body-file", bodyPath]);
        updated.push(item.number);
        console.log(`updated ${stack.repo}#${item.number}`);
      } catch (error) {
        fail(`updated ${updated.map((number) => `#${number}`).join(", ") || "no PRs"}; stopped at #${item.number}\n${error.message}`);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const stack = options.stack
    ? JSON.parse(await readFile(options.stack, "utf8"))
    : await loadGithubStack(options.target, options.repo);
  const orderedStack = validateStack(stack);
  const summaries = options.summaries
    ? validateSummaryModel(orderedStack, JSON.parse(await readFile(options.summaries, "utf8")))
    : await generateSummaries(orderedStack);
  if (options.saveSummaries) {
    await writeFile(options.saveSummaries, `${JSON.stringify(summaries, null, 2)}\n`);
    console.log(`saved summaries to ${options.saveSummaries}`);
  }
  const rendered = orderedStack.prs.map((pr) => ({
    number: pr.number,
    body: replaceManagedRegion(pr.body ?? "", renderBlock(orderedStack, summaries, pr.number)),
  }));

  console.log("summary_model:");
  console.log(JSON.stringify(summaries, null, 2));
  for (const item of rendered) {
    console.log(`\n--- ${orderedStack.repo}#${item.number} ---\n${item.body}`);
  }
  if (options.write) await updateGithub(orderedStack, rendered);
  else console.log("\npreview only; rerun with --write to update GitHub");
}

const isEntrypoint = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isEntrypoint) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
