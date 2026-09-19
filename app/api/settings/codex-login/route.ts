import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { codexLoginStore } from "@/lib/codexLoginStore";

// 15 minutes, matching the device code's own expiry (plus a little slack).
const CODE_LIFETIME_MS = 16 * 60 * 1000;

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function checkLoginStatus(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("codex", ["login", "status"]);
    let out = "";
    proc.stdout.on("data", (d: Buffer) => out += d.toString());
    // "Logged in using ChatGPT" vs "Not logged in" both contain "logged in" as a
    // substring — anchor to the start of the (trimmed) line so "Not …" doesn't match.
    proc.on("close", () => resolve(/^logged in/im.test(out.trim())));
    proc.on("error", () => resolve(false));
  });
}

export async function GET() {
  // Depends on a host-level `codex` CLI and its on-disk login session.
  if (process.env.VERCEL) {
    return NextResponse.json({ error: "Not available in this deployment" }, { status: 501 });
  }

  return NextResponse.json(codexLoginStore.get());
}

export async function POST() {
  // Depends on a host-level `codex` CLI and its on-disk login session.
  if (process.env.VERCEL) {
    return NextResponse.json({ error: "Not available in this deployment" }, { status: 501 });
  }

  const current = codexLoginStore.get();

  // A device code is already pending and still within its lifetime — don't
  // spawn a second `codex login` on top of it (and never kill the first: the
  // CLI wipes any existing credentials as soon as a new login starts, so a
  // half-finished second attempt would leave the user logged out).
  if (current.status === "pending" && Date.now() - current.startedAt < CODE_LIFETIME_MS) {
    return NextResponse.json(current);
  }

  const result = await new Promise<CodexLoginPostResult>((resolve) => {
    let buf = "";
    let settled = false;

    const proc = spawn("codex", ["login", "--device-auth"]);

    const trySettle = () => {
      if (settled) return;
      const clean = stripAnsi(buf);
      const urlMatch  = clean.match(/https:\/\/\S+/);
      const codeMatch = clean.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4,8})\b/);
      if (urlMatch && codeMatch) {
        settled = true;
        const state = { status: "pending" as const, url: urlMatch[0], code: codeMatch[1], startedAt: Date.now() };
        codexLoginStore.set(state);
        resolve(state);
      }
    };

    proc.stdout.on("data", (d: Buffer) => { buf += d.toString(); trySettle(); });
    proc.stderr.on("data", (d: Buffer) => { buf += d.toString(); trySettle(); });

    proc.on("error", (e) => {
      if (!settled) {
        settled = true;
        const state = { status: "error" as const, error: `codex spawn failed: ${e.message} — is it installed and on PATH?` };
        codexLoginStore.set(state);
        resolve(state);
      }
    });

    // The CLI keeps running after printing the code, polling in the background
    // until the user confirms in their browser (or the code expires). Let it
    // run to completion asynchronously — the store gets the final verdict once
    // it exits, and the frontend polls GET for that.
    proc.on("close", async (exitCode) => {
      const loggedIn = await checkLoginStatus();
      if (loggedIn) {
        codexLoginStore.set({ status: "success" });
      } else {
        codexLoginStore.set({ status: "error", error: stripAnsi(buf).trim().slice(-300) || `codex login exited with code ${exitCode}` });
      }
    });

    // Fallback if the CLI hangs without printing anything parseable.
    setTimeout(() => {
      if (!settled) {
        settled = true;
        const state = { status: "error" as const, error: "Timed out waiting for codex login to print a device code." };
        resolve(state);
      }
    }, 10_000);
  });

  return NextResponse.json(result);
}

type CodexLoginPostResult =
  | { status: "pending"; url: string; code: string; startedAt: number }
  | { status: "error"; error: string };
