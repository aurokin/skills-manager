// `skm apply` — execute a plan (freshly computed, or a reviewed --plan file),
// updating the filesystem and ownership state. Deletes only state-owned paths;
// prune is gated by --prune. Rendered artifacts are materialized as real dirs;
// unscoped/scoped symlinks otherwise. Owned by the apply/state team.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  agentDefFileHash,
  derivedSkillHash,
  renderAgentDefFile,
  renderDerivedSkillMd,
} from "./agentdef/artifact";
import { UsageError } from "./errors";
import { loadContext, registryPath } from "./context";
import type { SkmEnv } from "./env";
import { appendAudit, makeAuditEntry } from "./audit";
import { loadMachineConfig } from "./machine-config";
import { buildPlan, planHashOf } from "./plan";
import { dialectForDir } from "./placements";
import { privacyViolation } from "./privacy";
import { loadRegistry } from "./registry";
import { hashContent, renderSkill, renderedHash, treeHashOf } from "./render";
import { resolveDesiredState } from "./resolve";
import { scanEntry } from "./scan";
import {
  artifactKey,
  findOwner,
  loadState,
  removePlacement,
  saveState,
  upsertPlacement,
} from "./state";
import type {
  DesiredSkill,
  DriftFinding,
  MachineConfig,
  PlannedAction,
  Plan,
  Registry,
  StateFile,
  VerbOptions,
  VerbOutcome,
} from "./types";
import { ExitCode } from "./types";

/** Verb entry. With --plan, refuses if the desired-state hash changed since planning. */
export async function runApply(env: SkmEnv, opts: VerbOptions): Promise<VerbOutcome> {
  const registry = loadRegistry(registryPath());
  const config = loadMachineConfig(env, registry);
  const plan = opts.planFile
    ? loadReviewedPlan(env, opts.planFile, config, registry)
    : freshPlan(env);

  const state = loadState(env);
  const { refused } = executePlan(env, plan, state, { prune: opts.prune }, config);
  saveState(env, state);

  const summary = summarize(plan, opts.prune, refused);
  appendAudit(env, makeAuditEntry(env, "apply", summary.text, plan.planHash));

  // Terraform-style: report "not fully converged" (exit 2) when apply itself
  // refused a private placement (unsafe), skipped foreign content, or left prune
  // actions pending because --prune was omitted.
  const prunePending = plan.requiresPrune && !opts.prune;
  const converged =
    refused.length === 0 && plan.foreign.length === 0 && plan.unsafe.length === 0 && !prunePending;
  const exitCode = converged ? ExitCode.CLEAN : ExitCode.PENDING;

  return { exitCode, json: summary.json, human: summary.text };
}

/** Recompute a plan against the live machine (default apply path). */
function freshPlan(env: SkmEnv): Plan {
  const ctx = loadContext(env);
  return buildPlan(env, ctx.config, ctx.registry, ctx.desired, ctx.state);
}

/**
 * Load a reviewed plan file and verify both preconditions before running it:
 * (1) the plan's own integrity hash still matches its actions, and (2) the live
 * desired state hashes to exactly what the plan was computed from.
 */
function loadReviewedPlan(
  env: SkmEnv,
  planFile: string,
  config: MachineConfig,
  registry: Registry,
): Plan {
  let plan: Plan;
  try {
    plan = JSON.parse(fs.readFileSync(planFile, "utf8")) as Plan;
  } catch (e) {
    throw new UsageError(`cannot read plan file ${planFile}: ${(e as Error).message}`);
  }
  if (planHashOf(plan.desiredStateHash, plan.actions, plan.requiresPrune) !== plan.planHash) {
    throw new UsageError(`plan file ${planFile} failed integrity check (planHash mismatch)`);
  }
  const desired = resolveDesiredState(env, config, registry);
  if (desired.hash !== plan.desiredStateHash) {
    throw new UsageError(
      "desired state changed since this plan was created; re-run `skm plan` and review again",
    );
  }
  return plan;
}

/** Execute plan actions, returning the updated ownership state + any refusals. */
export function executePlan(
  env: SkmEnv,
  plan: Plan,
  state: StateFile,
  opts: { prune: boolean },
  config: MachineConfig,
): { state: StateFile; refused: DriftFinding[] } {
  const refused: DriftFinding[] = [];
  for (const action of plan.actions) {
    switch (action.type) {
      case "noop":
        break;
      case "adopt":
        recordPlacement(state, action);
        break;
      case "create":
      case "update": {
        const skip = materialize(env, action, state, config);
        if (skip) refused.push(skip);
        break;
      }
      case "prune":
        if (opts.prune) {
          const skip = prune(env, action, state);
          if (skip) refused.push(skip);
        }
        break;
    }
  }
  return { state, refused };
}

// ── materialization ────────────────────────────────────────────────────────

/** Type-qualified state key for an action's artifact (defaults to the skill namespace). */
function keyOf(action: PlannedAction): string {
  return artifactKey(action.placement.artifactType ?? "skill", action.skill);
}

