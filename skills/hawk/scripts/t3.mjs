import { execFileSync } from "node:child_process";

export const T3_ENV = { ...process.env, T3CLI_AGENT: "1", NODE_NO_WARNINGS: "1" };
delete T3_ENV.T3CODE_THREAD_ID;

export function t3(argv, input) {
  return execFileSync("t3cli", argv, {
    encoding: "utf8",
    env: T3_ENV,
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

export const parseJson = (out) => JSON.parse(out.replace(/[\u0000-\u001f]/g, " "));

export function showThread(threadId) {
  try {
    return parseJson(t3(["show", "--thread", threadId, "--format", "json"]));
  } catch {
    return null;
  }
}

export function listThreads(project, attempt = 1) {
  try {
    const parsed = parseJson(t3(["list", "--project", project, "--format", "json"]));
    return Array.isArray(parsed) ? parsed : (parsed.threads ?? []);
  } catch (error) {
    if (attempt >= 2) throw error;
    return listThreads(project, attempt + 1);
  }
}

export function startedThreadId(out) {
  const parsed = parseJson(out);
  return parsed.id ?? parsed.threadId ?? parsed.thread?.id ?? null;
}

export const setTitle = (threadId, title) => t3(["thread", "update", "--thread", threadId, "--title", title, "--force", "--format", "json"]);
export const settleThread = (threadId) => t3(["thread", "settle", "--thread", threadId, "--format", "json"]);
