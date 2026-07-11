// Composed-skill source validation (AUR-645, ADR 0010). Parses + validates one
// composed skill from its already-read source files (skill.yaml mapping, the
// SKILL.tmpl.md body, provider files, and consumer files) plus the registry.
// Mirrors the accept/reject discipline of agentdef/schema.ts. The render pipeline
// (bytes = f(source, consumer, posture)) and placement fan-out are AUR-646; this
// module is the data layer only.

import { parse as parseYaml } from "yaml";
import type {
  ComposedCandidate,
  ComposedConsumer,
  ComposedConsumerFile,
  ComposedDimension,
  ComposedProvider,
  ComposedProviderModel,
  DesiredComposedSkill,
  Posture,
  Registry,
  SkillSource,
  Warning,
} from "../types";

/** Raised when a composed-skill source is invalid. */
export class ComposedSkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposedSkillError";
  }
}

/** The two posture values. Absent `posture:` defaults to "sandboxed" (type default). */
const POSTURE_VALUES = new Set<Posture>(["sandboxed", "yolo"]);

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

export interface ComposedSkillInput {
  /** Artifact name (the `composed/<name>/` directory name). */
  name: string;
  source: SkillSource;
  /** Label used in error messages (the skill.yaml path). */
  path: string;
  /** Already-parsed skill.yaml mapping. */
  skillYaml: unknown;
  /** SKILL.tmpl.md contents, or undefined when the file is absent. */
  template: string | undefined;
  /** Provider files keyed by id (basename minus .md) → raw file text. */
  providerFiles: Record<string, string>;
  /** Consumer files keyed by id (basename minus .md) → raw file text. */
  consumerFiles: Record<string, string>;
  registry: Registry;
}

/**
 * Parse + validate one composed skill. Returns the desired carrier plus any
 * non-fatal warnings (surfaced the same way skill/plan warnings are). Throws
 * ComposedSkillError on the first build-time violation.
 */
