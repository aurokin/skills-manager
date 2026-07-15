// `skm review` (ADR 0013) — read-only reporting verb. `--json` emits the review
// model; the default renders a single self-contained HTML page to machine-local
// state (or `--out <path>`, privacy-guarded like a private placement).

import * as fs from "node:fs";
import * as path from "node:path";
import { loadContext } from "../context";
import { type SkmEnv, expandTilde, stateHome } from "../env";
import { privacyViolation } from "../privacy";
import type { VerbOptions, VerbOutcome } from "../types";
import { buildReviewModel } from "./model";
import { renderReviewHtml } from "./render";

/** Follow destination symlinks (even dangling) and realpath the parent, so the
 *  privacy guard and the write both see where the bytes actually land.
 *  Returns undefined when the chain cannot be fully resolved — writing there
 *  would mean guarding one path and landing on another. */
function resolveDestination(p: string): string | undefined {
  let cur = p;
  for (let i = 0; i < 40; i++) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch {
      st = undefined as unknown as fs.Stats;
    }
    if (!st || !st.isSymbolicLink()) {
      // Realpath the nearest EXISTING ancestor and reattach the missing
      // suffix: mkdirSync would follow a symlinked ancestor, so the guard
      // must see where the new directories actually get created.
      let dir = path.dirname(cur);
      let suffix = path.basename(cur);
      for (;;) {
        try {
          return path.join(fs.realpathSync(dir), suffix);
        } catch {
          const parent = path.dirname(dir);
          if (parent === dir) return cur;
          suffix = path.join(path.basename(dir), suffix);
          dir = parent;
        }
      }
    }
    cur = path.resolve(path.dirname(cur), fs.readlinkSync(cur));
  }
  return undefined;
}

export async function runReview(env: SkmEnv, opts: VerbOptions): Promise<VerbOutcome> {
  const ctx = loadContext(env);
  const model = buildReviewModel(env, ctx);
  if (opts.json) {
    return { exitCode: 0, json: model, human: JSON.stringify(model, null, 2) };
  }

  // The page embeds private-overlay content, so the destination — default or
  // --out — is guarded like a private placement: refuse a non-allowlisted git
  // worktree. Guard (and write) the REAL destination: writeFileSync follows a
  // destination symlink — including a dangling one — so an allowed-looking
  // target must not smuggle the page elsewhere.
  const requested = opts.out
    ? path.resolve(expandTilde(env, opts.out))
    : path.join(stateHome(env), "skills-manager", "review.html");
  const outPath = resolveDestination(requested);
  if (!outPath) {
    return {
      exitCode: 1,
      json: { error: `refusing to write review page: unresolvable symlink chain at ${requested}` },
      human: `skm review: refusing to write '${requested}': unresolvable symlink chain`,
    };
  }
  const reason = privacyViolation(ctx.config, outPath);
  if (reason) {
    return {
      exitCode: 1,
      json: { error: `refusing to write review page: ${reason}` },
      human: `skm review: refusing to write '${outPath}': ${reason}`,
    };
  }

  const html = renderReviewHtml(model);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html);
  return {
    exitCode: 0,
    json: { path: outPath },
    human: `skm review: wrote ${outPath}`,
  };
}
