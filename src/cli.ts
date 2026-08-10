#!/usr/bin/env node
/**
 * opencode-goal-run CLI — operate on persisted goal objectives WITHOUT any LLM.
 *
 *   node dist/cli.js list [match] [--all]
 *   node dist/cli.js status [match]
 *   node dist/cli.js pause <id|match> [--reason=...]   (keep record, stop engine)
 *   node dist/cli.js stop  <id|match>                  (abort: remove record, stop engine)
 *   node dist/cli.js delete <id|match>                 (stop-then-delete: remove record, stop engine)
 *
 * "Stop engine" = write a flag file the plugin polls; on its next loop it tears
 * the in-memory engine down exactly like goal_abort. Historical records (no live
 * engine) are handled purely on disk. Cross-process safe via atomic file writes.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

const HOME = os.homedir();
const snake = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, "_");

function statePath(): string {
  const i = process.argv.findIndex((a) => a.startsWith("--state="));
  if (i >= 0) return process.argv[i].slice("--state=".length);
  if (process.env.GOAL_RUN_STATE) return process.env.GOAL_RUN_STATE;
  return path.join(HOME, ".config", "opencode", "goal-run-state.json");
}

const STATE_FILE = statePath();
const STATE_DIR = path.dirname(STATE_FILE);

function stripPrefix(a: string): string {
  return a.startsWith("--") ? a.slice(2) : a;
}

function readState(): Record<string, any> {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const p = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (p && typeof p === "object") return p;
    }
  } catch (e) {
    /* corrupt -> start empty */
  }
  return {};
}

function writeState(s: Record<string, any>) {
  const tmp = STATE_FILE + ".cli.tmp";
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), "utf8");
  fs.renameSync(tmp, STATE_FILE);
}

function short(id: string) {
  return id.length <= 10 ? id : id.slice(0, 10) + "…";
}

function matchAll(state: Record<string, any>, query?: string): Array<[string, any]> {
  if (!query || query === "--all") {
    return Object.entries(state);
  }
  const q = query.toLowerCase();
  const exact = Object.entries(state).filter(([id]) => id === query);
  if (exact.length > 0) return exact;
  return Object.entries(state).filter(([id, s]: [string, any]) =>
    `${id}\n${s.worktree ?? ""}\n${s.objective ?? ""}`.toLowerCase().includes(q)
  );
}

function flagPath(id: string) {
  return path.join(STATE_DIR, `goal-run-stop-${snake(id)}.flag`);
}

function writeStopFlag(id: string, mode: "pause" | "delete") {
  fs.writeFileSync(flagPath(id), mode, "utf8");
}

function lockPath(worktree: string): string {
  const h = crypto.createHash("sha256").update(worktree).digest("hex").slice(0, 16);
  return path.join(STATE_DIR, `goal-run-${h}.lock`);
}

function cleanupStaleLock(worktree: string) {
  const p = lockPath(worktree);
  try {
    if (!fs.existsSync(p)) return;
    const st = fs.statSync(p);
    // only remove locks nobody is heartbeating (stale > 30s)
    if (Date.now() - st.mtimeMs > 30_000) fs.unlinkSync(p);
  } catch (e) {}
}

function formatOne(id: string, s: any, idx: number): string {
  const params = s.overrides ? Object.entries(s.overrides).map(([k, v]) => `${k}=${v}`).join(" ") : "(defaults)";
  return (
    `[${idx}] ${id}\n` +
    `    mode=${s.mode ?? "?"}  worktree=${s.worktree ?? "?"}\n` +
    `    turns=${s.turns ?? 0}  paused=${s.paused ?? false}  completed=${s.completed ?? false}  ` +
    `noProgress=${s.noProgressTurns ?? 0}  lastActivity=${new Date(s.lastActivityAt ?? 0).toLocaleString()}\n` +
    `    params: ${params}\n` +
    `    objective: ${(s.objective ?? "").slice(0, 200)}`
  );
}

function cmdList(query?: string): number {
  const state = readState();
  const rows = matchAll(state, query);
  if (rows.length === 0) {
    console.log("(no matching persisted objectives)");
    console.log(`state file: ${STATE_FILE}`);
    console.log("tip: remove the flag dir if stale: goal-run-stop-*.flag");
    return 0;
  }
  console.log(`found ${rows.length} objective(s):`);
  rows.forEach(([id, s], ix) => console.log(formatOne(id, s, ix)));
  console.log("");
  console.log(`state file: ${STATE_FILE}`);
  return 0;
}

function mutate(query: string | undefined, mode: "pause" | "delete", reason?: string): number {
  const state = readState();
  const rows = matchAll(state, query);
  if (rows.length === 0) {
    console.log(`no matching objective for '${query ?? ""}'`);
    cmdList(undefined);
    return 1;
  }
  for (const [id, s] of rows) {
    if (mode === "pause") {
      s.paused = true;
      s.pausedReason = reason || "paused via goal-cli";
    } else {
      delete state[id];
    }
    writeStopFlag(id, mode);
    // delete marker first so plugin never re-schedules from a stale disk record
    cleanupStaleLock(s.worktree ?? "");
  }
  writeState(state);
  console.log(`${mode === "pause" ? "PAUSED" : "STOPPED/TO_BE_DELETED"} ${rows.length} objective(s) (engine stop signal + disk updated):`);
  for (const [id, s] of rows) {
    console.log(`  - ${id} :: ${s.worktree ?? "?"}`);
  }
  if (mode === "pause") {
    console.log("resume later via /my_goal_restore or goal_resume (kept record).");
  } else {
    console.log("records removed; remaining: " + Object.keys(readState()).length);
  }
  return 0;
}

const args = process.argv.slice(2).filter((a) => !a.startsWith("--state="));
const cmd = (args[0] ?? "").toLowerCase();

let reason: string | undefined;
const ri = args.findIndex((a) => a.startsWith("--reason="));
if (ri >= 0) reason = args[ri].slice("--reason=".length);
const query = args.slice(1).find((a) => !a.startsWith("--"));

let exit = 0;
switch (cmd) {
  case "list":
  case "status":
  case "ls":
    exit = cmdList(query);
    break;
  case "pause":
    exit = mutate(query, "pause", reason);
    break;
  case "stop":
  case "abort":
  case "delete":
  case "rm":
    exit = mutate(query, "delete", reason);
    break;
  case "":
    console.log("usage: goal-cli <list|pause|stop|delete> [id|match] [--reason=...] [--state=<file>]");
    exit = 1;
    break;
  default:
    console.log(`unknown command: ${cmd}`);
    console.log("usage: goal-cli <list|pause|stop|delete> [id|match] [--reason=...] [--state=<file>]");
    exit = 1;
}
process.exit(exit);