export function loadComposedSkill(input: ComposedSkillInput): {
  skill: DesiredComposedSkill;
  warnings: Warning[];
} {
  const { name, source, path, registry } = input;
  const raw = asRootMapping(input.skillYaml, path);
  rejectUnknownKeys(raw, ["name", "posture", "consumers", "dimensions"], `Unknown top-level keys in ${path}`);

  // name is required for authoring clarity; the directory name is authoritative
  // (mirrors how skills/agent-defs key by directory, not frontmatter name).
  requiredStr(raw, "name", path);

  const postureStr = optionalStr(raw, "posture", path) ?? "sandboxed";
  if (!POSTURE_VALUES.has(postureStr as Posture)) {
    throw new ComposedSkillError(
      `Invalid posture in ${path}: ${JSON.stringify(postureStr)} (allowed: sandboxed, yolo)`,
    );
  }
  const posture = postureStr as Posture;

  const consumers = parseConsumers(raw, path);
  const dimensions = parseDimensions(raw, path);
  const providers = parseProviders(input.providerFiles, path);

  // SKILL.tmpl.md must exist (the body template is not optional).
  if (input.template === undefined) {
    throw new ComposedSkillError(`Missing SKILL.tmpl.md for composed skill '${name}' (${path})`);
  }

  // Every provider filename must name a registry directory id — the guard that
  // keeps provider-id space aligned with directory-id space (droid's ownDir is
  // `factory`, so this alignment is a coincidence of the v1 set, not an invariant).
  for (const providerId of Object.keys(providers)) {
    if (!(providerId in registry.directories)) {
      throw new ComposedSkillError(
        `provider file 'providers/${providerId}.md' does not match any registry directory id (${path})`,
      );
    }
  }

  validateDimensions(dimensions, providers, path);

  // Posture-marker well-formedness across the template, all provider bodies, and
  // all consumer files. Filtering itself is AUR-646; this only rejects malformed
  // grammar so a later compile cannot silently drop content.
  validatePostureMarkers(input.template, `${name}/SKILL.tmpl.md`, false);
  for (const [id, provider] of Object.entries(providers)) {
    validatePostureMarkers(provider.body, `${name}/providers/${id}.md`, false);
  }
  for (const id of Object.keys(input.consumerFiles).sort()) {
    if (!(id in consumers)) {
      throw new ComposedSkillError(
        `consumer file 'consumers/${id}.md' does not match any declared consumer (${path})`,
      );
    }
  }
  for (const [id, text] of Object.entries(input.consumerFiles)) {
    validatePostureMarkers(text, `${name}/consumers/${id}.md`, true);
  }

  validateConsumersAgainstRegistry(consumers, providers, registry, path);

  const consumerFiles: Record<string, ComposedConsumerFile> = {};
  for (const [id, text] of Object.entries(input.consumerFiles)) {
    consumerFiles[id] = splitConsumerSections(text);
  }

  const warnings = unusedProviderWarnings(name, providers, dimensions);

  const skill: DesiredComposedSkill = {
    name,
    source,
    posture,
    consumers,
    dimensions,
    providers,
    consumerFiles,
  };
  return { skill, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// skill.yaml — consumers + dimensions
// ─────────────────────────────────────────────────────────────────────────────

function parseConsumers(raw: Mapping, path: string): Record<string, ComposedConsumer> {
  const map = requiredMapping(raw, "consumers", path);
  const out: Record<string, ComposedConsumer> = {};
  for (const [id, value] of Object.entries(map)) {
    if (!isMapping(value)) {
      throw new ComposedSkillError(`Expected consumer '${id}' to be a mapping in ${path}`);
    }
    rejectUnknownKeys(value, ["description", "selfProvider"], `Unknown keys for consumer '${id}' in ${path}`);
    // A missing/empty description silently disables the skill in the loader, so it
    // is a build error, not a warning.
    const description = requiredStr(value, "description", `${path} (consumer '${id}')`);
    const consumer: ComposedConsumer = { description };
    if ("selfProvider" in value && value.selfProvider !== undefined && value.selfProvider !== null) {
      if (value.selfProvider !== "none") {
        throw new ComposedSkillError(
          `Invalid selfProvider for consumer '${id}' in ${path}: only "none" is allowed`,
        );
      }
      consumer.selfProvider = "none";
    }
    out[id] = consumer;
  }
  return out;
}

function parseDimensions(raw: Mapping, path: string): ComposedDimension[] {
  const list = raw.dimensions;
  if (list === undefined || list === null) {
    throw new ComposedSkillError(`Missing required field 'dimensions' in ${path}`);
  }
  if (!Array.isArray(list)) {
    throw new ComposedSkillError(`Expected 'dimensions' to be a list in ${path}`);
  }
  return list.map((entry, i) => {
    if (!isMapping(entry)) {
      throw new ComposedSkillError(`Expected dimension #${i + 1} to be a mapping in ${path}`);
    }
    rejectUnknownKeys(entry, ["key", "title", "when", "candidates"], `Unknown keys in dimension #${i + 1} in ${path}`);
    const key = requiredStr(entry, "key", `${path} (dimension #${i + 1})`);
    const dim: ComposedDimension = { key, candidates: parseCandidates(entry, key, path) };
    const title = optionalStr(entry, "title", `${path} (dimension '${key}')`);
    if (title !== undefined) dim.title = title;
    const when = optionalStr(entry, "when", `${path} (dimension '${key}')`);
    if (when !== undefined) dim.when = when;
    return dim;
  });
}

function parseCandidates(entry: Mapping, key: string, path: string): ComposedCandidate[] {
  const list = entry.candidates;
  if (!Array.isArray(list)) {
    throw new ComposedSkillError(`Expected 'candidates' to be a list in dimension '${key}' (${path})`);
  }
  return list.map((c, i) => {
    if (!isMapping(c)) {
      throw new ComposedSkillError(`Expected candidate #${i + 1} in dimension '${key}' to be a mapping (${path})`);
    }
    rejectUnknownKeys(c, ["provider", "model", "note"], `Unknown keys in candidate #${i + 1} of dimension '${key}' in ${path}`);
    const label = `${path} (dimension '${key}', candidate #${i + 1})`;
    const candidate: ComposedCandidate = {
      provider: requiredStr(c, "provider", label),
      model: requiredStr(c, "model", label),
    };
    const note = optionalStr(c, "note", label);
    if (note !== undefined) candidate.note = note;
    return candidate;
  });
}

function validateDimensions(
  dimensions: ComposedDimension[],
  providers: Record<string, ComposedProvider>,
  path: string,
): void {
  const seenKeys = new Set<string>();
  for (const dim of dimensions) {
    if (seenKeys.has(dim.key)) {
      throw new ComposedSkillError(`Duplicate dimension key '${dim.key}' in ${path}`);
    }
    seenKeys.add(dim.key);

    if (dim.candidates.length === 0) {
      throw new ComposedSkillError(`Dimension '${dim.key}' has no candidates in ${path}`);
    }

    const seenProviders = new Set<string>();
    for (const c of dim.candidates) {
      if (seenProviders.has(c.provider)) {
        throw new ComposedSkillError(`Dimension '${dim.key}' lists provider '${c.provider}' twice in ${path}`);
      }
      seenProviders.add(c.provider);

      const provider = providers[c.provider];
      if (!provider) {
        throw new ComposedSkillError(
          `Dimension '${dim.key}' references provider '${c.provider}' with no providers/${c.provider}.md file (${path})`,
        );
      }
      if (!(c.model in provider.models)) {
        throw new ComposedSkillError(
          `Dimension '${dim.key}' candidate names model '${c.model}' not in providers/${c.provider}.md frontmatter (${path})`,
        );
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry-derived consumer guards (support, self-derivation, one-dir-per-consumer)
// ─────────────────────────────────────────────────────────────────────────────

function validateConsumersAgainstRegistry(
  consumers: Record<string, ComposedConsumer>,
  providers: Record<string, ComposedProvider>,
  registry: Registry,
  path: string,
): void {
  const dirToConsumer = new Map<string, string>();
  for (const [id, consumer] of Object.entries(consumers)) {
    const agent = registry.agents[id];
    if (!agent) {
      throw new ComposedSkillError(`Consumer '${id}' is not a known agent (${path})`);
    }
    if (agent.skillsSupport !== "supported") {
      throw new ComposedSkillError(
        `Consumer '${id}' has skillsSupport '${agent.skillsSupport}', must be 'supported' (${path})`,
      );
    }
    const selfDir = agent.ownDir;
    if (selfDir === undefined) {
      // supported agents always declare an ownDir (registry-validated), but guard.
      throw new ComposedSkillError(`Consumer '${id}' has no ownDir in the registry (${path})`);
    }

    // Self-derivation: the consumer's "self" provider is its registry ownDir. When
    // that self is NOT one of the declared providers, an explicit selfProvider:none
    // acknowledgment is required (a silent no-op is indistinguishable from a routing
    // mistake, e.g. droid whose ownDir `factory` is no provider).
    if (!(selfDir in providers) && consumer.selfProvider !== "none") {
      throw new ComposedSkillError(
        `Consumer '${id}' derives self-provider '${selfDir}' (registry ownDir) which is not a declared provider; ` +
          `add 'selfProvider: none' to its skill.yaml entry to acknowledge this (${path})`,
      );
    }

    // Two consumers resolving to the same target ownDir would fight over one output
    // directory (a build error, from registry data alone).
    const prior = dirToConsumer.get(selfDir);
    if (prior !== undefined) {
      throw new ComposedSkillError(
        `Consumers '${prior}' and '${id}' both resolve to output directory '${selfDir}' (${path})`,
      );
    }
    dirToConsumer.set(selfDir, id);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider files (frontmatter registry + body)
// ─────────────────────────────────────────────────────────────────────────────

function parseProviders(files: Record<string, string>, path: string): Record<string, ComposedProvider> {
  const out: Record<string, ComposedProvider> = {};
  for (const [id, text] of Object.entries(files)) {
    out[id] = parseProvider(id, text, path);
  }
  return out;
}

function parseProvider(id: string, text: string, path: string): ComposedProvider {
  const split = splitFrontmatter(text);
  if (split === undefined) {
    throw new ComposedSkillError(`provider file 'providers/${id}.md' has no YAML frontmatter (${path})`);
  }
  const label = `${path} (providers/${id}.md)`;
  const data = asRootMapping(split.data, label);
  rejectUnknownKeys(data, ["name", "cli", "models", "verified"], `Unknown provider frontmatter keys in ${label}`);
  const name = requiredStr(data, "name", label);
  const cli = requiredStr(data, "cli", label);
  const models = parseModels(data, label);
  const provider: ComposedProvider = { name, cli, models, body: split.body };
  const verified = optionalStr(data, "verified", label);
  if (verified !== undefined) provider.verified = verified;
  return provider;
}

function parseModels(data: Mapping, label: string): Record<string, ComposedProviderModel> {
  const value = data.models;
  if (value === undefined || value === null) return {};
  if (!isMapping(value)) throw new ComposedSkillError(`Expected 'models' to be a mapping in ${label}`);
  const out: Record<string, ComposedProviderModel> = {};
  for (const [model, flags] of Object.entries(value)) {
    if (flags === undefined || flags === null) {
      out[model] = {};
      continue;
    }
    if (!isMapping(flags)) {
      throw new ComposedSkillError(`Expected model '${model}' entry to be a mapping in ${label}`);
    }
    rejectUnknownKeys(flags, ["default"], `Unknown keys for model '${model}' in ${label}`);
    const entry: ComposedProviderModel = {};
    if ("default" in flags && flags.default !== undefined && flags.default !== null) {
      if (typeof flags.default !== "boolean") {
        throw new ComposedSkillError(`Expected 'default' for model '${model}' to be a boolean in ${label}`);
      }
      entry.default = flags.default;
    }
    out[model] = entry;
  }
  return out;
}

/** Provider file present on disk but referenced by no dimension → a warning. */
function unusedProviderWarnings(
  name: string,
  providers: Record<string, ComposedProvider>,
  dimensions: ComposedDimension[],
): Warning[] {
  const referenced = new Set<string>();
  for (const dim of dimensions) {
    for (const c of dim.candidates) referenced.add(c.provider);
  }
  const warnings: Warning[] = [];
  for (const id of Object.keys(providers).sort()) {
    if (!referenced.has(id)) {
      warnings.push({
        kind: "unused-provider",
        skill: name,
        message: `composed skill '${name}' has provider file 'providers/${id}.md' referenced by no dimension`,
      });
    }
  }
  return warnings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Posture markers + consumer sections
// ─────────────────────────────────────────────────────────────────────────────

const POSTURE_RE = /^<!--\s*@posture\s+(.+?)\s*-->\s*$/;
const END_RE = /^<!--\s*@end\s*-->\s*$/;
const SECTION_RE = /^<!--\s*@section\s+(.+?)\s*-->\s*$/;

type FenceState = { char: string; len: number } | null;

/**
 * CommonMark-style fence tracking for one line: ``` and ~~~ fences, up to three
 * leading spaces, runs longer than three, and closers that must match the opener
 * char with at least its length and carry nothing but whitespace. Returns the new
 * state and whether this line is itself a fence delimiter.
 */
function stepFence(fence: FenceState, line: string): { fence: FenceState; isDelimiter: boolean } {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return { fence, isDelimiter: false };
  const run = m[1]!;
  const char = run[0]!;
  const rest = m[2] ?? "";
  if (fence === null) {
    // A backtick opener's info string may not contain backticks (CommonMark);
    // such a line is inline code, not a fence.
    if (char === "`" && rest.includes("`")) return { fence, isDelimiter: false };
    return { fence: { char, len: run.length }, isDelimiter: true };
  }
  if (char === fence.char && run.length >= fence.len && rest.trim() === "") {
    return { fence: null, isDelimiter: true };
  }
  return { fence, isDelimiter: false };
}

/**
 * Validate posture-marker grammar in one source file. Markers are recognized only
 * at line start and outside fenced code blocks. `@posture <value>` must name a
 * declared posture; every block is closed by `@end` before EOF; no nesting; and
 * (consumer files only, `trackSections`) no block may cross an `@section` boundary.
 */
export function validatePostureMarkers(text: string, label: string, trackSections: boolean): void {
  const lines = text.split("\n");
  let fence: FenceState = null;
  let openPosture: string | null = null;
  let openLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const step = stepFence(fence, line);
    fence = step.fence;
    if (step.isDelimiter || fence !== null) continue;

    const pm = POSTURE_RE.exec(line);
    if (pm) {
      if (openPosture !== null) {
        throw new ComposedSkillError(
          `${label}: nested @posture block at line ${i + 1} (inside @posture ${openPosture} opened at line ${openLine})`,
        );
      }
      const value = pm[1] ?? "";
      if (!POSTURE_VALUES.has(value as Posture)) {
        throw new ComposedSkillError(
          `${label}: unknown @posture value '${value}' at line ${i + 1} (allowed: sandboxed, yolo)`,
        );
      }
      openPosture = value;
      openLine = i + 1;
      continue;
    }

    if (END_RE.test(line)) {
      if (openPosture === null) {
        throw new ComposedSkillError(`${label}: @end without an open @posture block at line ${i + 1}`);
      }
      openPosture = null;
      continue;
    }

    if (trackSections && SECTION_RE.test(line) && openPosture !== null) {
      throw new ComposedSkillError(
        `${label}: @posture block (opened at line ${openLine}) crosses an @section boundary at line ${i + 1}`,
      );
    }
  }
  if (openPosture !== null) {
    throw new ComposedSkillError(
      `${label}: unclosed @posture ${openPosture} block (opened at line ${openLine}); missing @end before EOF`,
    );
  }
}

/**
 * Split a consumer file into its `gate` and `appendix` sections. A section starts
 * at its `<!-- @section <name> -->` marker (line start, outside code fences) and
 * runs to the next section marker or EOF. Content before the first marker and
 * unknown section names are ignored (posture grammar is validated separately).
 */
export function splitConsumerSections(text: string): ComposedConsumerFile {
  const lines = text.split("\n");
  const buffers: Record<string, string[]> = {};
  let fence: FenceState = null;
  let current: string | null = null;
  for (const line of lines) {
    const step = stepFence(fence, line);
    const isContent = !step.isDelimiter && fence === null;
    fence = step.fence;
    const sm = isContent ? SECTION_RE.exec(line) : null;
    if (sm) {
      const section = sm[1] ?? "";
      current = section;
      buffers[section] ??= [];
      continue;
    }
    if (current) buffers[current]!.push(line);
  }
  const out: ComposedConsumerFile = {};
  if (buffers.gate) out.gate = buffers.gate.join("\n").trim();
  if (buffers.appendix) out.appendix = buffers.appendix.join("\n").trim();
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small parsing helpers (local; mirror agentdef/schema.ts discipline)
// ─────────────────────────────────────────────────────────────────────────────

/** Split `---\n<yaml>\n---\n<body>`. Returns undefined when no frontmatter fence. */
function splitFrontmatter(text: string): { data: unknown; body: string } | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return undefined;
  let data: unknown;
  try {
    data = parseYaml(m[1] ?? "");
  } catch (err) {
    throw new ComposedSkillError(`invalid YAML frontmatter: ${(err as Error).message}`);
  }
  return { data, body: m[2] ?? "" };
}

function asRootMapping(value: unknown, path: string): Mapping {
  if (value === undefined || value === null) return {};
  if (!isMapping(value)) throw new ComposedSkillError(`Expected a mapping in ${path}`);
  return value;
}

function requiredMapping(data: Mapping, key: string, path: string): Mapping {
  const value = data[key];
  if (value === undefined || value === null) {
    throw new ComposedSkillError(`Missing required field '${key}' in ${path}`);
  }
  if (!isMapping(value)) throw new ComposedSkillError(`Expected '${key}' to be a mapping in ${path}`);
  return value;
}

function requiredStr(data: Mapping, key: string, path: string): string {
  const value = optionalStr(data, key, path);
  if (value === undefined) throw new ComposedSkillError(`Missing required field '${key}' in ${path}`);
  return value;
}

function optionalStr(data: Mapping, key: string, path: string): string | undefined {
  const value = data[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ComposedSkillError(`Expected '${key}' to be a string in ${path}`);
  const stripped = value.trim();
  if (!stripped) throw new ComposedSkillError(`Expected '${key}' to be non-empty in ${path}`);
  return stripped;
}

function rejectUnknownKeys(data: Mapping, allowed: string[], prefix: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(data).filter((k) => !allowedSet.has(k));
  if (unknown.length > 0) {
    throw new ComposedSkillError(`${prefix}: ${unknown.sort().join(", ")}`);
  }
}
