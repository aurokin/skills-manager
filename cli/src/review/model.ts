// The review model (ADR 0013): a versioned JSON document assembled entirely
// from engine APIs. The HTML page is a pure renderer of this model — every
// fact it shows must exist here; the template computes presentation only.

import * as fs from "node:fs";
import * as path from "node:path";
import { loadCatalogSpecs } from "../catalog-specs";
import type { SkmContext } from "../context";
import { type SkmEnv, expandTilde } from "../env";
import { computeDesiredPlacements, type DesiredPlacement } from "../placements";
import { renderComposedSkill } from "../composed/render";
import { computeDrift } from "../status";
import type { DriftClass, Posture } from "../types";

export interface ReviewFile {
  path: string;
  content: string;
}

export interface ReviewVariant {
  key: string;
  label: string;
  root: string;
  files: ReviewFile[];
  /** Drift-join result for this variant's placement, when one exists. */
  deployed?: ReviewDeployed;
}

export interface ReviewDeployed {
  path: string;
  /** "clean" = placement desired, present, no drift finding. */
  status: "clean" | DriftClass;
  detail?: string;
}

export interface ReviewMatrixCell {
  files: ReviewFile[];
}

export interface ReviewMatrix {
  consumers: { key: string; deployed?: ReviewDeployed }[];
  postures: Posture[];
  sourcePosture: Posture;
  /** Rendered cells keyed `<consumer>|<posture>`. */
  cells: Record<string, ReviewMatrixCell>;
}

export interface ReviewUnit {
  id: string;
  group: string;
  name: string;
  badges: string[];
  note?: string;
  variants: ReviewVariant[];
  matrix?: ReviewMatrix;
  /** EVERY desired placement joined against drift — including `missing` ones
   *  with nothing on disk. Variants carry content; this carries accuracy. */
  placements: ReviewDeployed[];
}

export interface ReviewInvEntry {
  name: string;
  kind: string;
  label: string;
  doc?: string;
  drift?: ReviewDeployed;
}

export interface ReviewInvDir {
  id: string;
  path: string;
  entries: ReviewInvEntry[];
}

export interface ReviewModel {
  reviewModelVersion: 1;
  built: string;
  machine: string;
  units: ReviewUnit[];
  inventory: ReviewInvDir[];
  docs: Record<string, { skill: string; files: string[] }>;
}

