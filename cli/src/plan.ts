// `skm plan` — compute desired vs state vs disk and emit a reviewable plan.
// Never mutates. Actions: create (link|render) · adopt · update · prune · noop.
// Foreign targets, unsafe (privacy) refusals, unreachable agents and bleed are
// reported alongside the actions. Owned by the plan/resolve team.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { agentDefFileHash, derivedSkillHash } from "./agentdef/artifact";
import { loadContext } from "./context";
import { type SkmEnv, expandTilde } from "./env";
import { computeDesiredPlacements, dialectForDir } from "./placements";
import { privacyViolation } from "./privacy";
import { hashContent, renderedHash } from "./render";
import { classifyTarget, scanEntry } from "./scan";
import { findOwner } from "./state";
import { resolveTpromptCollisions } from "./tprompt/channel";
import { tpromptPromptHash } from "./tprompt/render";
import type {
  DesiredPlacement,
} from "./placements";
import type {
  AgentOverrides,
  DesiredState,
  DriftFinding,
  ExitCodeValue,
  MachineConfig,
  Placement,
  Plan,
  PlannedAction,
  Registry,
  StateFile,
  VerbOptions,
  VerbOutcome,
  Warning,
} from "./types";
import { ExitCode } from "./types";

/** Verb entry: exit 0 when clean, 2 when changes are pending. */
export async function runPlan(env: SkmEnv, opts: VerbOptions): Promise<VerbOutcome> {
  const ctx = loadContext(env);
  const plan = buildPlan(env, ctx.config, ctx.registry, ctx.desired, ctx.state);
  const exitCode: ExitCodeValue = hasPendingChanges(plan) ? ExitCode.PENDING : ExitCode.CLEAN;
  return { exitCode, json: plan, human: renderPlanHuman(plan) };
}

/** Any action other than noop means work is pending. */
export function hasPendingChanges(plan: Plan): boolean {
  return plan.actions.some((a) => a.type !== "noop");
}

/** Diff desired state against ownership state + disk into a plan of actions. */
export function buildPlan(
  env: SkmEnv,
  config: MachineConfig,
  registry: Registry,
  desired: DesiredState,
  state: StateFile,
): Plan {
  const solved = computeDesiredPlacements(env, config, registry, desired);
  const actions: PlannedAction[] = [];
  const warnings: Warning[] = [...desired.warnings];
  const foreign: DriftFinding[] = [];
  const unsafe: DriftFinding[] = [];

  const desiredPaths = new Set<string>(solved.placements.map((dp) => path.resolve(dp.placement.path)));

  // tprompt flat-namespace collision guard: foreign prompts sharing a desired stem
  // are reported + skipped for that placement only (ADR 0006), never failing the
  // rest of the plan. skm-vs-skm clashes already hard-failed in the resolver.
  const tpromptPlacements = solved.placements.filter((dp) => dp.placement.channel === "tprompt");
  const { skip: tpromptSkip, foreign: tpromptForeign } = resolveTpromptCollisions(
    solved.tprompt,
    tpromptPlacements,
    state,
  );
  foreign.push(...tpromptForeign);

  for (const dp of solved.placements) {
    const p = dp.placement;

    if (p.deprecated) {
      warnings.push({
        kind: "deprecated-dir",
        skill: dp.skill,
        message: `'${dp.skill}' placed in deprecated dir '${p.dir}' (${p.path})`,
      });
    }

    // Privacy guard: refuse a private placement inside a disallowed git worktree.
    if (dp.source.visibility === "private") {
      const reason = privacyViolation(config, p.path);
      if (reason) {
        unsafe.push({ drift: "unsafe", skill: dp.skill, path: p.path, detail: reason });
        continue;
      }
    }

    // A private skill that is unscoped lands in the world-readable shared dir,
    // where every agent reads it. That is per-spec (scoping, not visibility,
    // restricts agents) but easy to do by accident, so surface it.
    if (dp.source.visibility === "private" && p.dir === "shared") {
      warnings.push({
        kind: "unscoped-shared",
        skill: dp.skill,
        message: `private skill '${dp.skill}' is unscoped → placed in the world-readable shared dir (${p.path}); add scoping to restrict which agents see it`,
      });
    }

    if (p.channel === "tprompt") {
      // Foreign stem collision → reported above, skip this placement only.
      if (!tpromptSkip.has(path.resolve(p.path))) diffTpromptFile(env, dp, state, actions, warnings, foreign);
    } else if (p.artifactType === "agent-def") {
      diffAgentDefFile(env, dp, state, actions, warnings, foreign);
    } else if (p.kind === "rendered") {
      diffRendered(env, dp, state, actions, warnings, foreign);
    } else {
      diffSymlink(env, dp, state, actions, foreign);
    }
  }

  const requiresPrune = collectPrunes(env, desiredPaths, state, actions, solved.tprompt.available);
  const planHash = planHashOf(desired.hash, actions, requiresPrune);

  return {
    version: 1,
    machine: env.machineName,
    createdAt: env.clock.now(),
    desiredStateHash: desired.hash,
    planHash,
    actions,
    warnings,
    unreachable: solved.unreachable,
    bleed: solved.bleed,
    foreign,
    unsafe,
    requiresPrune,
    channels: { tprompt: solved.tprompt },
  };
}

