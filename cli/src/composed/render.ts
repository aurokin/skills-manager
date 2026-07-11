// Composed-skill rendering (AUR-646, ADR 0010). Pure per-consumer render:
// bytes = f(source, consumer, posture). Produces the full rendered tree (SKILL.md +
// references/<provider>.md...) in memory, plus a tree-hash helper computed
// byte-compatibly with render.ts's treeHashOf so an in-memory hash equals what
// treeHashOf reports over the written directory. Owned by the rendering team.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { doc } from "../render/doc";
import { emitYamlCanonical } from "../render/emit-yaml-canonical";
import type { DesiredComposedSkill, Posture, Registry, SkillSource } from "../types";
import { END_RE, POSTURE_RE, stepFence, type FenceState } from "./schema";
import { loadComposedSkillFromDir } from "./source";

/** Relative path (posix, `/`-joined) → UTF-8 file content for one rendered consumer tree. */
export type RenderedComposedTree = Record<string, string>;

/** Conditional note appended when a dimension's rank-1 candidate was the consumer itself. */
const SELF_NOTE = "offload for parallelism/quota — you are equally strong here";

/** Caption printed immediately before the routing table (repeats read-the-reference-first). */
const TABLE_CAPTION =
  "Do not construct commands from this table — read the reference first; it is the contract.";

// ─────────────────────────────────────────────────────────────────────────────
// Posture filtering
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Drop posture blocks whose value ≠ `posture` and strip every marker line, reusing
 * schema.ts's fence tracking + marker regexes (markers only at line start, outside
 * fenced code). Grammar is validated at load, so this trusts well-formedness. Byte
 * behaviour: lines are split on "\n" and re-joined, so a marker-free string is
 * returned unchanged (trailing newline preserved).
 */
export function filterPosture(text: string, posture: Posture): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let fence: FenceState = null;
  let keep = true;
  for (const line of lines) {
    const step = stepFence(fence, line);
    const isContent = !step.isDelimiter && fence === null; // outside fences → parse markers
    fence = step.fence;
    if (isContent) {
      const pm = POSTURE_RE.exec(line);
      if (pm) {
        keep = pm[1] === posture; // open block; strip marker line
        continue;
      }
      if (END_RE.test(line)) {
        keep = true; // close block; strip marker line
        continue;
      }
    }
    if (keep) out.push(line);
  }
  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render one consumer's tree: posture filtering per source file FIRST, then slot
 * substitution. self = registry ownDir of the consumer; Enabled = declared
 * providers − self. Referenced providers (any emitted chain, primary or fallback,
 * never self) get their posture-filtered body copied to references/<provider>.md.
 */
export function renderComposedSkill(
  skill: DesiredComposedSkill,
  consumer: string,
  registry: Registry,
): RenderedComposedTree {
  const posture = skill.posture;
  // Self-exclusion is DERIVED from registry ownDir by design (ADR 0010, review
  // ruling R4): skill.yaml has no self-provider override — `selfProvider` only
  // accepts "none" and is a load-time acknowledgment, validated coherent with
  // this derivation (schema.ts), never a routing input.
  const selfId = registry.agents[consumer]?.ownDir;
  const declared = Object.keys(skill.providers);
  const enabled = new Set(declared.filter((p) => p !== selfId));
  // ALL declared providers' CLIs, sorted — regardless of which references ship (the
  // anti-recursion line must inoculate against every provider).
  const providerClis = Object.values(skill.providers)
    .map((p) => p.cli)
    .sort()
    .join(", ");

  const { table, referenced } = buildRoutingTable(skill, enabled, selfId);

  const cf = skill.consumerFiles[consumer] ?? {};
  const gate = cf.gate ? filterPosture(cf.gate, posture) : "";
  const appendix = cf.appendix ? filterPosture(cf.appendix, posture) : "";

  // Template: posture filter, then substitute slots. Structural slots first, then the
  // scalar slots so {{consumer}} / {{provider_clis}} inside a gate/appendix expand too.
  let body = filterPosture(skill.template, posture);
  body = body.replaceAll("{{routing_table}}", table);
  body = body.replaceAll("{{consumer_gate}}", gate);
  body = body.replaceAll("{{consumer_appendix}}", appendix);
  body = body.replaceAll("{{consumer}}", consumer);
  body = body.replaceAll("{{provider_clis}}", providerClis);

  const tree: RenderedComposedTree = {};
  tree["SKILL.md"] = renderSkillMd(skill.name, consumer, skill, body);

  // References: posture-filtered, {{provider_clis}}-substituted provider bodies.
  for (const providerId of [...referenced].sort()) {
    const provider = skill.providers[providerId]!;
    const refBody = filterPosture(provider.body, posture).replaceAll("{{provider_clis}}", providerClis);
    tree[`references/${providerId}.md`] = refBody;
  }
  return tree;
}