const DOC_FILE_LIST_CAP = 60;
const FILE_CAP = 80_000;

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Read at most FILE_CAP bytes; binary content becomes a marker, not mojibake. */
function readCapped(abs: string, size: number): string {
  const buf = Buffer.alloc(Math.min(size, FILE_CAP));
  const fd = fs.openSync(abs, "r");
  try {
    fs.readSync(fd, buf, 0, buf.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (buf.includes(0)) return `… [binary file, ${size} bytes omitted]`;
  const text = buf.toString("utf8");
  return size > FILE_CAP ? `${text}\n… [truncated: ${size} bytes total]` : text;
}

function listTree(root: string): ReviewFile[] {
  const out: ReviewFile[] = [];
  const visited = new Set<string>();
  const walk = (dir: string, rel: string) => {
    // Stat follows symlinks so linked directories walk instead of hitting
    // readFileSync; the visited set (real paths) breaks symlink cycles, and
    // broken links are skipped, not fatal.
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(abs, r);
      else if (st.isFile()) out.push({ path: r, content: readCapped(abs, st.size) });
    }
  };
  walk(root, "");
  out.sort((a, b) => {
    const w = (p: string) => (p === "SKILL.md" || p === "SKILL.tmpl.md" || p === "agent.yaml" ? 0 : p === "instructions.md" ? 1 : 2);
    return w(a.path) - w(b.path) || a.path.localeCompare(b.path);
  });
  return out;
}

function tilde(env: SkmEnv, p: string): string {
  // Component boundary: /Users/x-backup must not abbreviate under HOME /Users/x.
  return p === env.home || p.startsWith(env.home + path.sep) ? `~${p.slice(env.home.length)}` : p;
}

/** Join a placement against the drift findings: absence of a finding = clean. */
function joinDrift(
  driftByPath: Map<string, { drift: DriftClass; detail: string }>,
  env: SkmEnv,
  placementPath: string,
): ReviewDeployed {
  const finding = driftByPath.get(path.resolve(placementPath));
  return finding
    ? { path: tilde(env, placementPath), status: finding.drift, detail: finding.detail }
    : { path: tilde(env, placementPath), status: "clean" };
}

export function buildReviewModel(env: SkmEnv, ctx: SkmContext): ReviewModel {
  const { config, registry, desired, state } = ctx;
  const solved = computeDesiredPlacements(env, config, registry, desired);
  const findings = computeDrift(env, config, registry, desired, state);
  const driftByPath = new Map(findings.map((f) => [path.resolve(f.path), { drift: f.drift, detail: f.detail }]));
  // Group by artifact identity, not bare name: a native skill, an agent
  // definition, and its derived skill may all share a name. export:skill
  // placements are recorded under derivedSkillName but belong to their def.
  const skillPlacements = new Map<string, DesiredPlacement[]>();
  const agentDefPlacements = new Map<string, DesiredPlacement[]>();
  const composedPlacements = new Map<string, DesiredPlacement[]>();
  for (const dp of solved.placements) {
    const bucket = dp.desiredAgentDef
      ? { map: agentDefPlacements, key: dp.desiredAgentDef.name }
      : dp.desiredComposed
        ? { map: composedPlacements, key: dp.skill }
        : { map: skillPlacements, key: dp.skill };
    if (!bucket.map.has(bucket.key)) bucket.map.set(bucket.key, []);
    bucket.map.get(bucket.key)!.push(dp);
  }

  const rootByName = new Map(config.roots.map((r) => [r.name, r]));
  const units: ReviewUnit[] = [];
  const docs: ReviewModel["docs"] = {};

  const registerDoc = (skillDir: string): string | undefined => {
    try {
      const real = fs.realpathSync(skillDir);
      const skillMd = path.join(real, "SKILL.md");
      if (!fs.existsSync(skillMd)) return undefined;
      const key = tilde(env, real);
      if (!docs[key]) {
        // Bounded read: the cap must hold BEFORE allocation, not after.
        const text = readCapped(skillMd, fs.statSync(skillMd).size);
        const files: string[] = [];
        const visited = new Set<string>();
        const walk = (dir: string, base: string) => {
          // Same hardening as listTree: cycle guard on real paths, and a
          // broken entry skips itself instead of dropping the whole doc.
          let realDir: string;
          try {
            realDir = fs.realpathSync(dir);
          } catch {
            return;
          }
          if (visited.has(realDir)) return;
          visited.add(realDir);
          for (const f of fs.readdirSync(dir).sort()) {
            if (f.startsWith(".")) continue;
            const p = path.join(dir, f);
            let st: fs.Stats;
            try {
              st = fs.statSync(p);
            } catch {
              continue;
            }
            if (st.isDirectory()) walk(p, `${base}${f}/`);
            else if (`${base}${f}` !== "SKILL.md") files.push(`${base}${f}`);
            if (files.length > DOC_FILE_LIST_CAP) {
              files.push("…");
              return;
            }
          }
        };
        walk(real, "");
        docs[key] = { skill: text, files };
      }
      return key;
    } catch {
      return undefined;
    }
  };

  // ── Native skills (public + overlay roots), gated variants included ──
  for (const skill of desired.skills) {
    const root = rootByName.get(skill.source.root);
    const visibility = root?.visibility ?? "public";
    const group = visibility === "private" ? "Private skills" : "Public skills";
    const badges = [visibility, skill.gated ? "gated" : "symlinked"];
    const variants: ReviewVariant[] = [
      { key: "source", label: "Source", root: tilde(env, skill.source.path), files: listTree(skill.source.path) },
    ];
    const placements: ReviewDeployed[] = [];
    for (const dp of skillPlacements.get(skill.name) ?? []) {
      const p = dp.placement;
      const deployed = joinDrift(driftByPath, env, p.path);
      placements.push(deployed);
      if (skill.gated && p.kind !== "symlink" && isDir(p.path)) {
        variants.push({
          key: String(p.agent),
          label: String(p.agent),
          root: tilde(env, p.path),
          files: listTree(p.path),
          deployed,
        });
      }
    }
    // Source variant carries the aggregate: clean only when every placement is.
    if (variants[0] && placements.length) {
      variants[0].deployed = placements.find((d) => d.status !== "clean") ?? placements[0];
    }
    units.push({
      id: `${visibility}-${skill.name}`,
      group,
      name: skill.name,
      badges,
      variants,
      placements,
    });
  }

  // ── Composed skills: full consumer × posture matrix via the real renderer ──
  for (const skill of desired.composedSkills) {
    const consumers = Object.keys(skill.consumers).sort();
    const postures: Posture[] = ["sandboxed", "yolo"];
    const cells: Record<string, ReviewMatrixCell> = {};
    for (const consumer of consumers) {
      for (const posture of postures) {
        const rendered = renderComposedSkill({ ...skill, posture }, consumer, registry);
        cells[`${consumer}|${posture}`] = {
          files: Object.entries(rendered)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([p, content]) => ({ path: p, content })),
        };
      }
    }
    const skillDps = composedPlacements.get(skill.name) ?? [];
    const joinedPlacements = skillDps.map((dp) => joinDrift(driftByPath, env, dp.placement.path));
    const matrixConsumers = consumers.map((c) => {
      const dp = skillDps.find((p) => String(p.placement.agent) === c);
      return dp ? { key: c, deployed: joinDrift(driftByPath, env, dp.placement.path) } : { key: c };
    });
    units.push({
      id: `composed-${skill.name}`,
      group: "Composed skills",
      name: skill.name,
      badges: ["composed", skill.posture],
      variants: [
        { key: "source", label: "Source", root: tilde(env, skill.source.path), files: listTree(skill.source.path) },
      ],
      matrix: { consumers: matrixConsumers, postures, sourcePosture: skill.posture, cells },
      placements: joinedPlacements,
    });
  }

  // ── Agent definitions: source + every rendered placement ──
  for (const def of desired.agentDefs) {
    const variants: ReviewVariant[] = [
      { key: "source", label: "Source", root: tilde(env, def.source.path), files: listTree(def.source.path) },
    ];
    const defPlacements: ReviewDeployed[] = [];
    for (const dp of agentDefPlacements.get(def.name) ?? []) {
      const p = dp.placement;
      const deployed = joinDrift(driftByPath, env, p.path);
      defPlacements.push(deployed);
      // Variant even when the render is absent: the deployed chip must
      // surface the drift; files stay empty when unreadable. export:skill
      // renders are directory trees, export:agent renders are single files.
      variants.push({
        key: `${p.agent}`,
        label: `${p.agent}`,
        root: tilde(env, p.path),
        files: isDir(p.path)
          ? listTree(p.path)
          : isFile(p.path)
            ? [{ path: path.basename(p.path), content: readCapped(p.path, fs.statSync(p.path).size) }]
            : [],
        deployed,
      });
    }
    units.push({
      id: `agent-${def.name}`,
      group: "Agent definitions",
      name: def.name,
      badges: ["agent", def.exportMode],
      variants,
      placements: defPlacements,
    });
  }

  // ── Installed-now inventory: all registered agents' dirs ∪ state-file dirs ──
  const catalog = loadCatalogSpecs(config.roots);
  const dirIds = new Map<string, string>(); // resolved dir path → display id
  for (const [dirId, dir] of Object.entries(registry.directories)) {
    dirIds.set(expandTilde(env, dir.path), dirId);
  }
  // Recorded placement paths: ownership evidence for inventory attribution.
  // A name match alone proves nothing — the same-named dir elsewhere is foreign.
  const statePlacementPaths = new Set<string>();
  for (const artifact of Object.values(state.artifacts)) {
    for (const p of artifact.placements ?? []) {
      statePlacementPaths.add(path.resolve(p.path));
      const parent = path.dirname(p.path);
      if (!dirIds.has(parent)) dirIds.set(parent, tilde(env, parent));
    }
  }

  const rootsByRealPath = config.roots.map((r) => {
    try {
      return { root: r, real: fs.realpathSync(r.path) };
    } catch {
      return { root: r, real: r.path };
    }
  });

  const inventory: ReviewInvDir[] = [];
  for (const [dirPath, dirId] of [...dirIds.entries()].sort((a, b) => a[1].localeCompare(b[1]))) {
    if (!fs.existsSync(dirPath)) continue;
    const entries: ReviewInvEntry[] = [];
    for (const name of fs.readdirSync(dirPath).sort()) {
      if (name.startsWith(".")) continue;
      const abs = path.join(dirPath, name);
      const st = fs.lstatSync(abs);
      let kind = "dir";
      let label = "unmanaged directory";
      if (!st.isSymbolicLink() && !st.isDirectory()) {
        // Plain files: rendered agent definitions land as ~/.claude/agents/foo.md
        // etc.; anything else in a registered dir is surfaced as unmanaged.
        kind = statePlacementPaths.has(path.resolve(abs)) ? "rendered" : "file";
        label = kind === "rendered" ? "skm-rendered file" : "unmanaged file";
      } else if (st.isSymbolicLink()) {
        let target = "";
        try {
          target = fs.realpathSync(abs);
        } catch {
          kind = "broken";
          label = "broken symlink";
        }
        if (target) {
          const owner = rootsByRealPath.find((r) => target.startsWith(`${r.real}${path.sep}`));
          if (owner) {
            kind = owner.root.visibility;
            label = `ours · ${owner.root.visibility} root (${owner.root.name})`;
          } else if (catalog.bySkillName[name]) {
            kind = "upstream";
            label = `catalog-expected · ${catalog.bySkillName[name]}`;
          } else {
            kind = "link";
            label = `→ ${tilde(env, target)}`;
          }
        }
      } else if (st.isDirectory() && statePlacementPaths.has(path.resolve(abs))) {
        kind = "rendered";
        label = "skm-rendered (per-agent)";
      } else if (catalog.bySkillName[name]) {
        kind = "upstream";
        label = `catalog-expected · ${catalog.bySkillName[name]}`;
      }
      const doc = registerDoc(abs);
      const finding = driftByPath.get(path.resolve(abs));
      entries.push({
        name,
        kind,
        label,
        doc,
        drift: finding ? { path: tilde(env, abs), status: finding.drift, detail: finding.detail } : undefined,
      });
    }
    if (entries.length) inventory.push({ id: dirId, path: tilde(env, dirPath), entries });
  }

  return {
    reviewModelVersion: 1,
    built: env.clock.now(),
    machine: env.machineName,
    units,
    inventory,
    docs,
  };
}
