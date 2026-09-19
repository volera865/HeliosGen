import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// File-based (not in-memory) so state survives Next.js dev's module reloads —
// same pattern as lib/jobStore.ts.
export type CodexLoginState =
  | { status: "idle" }
  | { status: "pending"; url: string; code: string; startedAt: number }
  | { status: "success" }
  | { status: "error"; error: string };

const FILE = join(process.cwd(), ".codex-login-store.json");

// Mirrors the last written state so a read-only filesystem degrades to memory
// instead of throwing.
const memory = new Map<"state", CodexLoginState>();

function read(): CodexLoginState {
  // A value in memory came from a set() in this process, so it is never older
  // than the file.
  const cached = memory.get("state");
  if (cached) return cached;
  try {
    if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    // unreadable file — fall through to the default
  }
  return { status: "idle" };
}

function write(state: CodexLoginState): void {
  memory.set("state", state);
  try {
    writeFileSync(FILE, JSON.stringify(state), "utf8");
  } catch {
    // memory already holds the state — nothing further to do
  }
}

export const codexLoginStore = {
  get: read,
  set: write,
};