/** Stable hash of a plan's effect (actions + preconditions); independent of createdAt. */
export function planHashOf(
  desiredStateHash: string,
  actions: PlannedAction[],
  requiresPrune: boolean,
): string {
  // Hash a canonical JSON of the FULL action array so EVERY semantics-bearing field
  // is covered. A field left out lets a reviewed --plan file be tampered while still
  // passing the integrity check (works-1 / finding 4). Concretely, omitting:
  //   - source.path      → repoint an action at attacker content
  //   - source.visibility→ flip private→public and bypass the write-time privacy guard
  //   - placement.dir    → change dialect / override merging of a rendered artifact
  //   - placement.agent  → flip to/from hermes, changing prune exemption / ownership
  //   - placement.kind / hash / overrides → change what lands on disk
  // Keys are sorted recursively and undefined normalized so the hash is deterministic.
  const canonical = actions
    .map((a) =>
      sortKeysDeep({
        type: a.type,
        skill: a.skill,
        placement: {
          agent: a.placement.agent,
          dir: a.placement.dir,
          path: path.resolve(a.placement.path),
          kind: a.placement.kind,
          hash: a.placement.hash ?? null,
          deprecated: a.placement.deprecated ?? null,
          addOnly: a.placement.addOnly ?? null,
          bleed: a.placement.bleed ?? null,
          // Artifact type + render descriptor: omitting these would let a reviewed
          // --plan flip a skill placement to an agent-def render (or a native render
          // to a derived one) at a different target/dialect while passing integrity.
          artifactType: a.placement.artifactType ?? "skill",
          derived: a.placement.derived ?? null,
          renderDialect: a.placement.renderDialect ?? null,
          // Export channel: omitting it would let a reviewed --plan flip a tprompt
          // prompt to a harness placement (or vice versa) at the same path.
          channel: a.placement.channel ?? null,
        },
        // Prune actions carry an empty source path → normalize to null.
        source: a.source
          ? {
              root: a.source.root,
              visibility: a.source.visibility,
              path: a.source.path ? path.resolve(a.source.path) : null,
            }
          : null,
        overrides: a.overrides ? sortedOverrides(a.overrides) : null,
      }),
    )
    .sort((x, y) => {
      const xs = JSON.stringify(x);
      const ys = JSON.stringify(y);
      return xs < ys ? -1 : xs > ys ? 1 : 0;
    });
  const payload = JSON.stringify({ desiredStateHash, requiresPrune, actions: canonical });
  return `sha256:${crypto.createHash("sha256").update(payload).digest("hex")}`;
}

