// Review HTML renderer + verb wiring (ADR 0013 phase 2). The model is tested in
// review-model.test.ts; here we cover injection escaping, the docs budget, the
// default/`--out` write paths, and the privacy guard — not pixel-level UI.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runApply } from "../src/apply";
import { loadContext } from "../src/context";
import { stateHome } from "../src/env";
import { buildReviewModel } from "../src/review/model";
import { applyDocsBudget, renderReviewHtml } from "../src/review/render";
import { runReview } from "../src/review/verb";
import type { VerbOptions } from "../src/types";
import { type Sandbox, makeRoot, makeSandbox, makeSkill, writeMachineConfig } from "./util";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox({ machineName: "fixture-machine" });
});
afterEach(() => {
  sb.cleanup();
});

const APPLY_OPTS: VerbOptions = { json: true, prune: false, yes: true, fix: false, args: [] };
const PLAIN_OPTS: VerbOptions = { json: false, prune: false, yes: false, fix: false, args: [] };

describe("review HTML render", () => {
  test("plain mode writes review.html under XDG state; payload cannot break out of the script block", async () => {
    const root = makeRoot(sb, "public");
    makeSkill(root.path, "plain-skill", { body: "before </script><script>alert(1)</script> after" });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sb.env, APPLY_OPTS);

    const outcome = await runReview(sb.env, PLAIN_OPTS);
    expect(outcome.exitCode).toBe(0);

    const written = path.join(stateHome(sb.env), "skills-manager", "review.html");
    expect(fs.existsSync(written)).toBe(true);
    // The verb reports the REAL destination (parent symlinks resolved).
    expect(fs.realpathSync((outcome.json as { path: string }).path)).toBe(fs.realpathSync(written));

    const html = fs.readFileSync(written, "utf8");
    // Escaped model JSON is embedded in the data block.
    expect(html).toContain('id="review-model"');
    expect(html).toContain("plain-skill");
    // The raw payload must NOT appear (would break out of <script>); its escaped
    // form must.
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("\\u003c/script\\u003e\\u003cscript\\u003ealert(1)");
  });

  test("--out writes to the given path", async () => {
    const root = makeRoot(sb, "public");
    makeSkill(root.path, "plain-skill", { body: "plain body" });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sb.env, APPLY_OPTS);

    const target = path.join(sb.base, "custom-review.html");
    const outcome = await runReview(sb.env, { ...PLAIN_OPTS, out: target });
    expect(outcome.exitCode).toBe(0);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toContain("plain-skill");

    // A literal ~ (quoted shell arg) expands against env.home, not cwd.
    const tildeOutcome = await runReview(sb.env, { ...PLAIN_OPTS, out: "~/tilde-review.html" });
    expect(tildeOutcome.exitCode).toBe(0);
    expect(fs.existsSync(path.join(sb.home, "tilde-review.html"))).toBe(true);
  });

  test("a symlinked destination cannot smuggle the page past the privacy guard", async () => {
    const root = makeRoot(sb, "public");
    makeSkill(root.path, "plain-skill", { body: "plain body" });
    writeMachineConfig(sb, {
      version: 1,
      roots: [root],
      agents: ["claude-code"],
      privateOriginAllowlist: [],
    });
    await runApply(sb.env, APPLY_OPTS);

    // Non-allowlisted worktree; an innocent-looking --out target is a DANGLING
    // symlink into it (writeFileSync would follow it and create the file there).
    const wt = path.join(sb.base, "secret-wt");
    fs.mkdirSync(wt, { recursive: true });
    execFileSync("git", ["-C", wt, "init", "-q"]);
    execFileSync("git", ["-C", wt, "remote", "add", "origin", "git@github.com:someone/secret.git"]);
    const target = path.join(sb.base, "innocent.html");
    fs.symlinkSync(path.join(wt, "review.html"), target);

    const outcome = await runReview(sb.env, { ...PLAIN_OPTS, out: target });
    expect(outcome.exitCode).toBe(1);
    expect(fs.existsSync(path.join(wt, "review.html"))).toBe(false);

    // A chain deeper than the resolver follows is refused outright — guarding
    // one path and writing through another is never acceptable.
    const chainDir = path.join(sb.base, "chain");
    fs.mkdirSync(chainDir, { recursive: true });
    fs.symlinkSync(path.join(wt, "review.html"), path.join(chainDir, "link0"));
    for (let i = 1; i <= 45; i++) {
      fs.symlinkSync(path.join(chainDir, `link${i - 1}`), path.join(chainDir, `link${i}`));
    }
    const deep = await runReview(sb.env, { ...PLAIN_OPTS, out: path.join(chainDir, "link45") });
    expect(deep.exitCode).toBe(1);
    expect(fs.existsSync(path.join(wt, "review.html"))).toBe(false);

    // Symlinked ANCESTOR with a not-yet-created subdir: mkdirSync would follow
    // the link, so the guard must resolve the existing ancestor first.
    const linkDir = path.join(sb.base, "linkdir");
    fs.symlinkSync(wt, linkDir);
    const viaAncestor = await runReview(sb.env, {
      ...PLAIN_OPTS,
      out: path.join(linkDir, "sub", "review.html"),
    });
    expect(viaAncestor.exitCode).toBe(1);
    expect(fs.existsSync(path.join(wt, "sub"))).toBe(false);
  });

  test("docs budget drops the largest doc with a marker, leaving the total under budget", () => {
    const docs = {
      "~/big": { skill: "x".repeat(3_000_000), files: ["a.md"] },
      "~/mid": { skill: "y".repeat(2_000_000), files: [] },
      "~/tiny": { skill: "small", files: [] },
    };
    const budgeted = applyDocsBudget(docs, 4_000_000);

    const total = Object.values(budgeted).reduce((n, d) => n + Buffer.byteLength(d.skill, "utf8"), 0);
    expect(total).toBeLessThanOrEqual(4_000_000);
    // Largest dropped, marker in place, entry preserved (files intact).
    expect(budgeted["~/big"]!.skill).toContain("doc omitted");
    expect(budgeted["~/big"]!.skill).toContain("kB, over total budget");
    expect(budgeted["~/big"]!.files).toEqual(["a.md"]);
    // Smaller docs untouched.
    expect(budgeted["~/mid"]!.skill.length).toBe(2_000_000);
    expect(budgeted["~/tiny"]!.skill).toBe("small");
    // Input model was not mutated.
    expect(docs["~/big"].skill.length).toBe(3_000_000);
  });

  test("renderReviewHtml embeds unit names and inventory dir paths", async () => {
    const root = makeRoot(sb, "public");
    makeSkill(root.path, "plain-skill", { body: "plain body" });
    writeMachineConfig(sb, { version: 1, roots: [root], agents: ["claude-code"] });
    await runApply(sb.env, APPLY_OPTS);

    const model = buildReviewModel(sb.env, loadContext(sb.env));
    const html = renderReviewHtml(model);
    expect(html).toContain("plain-skill");
    expect(html).toContain(".agents/skills");
  });
});
