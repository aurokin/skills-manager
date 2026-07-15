// HTML renderer for the review model (ADR 0013 phase 2). The page is a pure
// function of the model: this module injects the serialized model into the
// versioned template and enforces the page-total docs budget. All presentation
// lives in template.html; nothing here re-derives facts.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ReviewModel } from "./model";

/** Page-total budget across all embedded SKILL.md docs (ADR 0013). */
const DOCS_TOTAL_BUDGET = 4_000_000;

const here = path.dirname(fileURLToPath(import.meta.url)); // cli/src/review

/**
 * Enforce the page-total docs budget: while the sum of doc bodies exceeds the
 * budget, drop the largest remaining doc — replacing its `skill` text with a
 * visible marker (the entry stays so inventory links never dangle). Returns a
 * shallow copy; the input model is untouched (the --json path keeps full docs).
 */
export function applyDocsBudget(
  docs: ReviewModel["docs"],
  budget = DOCS_TOTAL_BUDGET,
): ReviewModel["docs"] {
  const out: ReviewModel["docs"] = {};
  for (const [k, v] of Object.entries(docs)) out[k] = { skill: v.skill, files: v.files };
  const size = (k: string) => Buffer.byteLength(out[k]!.skill, "utf8");
  const dropped = new Set<string>();
  let total = Object.keys(out).reduce((n, k) => n + size(k), 0);
  while (total > budget) {
    let big: string | undefined;
    let bigSize = -1;
    for (const k of Object.keys(out)) {
      if (dropped.has(k)) continue;
      const s = size(k);
      if (s > bigSize) { bigSize = s; big = k; }
    }
    if (big === undefined) break;
    total -= bigSize;
    out[big] = { skill: `… [doc omitted: ${Math.round(bigSize / 1024)}kB, over total budget]`, files: out[big]!.files };
    total += size(big);
    dropped.add(big);
  }
  return out;
}

/** Escape a JSON string for embedding in an HTML `<script>` data block: `<`, `>`,
 *  `&` become \u escapes (valid inside JSON string values, so JSON.parse still
 *  round-trips) — no `</script>` can survive to break out of the block. */
function escapeForScript(json: string): string {
  return json
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
}

/** Render the review model to a single self-contained HTML page. */
export function renderReviewHtml(model: ReviewModel): string {
  const budgeted: ReviewModel = { ...model, docs: applyDocsBudget(model.docs) };
  const template = fs.readFileSync(path.join(here, "template.html"), "utf8");
  const json = escapeForScript(JSON.stringify(budgeted));
  return template.replace("__MODEL_JSON__", () => json);
}
