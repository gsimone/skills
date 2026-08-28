import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  END_MARKER,
  START_MARKER,
  orderStack,
  parseTarget,
  renderBlock,
  replaceManagedRegion,
} from "./stacked_prs.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const stack = JSON.parse(await readFile(path.join(here, "../references/mock-stack.json"), "utf8"));
const summaries = JSON.parse(await readFile(path.join(here, "../references/mock-summaries.json"), "utf8"));

test("orders an unordered chain from root to tip", () => {
  const shuffled = [stack.prs[2], stack.prs[0], stack.prs[1]];
  assert.deepEqual(orderStack(shuffled, 102).map((pr) => pr.number), [101, 102, 103]);
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

test("handles a missing GitHub body and refuses branch cycles", () => {
  assert.match(replaceManagedRegion(null, "managed"), /^managed/);
  const cyclic = [
    { number: 1, baseRefName: "branch-b", headRefName: "branch-a" },
    { number: 2, baseRefName: "branch-a", headRefName: "branch-b" },
  ];
  assert.throws(() => orderStack(cyclic, 1), /branch cycle/);
});

test("accepts a repository slug and resolves its current-branch PR later", () => {
  assert.deepEqual(parseTarget("acme/widgets"), { repo: "acme/widgets", number: null });
  assert.deepEqual(parseTarget("42", "acme/widgets"), { repo: "acme/widgets", number: 42 });
});