function recordPlacement(state: StateFile, action: PlannedAction): void {
  const src = action.source;
  if (!src) throw new UsageError(`plan action for '${action.skill}' is missing source`);
  const p = action.placement;
  const abs = path.resolve(p.path);
  // Adopting a pre-existing rendered dir: capture its current full-tree hash as the
  // owned baseline so later deletion safety covers the whole tree (finding 2). A
  // rendered-file (agent-def) is covered by its content hash, not a tree.
  const tree = p.kind === "rendered" ? treeHashOf(abs) : undefined;
  upsertPlacement(
    state,
    keyOf(action),
    { root: src.root, visibility: src.visibility },
    {
      agent: p.agent,
      path: abs,
      kind: p.kind,
      ...(p.hash ? { hash: p.hash } : {}),
      ...(tree ? { tree } : {}),
    },
  );
}

/**
 * Materialize one create/update action. Returns a DriftFinding when it refuses
 * (private-content privacy guard, or content skm does not own sitting at the
 * target) — in which case nothing on disk or in state is touched.
 */
function materialize(
  env: SkmEnv,
  action: PlannedAction,
  state: StateFile,
  config: MachineConfig,
): DriftFinding | undefined {
  const src = action.source;
  if (!src) throw new UsageError(`plan action for '${action.skill}' is missing source`);
  const p = action.placement;
  const abs = path.resolve(p.path);

  // Privacy guard, re-checked at write time (§9). A reviewed `--plan` file or a
  // changed allowlist must not be able to leak private content into a git
  // worktree whose origin is no longer allowlisted.
  if (src.visibility === "private") {
    const reason = privacyViolation(config, abs);
    if (reason) return { drift: "unsafe", skill: action.skill, path: abs, detail: reason };
  }

  // Deletion safety (deletion invariant, DEL-1). skm may remove only content it
  // owns: an owned symlink/absent path, or a rendered dir skm itself produced and
  // that is unmodified. A real dir/file that replaced our link, an un-owned entry,
  // or a hand-edited rendered dir is foreign → refuse, never recursive-delete.
  const removal = classifyRemoval(env, abs, state);
  if (removal.kind === "foreign") {
    return { drift: "foreign", skill: action.skill, path: abs, detail: removal.detail };
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true }); // create the agent dir per registry (agentDefDir created on demand)
  const source = { root: src.root, visibility: src.visibility };

  if (p.artifactType === "agent-def") {
    // Single rendered file in a harness's agentDefDir. Re-render from the current
    // source and refuse if it drifted from the reviewed hash (finding 1).
    if (p.hash && agentDefFileHash(src.path, p.renderDialect!) !== p.hash) {
      return { drift: "stale", skill: action.skill, path: abs, detail: "agent-def render changed since plan; re-run plan" };
    }
    const text = renderAgentDefFile(src.path, p.renderDialect!);
    removeExisting(abs);
    fs.writeFileSync(abs, text);
    upsertPlacement(state, keyOf(action), source, { agent: p.agent, path: abs, kind: "rendered-file", hash: hashContent(text) });
  } else if (p.derived) {
    // Derived skill: render-only SKILL.md dir (no source tree to copy).
    const hermes = p.agent === "hermes";
    if (p.hash && derivedSkillHash(src.path, hermes) !== p.hash) {
      return { drift: "stale", skill: action.skill, path: abs, detail: "derived-skill render changed since plan; re-run plan" };
    }
    const md = renderDerivedSkillMd(src.path, hermes);
    removeExisting(abs);
    fs.mkdirSync(abs, { recursive: true });
    fs.writeFileSync(path.join(abs, "SKILL.md"), md);
    upsertPlacement(state, keyOf(action), source, { agent: p.agent, path: abs, kind: "rendered", hash: hashContent(md), tree: treeHashOf(abs) });
  } else if (p.kind === "rendered") {
    const dialect = dialectForDir(p.dir);
    if (!dialect) throw new UsageError(`no rendering dialect for dir '${p.dir}'`);
    const skill: DesiredSkill = {
      name: action.skill,
      source: src,
      overrides: action.overrides ?? {},
    };
    // Desired-state-hash precondition (loadReviewedPlan) covers WHICH skills exist
    // and their source paths, but not the file CONTENT. A reviewed --plan action
    // carries the rendered hash that was reviewed; re-render from the CURRENT source
    // and refuse if it no longer matches, so a source/override edit in the plan→apply
    // gap cannot materialize unreviewed bytes (finding 1). No-op for a fresh plan:
    // p.hash was just computed from this same source.
    if (p.hash) {
      const actual = renderedHash(skill, dialect);
      if (actual !== p.hash) {
        return {
          drift: "stale",
          skill: action.skill,
          path: abs,
          detail: "rendered output changed since plan (source or override edited); re-run plan",
        };
      }
    }
    removeExisting(abs);
    const result = renderSkill(env, skill, dialect, abs);
    upsertPlacement(
      state,
      keyOf(action),
      source,
      {
        agent: p.agent,
        path: abs,
        kind: "rendered",
        hash: result.hash,
        ...(result.tree ? { tree: result.tree } : {}),
      },
    );
  } else {
    removeExisting(abs);
    fs.symlinkSync(src.path, abs);
    upsertPlacement(
      state,
      keyOf(action),
      source,
      { agent: p.agent, path: abs, kind: "symlink" },
    );
  }
  return undefined;
}

