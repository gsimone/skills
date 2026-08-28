import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  END_MARKER,
  START_MARKER,
  nativeStackIdentity,
  parseArgs,
  parseTarget,
  renderBlock,
  replaceManagedRegion,
  validateStack,
} from "./stacked_prs.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const stack = JSON.parse(await readFile(path.join(here, "../references/mock-stack.json"), "utf8"));
const summaries = JSON.parse(await readFile(path.join(here, "../references/mock-summaries.json"), "utf8"));

test("preserves GitHub's native bottom-to-top stack order", () => {
  assert.equal(validateStack(stack), stack);
  assert.deepEqual(stack.prs.map((pr) => pr.number), [101, 102, 103]);
  assert.deepEqual(
    nativeStackIdentity([
      { number: 7, pull_requests: [{ number: 101 }, { number: 102 }, { number: 103 }] },
    ], 102),
    { stackNumber: 7, prNumbers: [101, 102, 103] },
  );
});

test("renders overall context and highlights the current row", () => {
  const block = renderBlock(stack, summaries, 102);
  assert.match(block, /\*\*Stack:\*\* Add persisted, API-backed widget statuses/);
  assert.doesNotMatch(block, /This PR:/);
  assert.match(block, /\*\*\[#102\]\(https:\/\/github\.com\/acme\/widgets\/pull\/102\) \(this PR\)\*\*/);
  assert.ok(block.indexOf("#101") < block.indexOf("#102"));
  assert.ok(block.indexOf("#102") < block.indexOf("#103"));
});

test("replaces one marked region idempotently and preserves surrounding text", () => {
  const oldBlock = `${START_MARKER}\nold\n${END_MARKER}`;
  const newBlock = renderBlock(stack, summaries, 103);
  const original = `Human intro\n\n${oldBlock}\n\nHuman footer`;
  const once = replaceManagedRegion(original, newBlock);
  const twice = replaceManagedRegion(once, newBlock);
  assert.equal(once, twice);
  assert.ok(once.startsWith("Human intro\n\n"));
  assert.ok(once.endsWith("\n\nHuman footer"));
  assert.equal(once.split(START_MARKER).length - 1, 1);
});

test("refuses malformed or duplicate marker pairs", () => {
  assert.throws(() => replaceManagedRegion(`${START_MARKER}\nmissing end`, "new"), /marker pair/);
  assert.throws(
    () => replaceManagedRegion(`${START_MARKER}${END_MARKER}${START_MARKER}${END_MARKER}`, "new"),
    /marker pair/,
  );
});

test("handles a missing GitHub body and validates native membership", () => {
  assert.match(replaceManagedRegion(null, "managed"), /^managed/);
  assert.throws(() => validateStack({ currentPrNumber: 1, prs: [{ number: 1 }] }), /at least two/);
  assert.throws(
    () => validateStack({ currentPrNumber: 3, prs: [{ number: 1 }, { number: 2 }] }),
    /absent/,
  );
});

test("accepts a repository slug and resolves its current-branch PR later", () => {
  assert.deepEqual(parseTarget("acme/widgets"), { repo: "acme/widgets", number: null });
  assert.deepEqual(parseTarget("42", "acme/widgets"), { repo: "acme/widgets", number: 42 });
  assert.throws(() => parseArgs(["42", "--write"]), /requires --summaries/);
});