/** SKILL.md = canonical frontmatter (name + this consumer's description) + rendered body. */
function renderSkillMd(
  name: string,
  consumer: string,
  skill: DesiredComposedSkill,
  body: string,
): string {
  const description = skill.consumers[consumer]!.description;
  const yaml = emitYamlCanonical(doc().set("name", name).set("description", description).build());
  return `---\n${yaml}---\n${body}`;
}

/**
 * Build the routing table and collect referenced providers. Per dimension the row is
 * the resolved candidate chain (candidates whose provider ∈ Enabled): primary rendered
 * `provider/model`, remaining as ` (provider/model fallback)`. An empty chain drops
 * the dimension silently. When the dimension's rank-1 candidate was self, a conditional
 * note is appended (combined with any authored note on the primary).
 */
function buildRoutingTable(
  skill: DesiredComposedSkill,
  enabled: Set<string>,
  selfId: string | undefined,
): { table: string; referenced: Set<string> } {
  const referenced = new Set<string>();
  const rows: string[] = [];
  for (const dim of skill.dimensions) {
    const chain = dim.candidates.filter((c) => enabled.has(c.provider));
    if (chain.length === 0) continue; // self-exclusion / unrouted → drop silently
    const primary = chain[0]!;
    for (const c of chain) referenced.add(c.provider);

    const route =
      `${primary.provider}/${primary.model}` +
      chain
        .slice(1)
        .map((c) => ` (${c.provider}/${c.model} fallback)`)
        .join("");

    const notes: string[] = [];
    if (primary.note) notes.push(primary.note);
    if (dim.candidates[0]!.provider === selfId) notes.push(SELF_NOTE);

    const dimension = dim.title ?? dim.key;
    const when = dim.when ?? "";
    const reference = `[${primary.provider}](references/${primary.provider}.md)`;
    rows.push(`| ${dimension} | ${when} | ${route} | ${notes.join("; ")} | ${reference} |`);
  }
  const table = [
    TABLE_CAPTION,
    "| Dimension | When | Route | Note | Reference |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
  return { table, referenced };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tree hashing + writing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * sha256 over an in-memory rendered tree, byte-compatibly with render.ts's
 * treeHashOf (sorted rel path + NUL + bytes + LF). MUST equal treeHashOf over the
 * same tree written to disk.
 */
export function treeHashOfMemory(tree: RenderedComposedTree): string {
  const h = createHash("sha256");
  for (const rel of Object.keys(tree).sort()) {
    h.update(rel, "utf8");
    h.update("\0");
    h.update(Buffer.from(tree[rel]!, "utf8"));
    h.update("\n");
  }
  return `sha256:${h.digest("hex")}`;
}

/** Full-tree hash of a composed skill rendered for one consumer (the placement hash). */
export function composedTreeHash(
  skill: DesiredComposedSkill,
  consumer: string,
  registry: Registry,
): string {
  return treeHashOfMemory(renderComposedSkill(skill, consumer, registry));
}

/** Write a rendered tree into `targetDir` (mkdir -p each file's parent). */
export function writeComposedTree(tree: RenderedComposedTree, targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const rel of Object.keys(tree)) {
    const abs = path.join(targetDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, tree[rel]!);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Source reload (apply re-renders from live source, mirroring agentdef/artifact.ts)
// ─────────────────────────────────────────────────────────────────────────────

/** Re-load a composed skill from its source dir and render it for one consumer. */
export function composedTreeFromSource(
  sourceDir: string,
  name: string,
  source: SkillSource,
  consumer: string,
  registry: Registry,
): RenderedComposedTree {
  const { skill } = loadComposedSkillFromDir(sourceDir, name, source, registry);
  return renderComposedSkill(skill, consumer, registry);
}
