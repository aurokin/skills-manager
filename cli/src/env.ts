// Injected environment. EVERY filesystem path skm touches is derived from a
// SkmEnv — production wires os.homedir()/process.env/real clock via realEnv();
// tests build a sandbox SkmEnv over a temp dir and NEVER touch the real HOME.
// Determinism: time comes from clock.now(), machine name is injected — no
// Date.now()/os.hostname() sprinkled through business logic.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Source of the current timestamp. Injected so plans/audit are deterministic in tests. */
export interface Clock {
  /** ISO-8601 timestamp, e.g. "2026-07-10T00:00:00.000Z". */
  now(): string;
}

/** The single injected environment every path root derives from. */
export interface SkmEnv {
  /** Absolute home directory (fake in tests). */
  home: string;
  /** XDG_CONFIG_HOME override; falls back to <home>/.config. */
  xdgConfigHome?: string;
  /** XDG_STATE_HOME override; falls back to <home>/.local/state. */
  xdgStateHome?: string;
  /** $COPILOT_HOME override for Copilot's home dir; falls back to <home>/.copilot. */
  copilotHome?: string;
  /** Machine name recorded in state/audit (injected, never os.hostname() inline). */
  machineName: string;
  /** Injected clock. */
  clock: Clock;
  /**
   * tprompt-channel availability probe (ADR 0008): true when the `tprompt` binary
   * is on PATH. Injected so tests decide availability without touching the machine.
   * Absent → channel treated as unavailable (safe: no writes, no prunes).
   */
  tpromptProbe?: () => boolean;
  /**
   * Installed-CLI version probe for gated-skill gate-drift detection (ADR 0011,
   * doctor finding c): given an agent id, return the version string the agent's CLI
   * reports, or undefined when the binary is missing / output is unparseable. Injected
   * so tests decide versions without spawning real binaries. Absent → drift check skips.
   * `probeCli` (from the agent's registry entry) overrides the built-in id→binary map —
   * the data-driven path for agent variants that share a first-party binary (ADR 0016).
   */
  agentVersionProbe?: (agentId: string, probeCli?: string) => string | undefined;
  /**
   * Ambient environment-variable reader for host-state checks (doctor's
   * kill-switch awareness). Injected so tests control the environment; empty
   * string reads as unset. Absent → no variable is treated as set.
   */
  envVar?: (name: string) => string | undefined;
  /**
   * Git runner used to fast-forward git-backed roots before plan/apply. Injected so
   * tests opt in with temp repos and never fetch or move the real checkout. Absent →
   * roots are read as checked out (no pulling).
   */
  git?: (cwd: string, args: string[]) => GitResult;
}

/** Outcome of one `git -C <cwd> …` invocation. */
export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

// Safety net for a fetch stuck on an unresponsive remote; offline hosts fail fast.
const GIT_TIMEOUT_MS = 60_000;

/** Run git non-interactively (no credential prompts) in `cwd`. */
export function runGit(cwd: string, args: string[]): GitResult {
  const out = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: GIT_TIMEOUT_MS,
  });
  if (out.error) return { ok: false, stdout: "", stderr: out.error.message };
  return { ok: out.status === 0, stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
}

/** Production environment: real home, process env, wall-clock, real hostname. */
export function realEnv(): SkmEnv {
  return {
    home: os.homedir(),
    xdgConfigHome: process.env.XDG_CONFIG_HOME || undefined,
    xdgStateHome: process.env.XDG_STATE_HOME || undefined,
    copilotHome: process.env.COPILOT_HOME || undefined,
    machineName: os.hostname(),
    clock: { now: () => new Date().toISOString() },
    tpromptProbe: () => binaryOnPath("tprompt"),
    agentVersionProbe: (agentId, probeCli) => probeAgentVersion(agentId, probeCli),
    envVar: (name) => process.env[name] || undefined,
    git: runGit,
  };
}

/** Registry agent id → CLI binary name for the gate-version probe (gate-honoring agents). */
const AGENT_CLI: Record<string, string> = {
  "claude-code": "claude",
  codex: "codex",
  "github-copilot": "copilot",
  cursor: "cursor-agent",
  grok: "grok",
  pi: "pi",
  droid: "droid",
};

/**
 * Best-effort installed-CLI version for one agent: run `<cli> --version` and pull the
 * first dotted-version token out of stdout. `probeCli` (registry data, ADR 0016)
 * overrides the built-in map so agent variants sharing a first-party binary need no
 * engine edit. Returns undefined when the binary is unknown/missing or the output has
 * no parseable version — the caller then skips the drift check silently (ADR 0011).
 * Kept cheap: a single short-timeout subprocess.
 */
function probeAgentVersion(agentId: string, probeCli?: string): string | undefined {
  const bin = probeCli ?? AGENT_CLI[agentId];
  if (!bin || !binaryOnPath(bin)) return undefined;
  let out: ReturnType<typeof spawnSync>;
  try {
    out = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 3000 });
  } catch {
    return undefined;
  }
  if (out.status !== 0 && !out.stdout) return undefined;
  const m = /\d+\.\d+(?:\.\d+)?(?:[.\d]+)?/.exec(`${out.stdout ?? ""}`);
  return m ? m[0] : undefined;
}

/** True when an executable named `bin` exists on any PATH directory. */
function binaryOnPath(bin: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      return true;
    } catch {
      /* not here; keep scanning */
    }
  }
  return false;
}

/** ~/.config or $XDG_CONFIG_HOME. */
export function configHome(env: SkmEnv): string {
  return env.xdgConfigHome ?? path.join(env.home, ".config");
}

/** ~/.local/state or $XDG_STATE_HOME. */
export function stateHome(env: SkmEnv): string {
  return env.xdgStateHome ?? path.join(env.home, ".local", "state");
}

/** Machine config file: <configHome>/skills-manager/config.json. */
export function configPath(env: SkmEnv): string {
  return path.join(configHome(env), "skills-manager", "config.json");
}

/** Ownership state file: <stateHome>/skills-manager/state.json. */
export function statePath(env: SkmEnv): string {
  return path.join(stateHome(env), "skills-manager", "state.json");
}

/** Append-only audit log: <stateHome>/skills-manager/audit.jsonl. */
export function auditPath(env: SkmEnv): string {
  return path.join(stateHome(env), "skills-manager", "audit.jsonl");
}

/** Manager-owned vendoring cache for scoped-upstream skills (phase 7; path only). */
export function storeDir(env: SkmEnv): string {
  return path.join(stateHome(env), "skills-manager", "store");
}

/** The `skills` CLI's install ledger: <home>/.agents/.skill-lock.json (read-only for skm). */
export function skillLockPath(env: SkmEnv): string {
  return path.join(env.home, ".agents", ".skill-lock.json");
}

/** $COPILOT_HOME (expanded) or <home>/.copilot — mirrors the oracle's _resolve_copilot_home. */
export function resolveCopilotHome(env: SkmEnv): string {
  return env.copilotHome ? expandTilde(env, env.copilotHome) : path.join(env.home, ".copilot");
}

/** Expand a leading tilde against the injected home using either platform separator. */
export function expandTilde(env: SkmEnv, p: string): string {
  if (p === "~") return env.home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(env.home, p.slice(2));
  return p;
}