function prune(env: SkmEnv, action: PlannedAction, state: StateFile): DriftFinding | undefined {
  const abs = path.resolve(action.placement.path);
  const removal = classifyRemoval(env, abs, state);
  if (removal.kind === "foreign") {
    // The user replaced our artifact with their own content. Stop managing it
    // (drop from state) and report it rather than recursive-deleting their work.
    removePlacement(state, keyOf(action), abs);
    return { drift: "foreign", skill: action.skill, path: abs, detail: removal.detail };
  }
  removeExisting(abs);
  removePlacement(state, keyOf(action), abs);
  return undefined;
}

type Removal = { kind: "safe" } | { kind: "foreign"; detail: string };

/**
 * Decide whether skm may delete whatever currently sits at `abs`. Safe iff the
 * path is absent, an owned symlink, or a rendered directory skm itself produced
 * whose SKILL.md still hashes to what state recorded (unmodified). Everything else
 * is foreign content that must never be recursive-deleted.
 */
function classifyRemoval(env: SkmEnv, abs: string, state: StateFile): Removal {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return { kind: "safe" }; // absent
  }

  if (st.isSymbolicLink()) {
    // Unlinking a symlink loses no content, but removing a link skm never placed
    // still violates "delete only state-owned paths".
    return findOwner(state, abs)
      ? { kind: "safe" }
      : { kind: "foreign", detail: "unmanaged symlink at target; not overwritten" };
  }

  if (st.isDirectory()) {
    const owner = findOwner(state, abs);
    if (owner && owner.placement.kind === "rendered") {
      // Ownership must cover the WHOLE rendered tree, not just SKILL.md — else a
      // user file added alongside SKILL.md would be silently recursive-deleted
      // (finding 2). Compare the on-disk tree hash to the one recorded at render time.
      const recordedTree = owner.placement.tree;
      if (recordedTree) {
        return treeHashOf(abs) === recordedTree
          ? { kind: "safe" } // skm's own unmodified render — safe to re-render
          : { kind: "foreign", detail: "rendered artifact modified on disk (tree changed); not overwritten" };
      }
      // Legacy fallback: a placement recorded by state schema v1 has no tree hash.
      // Use the old SKILL.md-only check; re-applying upgrades it to full-tree tracking.
      const entry = scanEntry(env, abs);
      if (entry.sha256OfSkillMd && entry.sha256OfSkillMd === owner.placement.hash) {
        return { kind: "safe" };
      }
      return { kind: "foreign", detail: "rendered artifact hand-edited on disk; not overwritten" };
    }
    return { kind: "foreign", detail: "unmanaged directory at target; not overwritten" };
  }

  if (st.isFile()) {
    // A single rendered file (agent-def). Safe iff skm owns it AND its bytes still
    // hash to what state recorded (unmodified) — else the user hand-edited it.
    const owner = findOwner(state, abs);
    if (owner && owner.placement.kind === "rendered-file") {
      const diskHash = hashContent(fs.readFileSync(abs, "utf8"));
      return diskHash === owner.placement.hash
        ? { kind: "safe" }
        : { kind: "foreign", detail: "rendered agent-def file hand-edited on disk; not overwritten" };
    }
    return { kind: "foreign", detail: "unmanaged file at target; not overwritten" };
  }

  return { kind: "foreign", detail: "unmanaged file at target; not overwritten" };
}

/** Remove whatever is at `abs` (symlink, file, or dir). No-op if absent.
 * Callers MUST gate destructive removal through classifyRemoval first. */
function removeExisting(abs: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(abs);
  } catch {
    return;
  }
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    fs.rmSync(abs, { recursive: true, force: true });
  } else {
    fs.unlinkSync(abs);
  }
}

// ── summary ──────────────────────────────────────────────────────────────────

function summarize(
  plan: Plan,
  prune: boolean,
  refused: DriftFinding[],
): { text: string; json: unknown } {
  const counts: Record<string, number> = {};
  const byType: Record<string, number> = {};
  for (const a of plan.actions) {
    if (a.type === "prune" && !prune) {
      counts["prune-skipped"] = (counts["prune-skipped"] ?? 0) + 1;
    } else {
      counts[a.type] = (counts[a.type] ?? 0) + 1;
      if (a.type !== "noop") {
        const t = a.placement.artifactType ?? "skill";
        byType[t] = (byType[t] ?? 0) + 1;
      }
    }
  }
  if (refused.length > 0) counts["refused"] = refused.length;
  const text = `Applied: ${Object.entries(counts)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ") || "no changes"}`;
  return {
    text,
    json: {
      applied: counts,
      // Artifact-type breakdown of non-noop actions (additive; AUR-616).
      byArtifactType: byType,
      planHash: plan.planHash,
      requiresPrune: plan.requiresPrune,
      prune,
      foreign: plan.foreign,
      unsafe: plan.unsafe,
      refused,
    },
  };
}