/** Recursively sort object keys and drop undefined so JSON.stringify is deterministic. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeysDeep(v);
    }
    return out;
  }
  return value;
}

/** Stable key-sorted view of an action's frontmatter overrides for hashing. */
function sortedOverrides(o: AgentOverrides): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(o).sort()) {
    const v = (o as Record<string, string | undefined>)[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// ── diffing ──────────────────────────────────────────────────────────────────

function baseAction(dp: DesiredPlacement, type: PlannedAction["type"], placement: Placement): PlannedAction {
  const action: PlannedAction = {
    type,
    skill: dp.skill,
    placement,
    source: dp.source,
  };
  // Overrides apply to native skill renders only; derived skills and agent-def
  // files carry no agents/*.yaml override map.
  if (dp.desiredSkill && Object.keys(dp.desiredSkill.overrides).length > 0) {
    action.overrides = dp.desiredSkill.overrides;
  }
  return action;
}

function diffSymlink(
  env: SkmEnv,
  dp: DesiredPlacement,
  state: StateFile,
  actions: PlannedAction[],
  foreign: DriftFinding[],
): void {
  const p = dp.placement;
  const owner = findOwner(state, p.path);
  const status = classifyTarget(env, p.path, dp.source.path);

  if (status === "absent") {
    actions.push(baseAction(dp, "create", p));
  } else if (status === "adopted") {
    actions.push(baseAction(dp, owner ? "noop" : "adopt", p));
  } else {
    // Foreign content at target.
    if (owner) {
      const entry = scanEntry(env, p.path);
      if (entry.kind === "symlink") {
        // Our owned symlink was re-pointed; unlinking a link loses no content → repair.
        actions.push(baseAction(dp, "create", { ...p }));
      } else {
        // A real dir/file replaced our symlink → user content. Never clobber (DEL-1).
        foreign.push({
          drift: "foreign",
          skill: dp.skill,
          path: p.path,
          detail: `owned symlink replaced by ${entry.kind}; not overwritten`,
        });
      }
    } else {
      foreign.push({ drift: "foreign", skill: dp.skill, path: p.path, detail: describeForeign(env, p.path) });
    }
  }
}

function diffRendered(
  env: SkmEnv,
  dp: DesiredPlacement,
  state: StateFile,
  actions: PlannedAction[],
  warnings: Warning[],
  foreign: DriftFinding[],
): void {
  const p = dp.placement;
  let expectedHash: string;
  if (p.derived) {
    // Derived skill: render-only SKILL.md from the agent definition (no override dialect).
    expectedHash = derivedSkillHash(dp.source.path, p.agent === "hermes");
  } else {
    const dialect = dialectForDir(p.dir);
    if (!dialect) {
      // Should not happen (only first-party dirs render); fall back to symlink diff.
      diffSymlink(env, dp, state, actions, foreign);
      return;
    }
    expectedHash = renderedHash(dp.desiredSkill!, dialect);
  }
  const rendered: Placement = { ...p, hash: expectedHash };
  const owner = findOwner(state, p.path);
  const entry = scanEntry(env, p.path);

  if (entry.kind === "absent") {
    actions.push(baseAction(dp, "create", rendered));
    return;
  }
  if (entry.kind === "dir") {
    const diskHash = entry.sha256OfSkillMd;
    if (owner) {
      if (diskHash === owner.placement.hash) {
        actions.push(baseAction(dp, owner.placement.hash === expectedHash ? "noop" : "update", rendered));
      } else {
        // Native rendered skills are repaired by `doctor --fix`; a derived skill is
        // not (applyFixes skips it), so its true remedy is to remove the file and
        // re-apply — say so rather than promise a fix doctor won't perform.
        const remedy = p.derived
          ? "remove it and re-apply to restore skm's render"
          : "doctor --fix re-renders";
        warnings.push({
          kind: "modified",
          skill: dp.skill,
          message: `rendered artifact '${dp.skill}' at ${p.path} was hand-edited; not overwritten (${remedy})`,
        });
      }
    } else if (diskHash === expectedHash) {
      actions.push(baseAction(dp, "adopt", rendered));
    } else {
      foreign.push({ drift: "foreign", skill: dp.skill, path: p.path, detail: "unmanaged directory" });
    }
    return;
  }
  // A symlink/file sits where a rendered dir belongs.
  if (owner && entry.kind === "symlink") {
    // Unlinking a link loses no content → repair by re-rendering.
    actions.push(baseAction(dp, "create", rendered));
  } else {
    foreign.push({ drift: "foreign", skill: dp.skill, path: p.path, detail: describeForeign(env, p.path) });
  }
}

/**
 * Diff a single rendered-file agent-definition placement (one file in a harness's
 * agentDefDir). Mirrors diffRendered but for a file: an absent path → create; an
 * owned file whose content hash matches state → noop/update; a hand-edited owned
 * file → warned (not overwritten); an unowned matching file → adopt; anything else
 * → foreign. Rendering the whole agentDefDir on demand is left to apply/materialize.
 */
function diffAgentDefFile(
  env: SkmEnv,
  dp: DesiredPlacement,
  state: StateFile,
  actions: PlannedAction[],
  warnings: Warning[],
  foreign: DriftFinding[],
): void {
  const p = dp.placement;
  const expectedHash = agentDefFileHash(dp.source.path, p.renderDialect!);
  const rendered: Placement = { ...p, hash: expectedHash };
  const owner = findOwner(state, p.path);
  const entry = scanEntry(env, p.path);

  if (entry.kind === "absent") {
    actions.push(baseAction(dp, "create", rendered));
    return;
  }
  if (entry.kind === "file") {
    const diskHash = hashContent(fs.readFileSync(p.path, "utf8"));
    if (owner) {
      if (diskHash === owner.placement.hash) {
        actions.push(baseAction(dp, owner.placement.hash === expectedHash ? "noop" : "update", rendered));
      } else {
        warnings.push({
          // Agent-def files are marked non-fixable by doctor and skipped by applyFixes,
          // so the accurate remedy is to remove the file and re-apply (not doctor --fix).
          kind: "modified",
          skill: dp.skill,
          message: `agent definition '${dp.skill}' at ${p.path} was hand-edited; not overwritten (remove it and re-apply to restore skm's render)`,
        });
      }
    } else if (diskHash === expectedHash) {
      actions.push(baseAction(dp, "adopt", rendered));
    } else {
      foreign.push({ drift: "foreign", skill: dp.skill, path: p.path, detail: "unmanaged file at agent-def target" });
    }
    return;
  }
  // A symlink/dir sits where a rendered file belongs.
  if (owner && entry.kind === "symlink") {
    actions.push(baseAction(dp, "create", rendered)); // unlinking a link loses nothing → re-render
  } else {
    foreign.push({ drift: "foreign", skill: dp.skill, path: p.path, detail: describeForeign(env, p.path) });
  }
}

/**
 * Diff a single tprompt prompt-file placement (ADR 0008). Structurally mirrors
 * diffAgentDefFile — an owned rendered file compared by content hash — but re-renders
 * through the tprompt channel: absent → create; owned + hash match → noop/update; a
 * hand-edited owned file → warned (not overwritten); an unowned matching file → adopt;
 * anything else → foreign.
 */
function diffTpromptFile(
  env: SkmEnv,
  dp: DesiredPlacement,
  state: StateFile,
  actions: PlannedAction[],
  warnings: Warning[],
  foreign: DriftFinding[],
): void {
  const p = dp.placement;
  const expectedHash = tpromptPromptHash(p.artifactType ?? "skill", dp.source.path);
  const rendered: Placement = { ...p, hash: expectedHash };
  const owner = findOwner(state, p.path);
  const entry = scanEntry(env, p.path);

  if (entry.kind === "absent") {
    actions.push(baseAction(dp, "create", rendered));
    return;
  }
  if (entry.kind === "file") {
    const diskHash = hashContent(fs.readFileSync(p.path, "utf8"));
    if (owner) {
      if (diskHash === owner.placement.hash) {
        actions.push(baseAction(dp, owner.placement.hash === expectedHash ? "noop" : "update", rendered));
      } else {
        warnings.push({
          kind: "modified",
          skill: dp.skill,
          message: `tprompt prompt '${dp.skill}' at ${p.path} was hand-edited; not overwritten (remove it and re-apply to restore skm's render)`,
        });
      }
    } else if (diskHash === expectedHash) {
      actions.push(baseAction(dp, "adopt", rendered));
    } else {
      foreign.push({ drift: "foreign", skill: dp.skill, path: p.path, detail: "unmanaged file at tprompt target" });
    }
    return;
  }
  // A symlink/dir sits where a rendered prompt file belongs.
  if (owner && entry.kind === "symlink") {
    actions.push(baseAction(dp, "create", rendered));
  } else {
    foreign.push({ drift: "foreign", skill: dp.skill, path: p.path, detail: describeForeign(env, p.path) });
  }
}

/** State-owned placements no longer desired become prune actions (hermes exempt). */
function collectPrunes(
  env: SkmEnv,
  desiredPaths: Set<string>,
  state: StateFile,
  actions: PlannedAction[],
  tpromptAvailable: boolean,
): boolean {
  let requiresPrune = false;
  for (const artifact of Object.values(state.artifacts)) {
    for (const sp of artifact.placements) {
      const abs = path.resolve(expandTilde(env, sp.path));
      if (desiredPaths.has(abs)) continue;
      if (sp.agent === "hermes") continue; // add-only: never pruned
      // tprompt channel unavailable → never prune owned prompts (ADR 0008): the
      // probe being down is not evidence the export is no longer wanted. When the
      // channel is up, a prompt not in desiredPaths means the block was removed
      // (or the artifact deleted) → prune normally.
      if (sp.agent === "tprompt" && !tpromptAvailable) continue;
      const placement: Placement = {
        agent: sp.agent,
        dir: sp.agent,
        path: expandTilde(env, sp.path),
        kind: sp.kind,
        hash: sp.hash,
        artifactType: artifact.type,
        ...(sp.agent === "tprompt" ? { channel: "tprompt" as const } : {}),
      };
      actions.push({ type: "prune", skill: artifact.name, placement, source: { root: artifact.source.root, visibility: artifact.source.visibility, path: "" } });
      requiresPrune = true;
    }
  }
  return requiresPrune;
}

function describeForeign(env: SkmEnv, targetPath: string): string {
  const entry = scanEntry(env, targetPath);
  if (entry.kind === "symlink") {
    return entry.broken
      ? `broken symlink -> ${entry.linkTarget ?? "?"}`
      : `unmanaged symlink -> ${entry.resolvedTarget}`;
  }
  return `unmanaged ${entry.kind}`;
}

// ── human rendering ────────────────────────────────────────────────────────

function renderPlanHuman(plan: Plan): string {
  const lines: string[] = [];
  const changes = plan.actions.filter((a) => a.type !== "noop");
  if (changes.length === 0) {
    lines.push("No changes. Placements are in sync.");
  } else {
    lines.push(`Plan: ${changes.length} action(s)`);
    for (const a of changes) {
      const verb = a.type === "create" ? `create ${a.placement.kind}` : a.type;
      const type = a.placement.artifactType ?? "skill";
      lines.push(`  ${verb.padEnd(20)} ${type.padEnd(9)} ${a.skill}  →  ${a.placement.path}`);
    }
  }
  for (const w of plan.warnings) lines.push(`  ! ${w.kind}: ${w.message}`);
  for (const u of plan.unreachable) lines.push(`  · unreachable: ${u.skill} → ${u.agent}`);
  for (const b of plan.bleed) lines.push(`  · bleed: ${b.skill} @ ${b.path} visible to ${b.readers.join(", ")}`);
  for (const f of plan.foreign) lines.push(`  × foreign: ${f.path} (${f.detail})`);
  for (const s of plan.unsafe) lines.push(`  ⚠ unsafe: ${s.skill} → ${s.path} (${s.detail})`);
  const tp = plan.channels?.tprompt;
  if (tp && !tp.available) {
    lines.push(`  · channel tprompt: unavailable (tprompt not on PATH); prompts not written, existing left untouched`);
  }
  if (plan.requiresPrune) lines.push("  (prune actions present; re-run apply with --prune to execute)");
  return lines.join("\n");
}
