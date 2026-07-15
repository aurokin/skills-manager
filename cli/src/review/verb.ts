// `skm review` (ADR 0013) — read-only reporting verb. `--json` emits the review
// model; the default renders a single self-contained HTML page to machine-local
// state (or `--out <path>`, privacy-guarded like a private placement).

import * as fs from "node:fs";
import * as path from "node:path";
import { loadContext } from "../context";
import { type SkmEnv, stateHome } from "../env";
import { privacyViolation } from "../privacy";
import type { VerbOptions, VerbOutcome } from "../types";
import { buildReviewModel } from "./model";
import { renderReviewHtml } from "./render";

export async function runReview(env: SkmEnv, opts: VerbOptions): Promise<VerbOutcome> {
  const ctx = loadContext(env);
  const model = buildReviewModel(env, ctx);
  if (opts.json) {
    return { exitCode: 0, json: model, human: JSON.stringify(model, null, 2) };
  }

  // The page embeds private-overlay content, so an explicit --out target is
  // guarded like a private placement: refuse a non-allowlisted git worktree.
  const outPath = opts.out
    ? path.resolve(opts.out)
    : path.join(stateHome(env), "skills-manager", "review.html");
  if (opts.out) {
    const reason = privacyViolation(ctx.config, outPath);
    if (reason) {
      return {
        exitCode: 1,
        json: { error: `refusing to write review page: ${reason}` },
        human: `skm review: refusing --out '${opts.out}': ${reason}`,
      };
    }
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
