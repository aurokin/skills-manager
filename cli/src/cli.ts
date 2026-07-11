#!/usr/bin/env bun
// Verb dispatch shell. Parses args, loads the real injected env, delegates to a
// verb handler, then prints (--json or human-pretty) and exits with the verb's
// code. All real work lives in the per-verb modules; this file only plumbs.

import { UsageError } from "./errors";
import { realEnv } from "./env";
import type { VerbHandler, VerbOptions } from "./types";
import { runAdopt } from "./adopt";
import { runApply } from "./apply";
import { runDoctor } from "./doctor";
import { runExplain } from "./explain";
import { runPlan } from "./plan";
import { runRoot } from "./root";
import { runStatus } from "./status";

const VERBS: Record<string, VerbHandler> = {
  plan: runPlan,
  apply: runApply,
  status: runStatus,
  doctor: runDoctor,
  explain: runExplain,
  adopt: runAdopt,
  root: runRoot,
};

interface ParsedInvocation {
  verb?: string;
  opts: VerbOptions;
}

export function parseArgs(argv: string[]): ParsedInvocation {
  let verb: string | undefined;
  let json = false;
  let prune = false;
  let yes = false;
  let fix = false;
  let planFile: string | undefined;
  let agentsHome: string | undefined;
  const args: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (verb === undefined && (a === "--help" || a === "-h")) {
      verb = "help";
      continue;
    }
    if (verb === undefined && !a.startsWith("-")) {
      verb = a;
      continue;
    }
    if (a === "--json") json = true;
    else if (a === "--prune") prune = true;
    else if (a === "--yes") yes = true;
    else if (a === "--fix") fix = true;
    else if (a === "--plan") {
      // A `--plan` flag with no operand (or immediately followed by another flag)
      // must be a usage error, never a silent fall-through to the fresh-plan path
      // — otherwise `skm apply --plan` runs an unreviewed plan against disk.
      const value = argv[++i];
      if (value === undefined || value.startsWith("-")) {
        throw new UsageError("--plan requires a plan file path");
      }
      planFile = value;
    } else if (a.startsWith("--plan=")) {
      const value = a.slice("--plan=".length);
      if (value === "") throw new UsageError("--plan requires a plan file path");
      planFile = value;
    } else if (a === "--agents-home") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("-")) {
        throw new UsageError("--agents-home requires a directory path");
      }
      agentsHome = value;
    } else if (a.startsWith("--agents-home=")) {
      const value = a.slice("--agents-home=".length);
      if (value === "") throw new UsageError("--agents-home requires a directory path");
      agentsHome = value;
    }
    else if (a.startsWith("-")) throw new UsageError(`unknown flag: ${a}`);
    else args.push(a);
  }

  return { verb, opts: { json, prune, yes, planFile, fix, agentsHome, args } };
}

const USAGE = `skm — skills manager (local skills placement engine)

Usage:
  skm plan    [--json]                     desired vs state; exit 2 if changes pending
  skm apply   [--json] [--plan <f>] [--prune] [--yes]
  skm status  [--json]                     drift: missing|stale|modified|foreign|unsafe
  skm doctor  [--json] [--fix]             leaks, broken links, deny-guarantee checks
  skm explain <skill> [--json]             source, scoping, placements, bleed
  skm adopt   custom-agents [--agents-home <dir>]  take ownership of manifest agent-def files
  skm root    add|list|remove [<path>]     edit machine config roots

Exit codes: 0 clean · 1 error · 2 changes pending / drift`;

function emit(outcome: VerbOutcome, opts: VerbOptions): void {
  if (opts.json || !process.stdout.isTTY) {
    process.stdout.write(`${JSON.stringify(outcome.json, null, 2)}\n`);
  } else {
    process.stdout.write(`${outcome.human}\n`);
  }
}

function emitError(err: unknown, opts: VerbOptions): void {
  const message = err instanceof Error ? err.message : String(err);
  // Mirror emit(): a piped (non-TTY) consumer gets JSON on the error path too, so
  // the output shape stays stable whether the verb succeeded or threw.
  if (opts.json || !process.stdout.isTTY) {
    process.stdout.write(`${JSON.stringify({ error: message }, null, 2)}\n`);
  } else {
    process.stderr.write(`skm: ${message}\n`);
  }
}

export function exitWith(code: number): never {
  process.exit(code);
}

async function main(): Promise<number> {
  let parsed: ParsedInvocation;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    emitError(err, { json: false, prune: false, yes: false, fix: false, args: [] });
    return 1;
  }

  const { verb, opts } = parsed;
  if (verb === undefined || verb === "help" || verb === "--help") {
    process.stdout.write(`${USAGE}\n`);
    return verb === undefined ? 1 : 0;
  }

  const handler = VERBS[verb];
  if (!handler) {
    emitError(new UsageError(`unknown verb: ${verb}`), opts);
    return 1;
  }

  const env = realEnv();
  try {
    const outcome = await handler(env, opts);
    emit(outcome, opts);
    return outcome.exitCode;
  } catch (err) {
    emitError(err, opts);
    return 1;
  }
}

// Only drive the process when run as the entry point; importing (e.g. for testing
// parseArgs) must not trigger argv parsing or process.exit.
if (import.meta.main) {
  main().then(exitWith);
}
