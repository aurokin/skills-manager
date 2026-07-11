// Injected environment. EVERY filesystem path skm touches is derived from a
// SkmEnv — production wires os.homedir()/process.env/real clock via realEnv();
// tests build a sandbox SkmEnv over a temp dir and NEVER touch the real HOME.
// Determinism: time comes from clock.now(), machine name is injected — no
// Date.now()/os.hostname() sprinkled through business logic.

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
  };
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

/** $COPILOT_HOME (expanded) or <home>/.copilot — mirrors the oracle's _resolve_copilot_home. */
export function resolveCopilotHome(env: SkmEnv): string {
  return env.copilotHome ? expandTilde(env, env.copilotHome) : path.join(env.home, ".copilot");
}

/** Expand a leading `~`/`~/` against the injected home. Non-tilde paths pass through. */
export function expandTilde(env: SkmEnv, p: string): string {
  if (p === "~") return env.home;
  if (p.startsWith("~/")) return path.join(env.home, p.slice(2));
  return p;
}
