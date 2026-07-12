// Domain model for skm. This is the contract every module team codes against.
// Vocabulary tracks the design doc: placement, bleed, foreign, adopt, prune,
// scoping (allow/deny), drift class, first-party rendering.

import type { SkmEnv } from "./env";
import type { AgentDefinition } from "./agentdef/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Artifact type (AUR-616, AUR-645). skm manages three artifact types now: skills,
// agent definitions, and composed skills (per-consumer rendered skills, ADR 0010).
// State keys are type-qualified (`skill:<name>` / `agent-def:<name>` /
// `composed-skill:<name>`) so a derived or composed skill can never silently
// collide with a native skill.
// ─────────────────────────────────────────────────────────────────────────────

export type ArtifactType = "skill" | "agent-def" | "composed-skill";

// ─────────────────────────────────────────────────────────────────────────────
// Agent capability registry (registry/agents.json). The record KEY is the id;
// entries carry no redundant `id` field.
// ─────────────────────────────────────────────────────────────────────────────

export type SkillsSupport = "supported" | "none" | "unknown";
export type SymlinkSupport = "followed" | "unknown";
/** Frontmatter dialect an agent parses. First-party dialects can be rendered. */
export type Dialect = "claude" | "codex" | "copilot" | "spec";

/** Whether an agent reads a user-global agent-definition (subagent) directory. */
export type AgentDefSupport = "supported" | "none" | "unknown";
/** File format/flavor of an agent-definition directory (per-harness field sets differ). */
export type AgentDefDialect = "claude" | "codex" | "copilot" | "cursor" | "opencode" | "gemini";

/** How the user can still trigger a skill once model invocation is gated off. */
export type SkillUserInvocation = "slash" | "mention" | "none" | "unknown";

/**
 * The mechanism (if any) an agent enforces `disable-model-invocation` with.
 * `companion:<relpath>` names a per-skill companion file (codex:
 * agents/openai.yaml); `unknown` is treated as `none` for guarantees.
 */
export type SkillGate = "frontmatter" | "companion:agents/openai.yaml" | "none" | "unknown";

/** Probed skill-invocation capability (ADR 0011). Consumed by gated-skill placement. */
export interface SkillInvocation {
  userInvocation: SkillUserInvocation;
  gate: SkillGate;
  /** Evidence citation, always required. */
  evidence: string;
  /** CLI version the probe ran against. Required unless fully unknown. */
  probedVersion?: string;
  /** Probe date (YYYY-MM-DD). Required unless fully unknown. */
  probedOn?: string;
  note?: string;
}

/** A global skill directory the registry knows about (keyed by dir id). */
export interface Directory {
  /** May contain a leading `~`; resolve with dirPath()/expandTilde(). */
  path: string;
  /** Deprecated upstream but still usable; flagged when chosen for scoped placement. */
  deprecated?: boolean;
  note?: string;
}

/** One agent's read graph + capabilities (keyed by agent id). */
export interface AgentCapability {
  skillsSupport: SkillsSupport;
  /** Directory ids the agent definitely reads, precedence-ordered where defined. */
  reads: string[];
  /** Unconfirmed reads — treated as reads for deny guarantees. */
  maybeReads: string[];
  /** Directory id used for scoped placement. Required when skillsSupport === "supported". */
  ownDir?: string;
  dialect: Dialect;
  symlinks: SymlinkSupport;
  /** claude-code / codex / github-copilot get rendered per-agent frontmatter. */
  firstParty?: boolean;
  /** Env vars that suppress bleed (e.g. OPENCODE_DISABLE_CLAUDE_CODE_SKILLS). */
  killSwitches?: string[];
  /** Placements are add-only; never pruned, never overwritten (hermes). */
  addOnly?: boolean;
  evidence: string;
  // ── Agent-definition (subagent) directory support (AUR-614, phase 2). ──
  // Parse/validate only; not yet wired into placement (phase 3, AUR-616).
  /** Whether this agent reads a user-global agent-definition directory. */
  agentDefSupport?: AgentDefSupport;
  /** User-global agent-definition dir (may contain a leading `~`). Present iff supported. */
  agentDefDir?: string;
  /** File format/flavor of that directory. Present iff supported. */
  agentDefDialect?: AgentDefDialect;
  /** Evidence citation for the agent-definition support decision. */
  agentDefEvidence?: string;
  // ── Skill-invocation gating capability (ADR 0011). ──
  // Consumed by the gated-skill solver (which agents honor a gate) and by
  // per-agent gate rendering (frontmatter passthrough vs companion emission).
  skillInvocation?: SkillInvocation;
}

export interface Registry {
  version: number;
  researched?: string;
  note?: string;
  directories: Record<string, Directory>;
  agents: Record<string, AgentCapability>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Machine config (~/.config/skills-manager/config.json)
// ─────────────────────────────────────────────────────────────────────────────

export type Visibility = "public" | "private";

/** A registered skills root. `path` is absolute after normalization. */
export interface Root {
  name: string;
  path: string;
  visibility: Visibility;
}

export interface MachineConfig {
  version: number;
  roots: Root[];
  /** Enabled agent ids. Defaults to supported-minus-hermes when absent. */
  agents?: string[];
  /** git origin remotes into whose worktrees private artifacts may be placed. Default []. */
  privateOriginAllowlist?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoping (catalog/agent-scopes.json for public root; <root>/overlay.json for overlays)
// ─────────────────────────────────────────────────────────────────────────────

/** allow XOR deny per skill. allow = exactly-these; deny = all-enabled-except-these. */
export interface AgentScope {
  allow?: string[];
  deny?: string[];
}

/**
 * Per-skill gated-placement override (ADR 0011). `permissive` opts named no-gate
 * agents in to receiving a gated skill in their OWN dir, relying on the skill's
 * prose gate. Each entry must name an agent whose registry gate is none/unknown —
 * naming a real-gate agent is meaningless and rejected at load time.
 */
export interface SkillGating {
  permissive: string[];
}

/** One skill's scoping-source entry: agent scoping + optional gated-placement override. */
export interface SkillScopeEntry {
  agents?: AgentScope;
  gating?: SkillGating;
}

/** Parsed scoping map — shape shared by the public catalog and overlay manifests. */
export interface ScopingSource {
  version: number;
  /** Overlay name (overlay.json); absent for the public catalog. */
  name?: string;
  note?: string;
  /** Public repo revision an overlay was tested against. */
  requiresPublic?: string;
  /** Upstream specs the overlay contributes (out of v1 scope; carried for parity). */
  upstream?: string[];
  skills: Record<string, SkillScopeEntry>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Desired state (resolved union of all roots)
// ─────────────────────────────────────────────────────────────────────────────

export interface SkillSource {
  /** Root name from config. */
  root: string;
  visibility: Visibility;
  /** Absolute path to the skill directory (contains SKILL.md). */
  path: string;
}

/** Per-agent frontmatter override files discovered under <skill>/agents/. */
export interface AgentOverrides {
  /** agents/claude.yaml — merged into claude-dir placements. */
  claude?: string;
  /** agents/copilot.yaml — merged into copilot-dir placements. */
  copilot?: string;
  /** agents/codex.yaml — merged into codex-dir placements (optional). */
  codex?: string;
  /** agents/openai.yaml — codex descriptor, shipped as-is, never merged. */
  openai?: string;
}

export interface DesiredSkill {
  name: string;
  source: SkillSource;
  /** Resolved scoping; undefined means unscoped (shared path). */
  scoping?: AgentScope;
  overrides: AgentOverrides;
  /** Parsed `tprompt:` frontmatter block (ADR 0008); present iff `enabled`. */
  tprompt?: TpromptBlock;
  /**
   * Source SKILL.md declared `disable-model-invocation: true` (ADR 0011): the skill
   * is user-invoked-only. Gated skills place ONLY into gate-honoring agents' own
   * dirs, as rendered trees (never symlinks, never a shared root).
   */
  gated?: boolean;
  /** Per-skill gated-placement override (permissive no-gate opt-ins). */
  gating?: SkillGating;
}

/**
 * A parsed `tprompt:` block (ADR 0008), shared by skills and agent definitions.
 * Structurally the schema's TpromptConfig; `enabled` reports block presence.
 */
export interface TpromptBlock {
  enabled: boolean;
  title?: string;
  description?: string;
  tags?: string[];
  key?: string;
  mode?: string;
  enter?: boolean;
  filename?: string;
  footer?: boolean;
}

/** tprompt export-channel report (availability + resolved namespace). */
export interface TpromptReport {
  /** tprompt binary on PATH — the channel probe (ADR 0008). */
  available: boolean;
  /** Primary prompts dir (the only write target). */
  promptsDir: string;
  /** Additional namespace dirs scanned for collisions (never written). */
  additionalDirs: string[];
  /** tprompt config.toml that was read, if any. */
  configPath?: string;
}

/**
 * A resolved agent definition (AUR-616). Sourced from `<root>/agents/<name>/`
 * (agent.yaml + instructions.md), parsed via loadAgentDefinition. The parsed
 * `def` is carried in memory only (never serialized); apply --plan reloads it
 * from `source.path`, matching how skills re-read SKILL.md.
 */
export interface DesiredAgentDef {
  name: string;
  source: SkillSource;
  /** export mode: "agent" | "skill" | "none". */
  exportMode: string;
  /** Normalized derived-skill name (export mode "skill" only). */
  derivedSkillName?: string;
  /** Scoping derived from `harness.include`/`exclude` (allow ∩ enabled, deny raw). */
  scoping?: AgentScope;
  /** Parsed definition (in-memory only; not part of the desired-state hash payload). */
  def: AgentDefinition;
}

// ─────────────────────────────────────────────────────────────────────────────
// Composed skill (AUR-645, ADR 0010). A per-consumer rendered skill sourced from
// `<root>/composed/<name>/` (skill.yaml + SKILL.tmpl.md + providers/*.md +
// consumers/*.md). Like DesiredAgentDef, the parsed source is carried in memory
// only (never serialized); apply --plan re-reads it from `source.path`. The render
// (bytes = f(source, consumer, posture)) and placement fan-out land in AUR-646.
// ─────────────────────────────────────────────────────────────────────────────

/** Compile-time deployment posture. Absent in skill.yaml defaults to "sandboxed". */
export type Posture = "sandboxed" | "yolo";

/** One model entry in a provider file's frontmatter `models` map. */
export interface ComposedProviderModel {
  /** The provider CLI's default model (at most one per provider by convention). */
  default?: boolean;
}

/**
 * A provider reference file (`providers/<id>.md`): YAML frontmatter (the provider
 * registry) + a markdown body. The provider id is the filename basename and must
 * match a registry directory id.
 */
export interface ComposedProvider {
  /** Frontmatter `name`. */
  name: string;
  /** Provider CLI binary (frontmatter `cli`). */
  cli: string;
  /** Frontmatter `models` map (model id → flags). */
  models: Record<string, ComposedProviderModel>;
  /** Frontmatter `verified` provenance line, if present. */
  verified?: string;
  /** Markdown body after the frontmatter (posture markers unfiltered). */
  body: string;
}

/** One ranked candidate in a dimension: a provider + the model to invoke it with. */
export interface ComposedCandidate {
  /** Provider id (a `providers/*.md` basename). */
  provider: string;
  /** Model id — must appear in that provider's frontmatter `models`. */
  model: string;
  /** Optional per-candidate note (e.g. "fable on explicit request"). */
  note?: string;
}

/** One routing dimension: an ordered candidate chain (ordering is the score). */
export interface ComposedDimension {
  key: string;
  title?: string;
  when?: string;
  candidates: ComposedCandidate[];
}

/** A declared consumer entry in skill.yaml. */
export interface ComposedConsumer {
  /** Per-consumer frontmatter description (the loader's activation trigger). */
  description: string;
  /**
   * Explicit acknowledgment that this consumer's derived self (registry ownDir)
   * is NOT one of the declared providers. Only legal value is "none".
   */
  selfProvider?: "none";
}

/** The two marker-split sections of a `consumers/<c>.md` file (both optional). */
export interface ComposedConsumerFile {
  /** `<!-- @section gate -->` content, inserted before the routing table. */
  gate?: string;
  /** `<!-- @section appendix -->` content, inserted at end of body. */
  appendix?: string;
}

export interface DesiredComposedSkill {
  name: string;
  source: SkillSource;
  posture: Posture;
  /** SKILL.tmpl.md body (raw, posture markers unfiltered); the render entry point. */
  template: string;
  /** Declared consumers keyed by agent id. */
  consumers: Record<string, ComposedConsumer>;
  /** Ordered routing dimensions. */
  dimensions: ComposedDimension[];
  /** Parsed provider reference files keyed by provider id. */
  providers: Record<string, ComposedProvider>;
  /** Parsed consumer-file sections keyed by consumer id (present iff the file exists). */
  consumerFiles: Record<string, ComposedConsumerFile>;
}

export interface DesiredState {
  skills: DesiredSkill[];
  /** Resolved agent definitions (AUR-616). */
  agentDefs: DesiredAgentDef[];
  /** Resolved composed skills (AUR-645). */
  composedSkills: DesiredComposedSkill[];
  /** Collision / deprecation / bleed notices surfaced in plan/status. */
  warnings: Warning[];
  /** Stable hash of the desired set; apply --plan refuses if it changed. */
  hash: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Placement
// ─────────────────────────────────────────────────────────────────────────────

// "rendered-file" (AUR-616) is a single rendered file (an agent-definition
// placement like ~/.claude/agents/<name>.md), hashed by file content — as opposed
// to "rendered" which is a whole directory tree containing a SKILL.md.
export type PlacementKind = "symlink" | "rendered" | "rendered-file";
/** An agent id, or the "shared" sentinel for ~/.agents/skills. */
export type PlacementTarget = string;

export interface Placement {
  agent: PlacementTarget;
  /** Directory id (or "shared"). */
  dir: string;
  /** Absolute target path. */
  path: string;
  kind: PlacementKind;
  /** sha256 of the rendered content (rendered SKILL.md, or a rendered-file's bytes). */
  hash?: string;
  /** Artifact type this placement belongs to (defaults to "skill" when absent). */
  artifactType?: ArtifactType;
  /** True for a derived-skill render (SKILL.md rendered from an agent definition). */
  derived?: boolean;
  /** agent-definition render dialect (rendered-file placements only). */
  renderDialect?: AgentDefDialect;
  /** Export channel this placement belongs to. "tprompt" routes rendering + prune
   *  through the tprompt channel; absent means the harness/skill placement. */
  channel?: "tprompt";
  /** Incidental readers of this dir beyond the intended agent(s). */
  bleed?: string[];
  /** Chosen dir is registry-flagged deprecated (e.g. codex dir); plan warns. */
  deprecated?: boolean;
  /** Add-only target (hermes): apply never prunes or overwrites it. */
  addOnly?: boolean;
  /**
   * Gated (user-invoked-only) skill placement (ADR 0011). Forces `kind: "rendered"`
   * and a full-tree `hash` (SKILL.md + any companion), reusing the composed
   * tree-hash binding; plan/status/doctor route it through the tree-hash arm.
   */
  gated?: boolean;
  /**
   * Readers of this gated placement's dir (reads OR maybeReads) that do NOT enforce
   * the gate (none/unknown/absent) and are not permissive-acknowledged — the skill
   * stays model-invocable through them (e.g. opencode reading the claude dir).
   * Advisory, never a hard error (that would make claude-code unreachable for gated
   * skills whenever opencode is enabled): plan warns, doctor warns. Present only
   * when non-empty; gated placements only.
   */
  gatedExposure?: string[];
}

/** Output of the read-graph solver for one scoped skill. */
export interface SolvedPlacement {
  skill: string;
  placements: Placement[];
  /** Allowed agents for which no usable dir exists (reported, not an error). */
  unreachable: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan
// ─────────────────────────────────────────────────────────────────────────────

export type ActionType =
  | "create" // new placement to materialize (symlink or rendered — see placement.kind)
  | "adopt" // pre-existing correct artifact → record into state, no fs change
  | "update" // rendered artifact re-rendered (source changed)
  | "prune" // owned placement no longer desired → delete (requires --prune)
  | "noop"; // desired placement already present and owned

export interface PlannedAction {
  type: ActionType;
  skill: string;
  placement: Placement;
  /** Skill source (root/visibility/path) — carried so apply --plan can materialize. */
  source?: SkillSource;
  /** Per-agent frontmatter overrides — carried for rendered create/update/adopt. */
  overrides?: AgentOverrides;
  reason?: string;
}

export type WarningKind =
  | "collision"
  | "missing-dir"
  | "deprecated-dir"
  | "bleed"
  | "unscoped-shared"
  | "frontmatter"
  | "modified"
  // A composed-skill provider file on disk that no dimension references (AUR-645).
  | "unused-provider"
  // A path owned in state by one artifact key but desired under another (AUR-646):
  // the plan refuses the placement rather than write over or zombie-own it.
  | "ownership-handoff"
  // A gated placement's dir has readers that do not enforce the gate and are not
  // permissive-acknowledged (ADR 0011); advisory, placement still proceeds.
  | "gated-exposure";

export interface Warning {
  kind: WarningKind;
  skill?: string;
  message: string;
}

/** An allowed agent for which the solver found no usable directory. */
export interface UnreachableEntry {
  skill: string;
  agent: string;
  reason?: string;
}

/** Incidental readers of a placement's directory beyond the intended agent(s). */
export interface BleedEntry {
  skill: string;
  path: string;
  agent: string;
  readers: string[];
}

export interface Plan {
  version: number;
  machine: string;
  createdAt: string;
  /** Hash of the desired state this plan was computed from. */
  desiredStateHash: string;
  /** Stable hash of the plan's actions (apply --plan integrity check). */
  planHash: string;
  actions: PlannedAction[];
  warnings: Warning[];
  /** Allowed agents with no usable dir (reported, not an error). */
  unreachable: UnreachableEntry[];
  /** Incidental visibility per placement. */
  bleed: BleedEntry[];
  /** Unmanaged content at a desired target → skipped, never touched. */
  foreign: DriftFinding[];
  /** Private artifacts refused (disallowed git worktree). */
  unsafe: DriftFinding[];
  /** True when any prune action is present (apply needs --prune to execute them). */
  requiresPrune: boolean;
  /** Export-channel status surfaced to plan/status output (ADR 0008). */
  channels?: { tprompt: TpromptReport };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ownership state (~/.local/state/skills-manager/state.json)
// ─────────────────────────────────────────────────────────────────────────────

export interface StatePlacement {
  /** Agent id or "shared". */
  agent: PlacementTarget;
  path: string;
  kind: PlacementKind;
  /** sha256 of the rendered SKILL.md (rendered placements; used for `modified` detection). */
  hash?: string;
  /**
   * sha256 over the FULL rendered artifact tree (rendered placements only, state
   * schema v2+). Deletion safety compares this to the on-disk tree so a user file
   * added inside the rendered dir blocks recursive deletion (finding 2). Absent on
   * artifacts recorded by schema v1 — see classifyRemoval's legacy fallback.
   */
  tree?: string;
  /**
   * Gated (user-invoked-only) skill placement (ADR 0011). A gated skill is a native
   * skill (artifact type stays "skill"), so status/doctor cannot key its tree-hash
   * semantics off the artifact type the way composed skills do; this per-placement
   * flag records that `hash`/`tree` are full-tree hashes, not a SKILL.md sha. Additive
   * and ignored by older skm (which degrades to refusing updates, never mis-deleting),
   * so no STATE_VERSION bump is warranted.
   */
  gated?: boolean;
}

export interface Artifact {
  /** Artifact type (state schema v3+). Absent entries predate the type qualifier. */
  type: ArtifactType;
  /** Bare artifact name (the state key is `${type}:${name}`). */
  name: string;
  source: { root: string; visibility: Visibility };
  placements: StatePlacement[];
}

export interface StateFile {
  version: number;
  machine: string;
  artifacts: Record<string, Artifact>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Drift & doctor findings
// ─────────────────────────────────────────────────────────────────────────────

export type DriftClass = "missing" | "stale" | "modified" | "foreign" | "unsafe";

export interface DriftFinding {
  drift: DriftClass;
  skill?: string;
  /** Artifact type of the drifting placement (additive; absent on foreign/unsafe scans). */
  artifactType?: ArtifactType;
  path: string;
  detail: string;
}

/** Classification of what currently sits at a placement target. */
export type TargetStatus = "absent" | "adopted" | "owned" | "foreign";

export type FindingSeverity = "info" | "warn" | "error";
export type FindingCategory =
  | "broken-link"
  | "deny-violation"
  | "registry-contradiction"
  | "private-leak"
  | "foreign"
  | "env-suggestion"
  | "reconcile"
  // An agent definition's default-skills entry names a skill hidden from (or
  // absent for) the harness the definition is placed on (AUR-616).
  | "skill-reference"
  // A gated skill discovered on disk where its gate is not enforced: a shared root,
  // or a no-gate agent's dir without a permissive override (ADR 0011).
  | "gated-leak"
  // The installed CLI version drifted from the registry's probed gate version for an
  // agent actually receiving gated skills (ADR 0011); the gate may behave differently.
  | "gate-version-drift";

export interface Finding {
  category: FindingCategory;
  severity: FindingSeverity;
  message: string;
  skill?: string;
  path?: string;
  fixable: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// explain output
// ─────────────────────────────────────────────────────────────────────────────

export interface SkillExplanation {
  name: string;
  /** Which artifact type this is ("skill" or "agent-def"). */
  artifactType: ArtifactType;
  source: SkillSource;
  scoping?: AgentScope;
  placements: Placement[];
  /** Allowed agents with no usable dir. */
  unreachable: string[];
  /** placement path → incidental readers. */
  bleed: Record<string, string[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

export interface RenderResult {
  /** Directory the rendered copy was written to. */
  path: string;
  /** sha256 of the rendered SKILL.md. */
  hash: string;
  /** sha256 over the full rendered artifact tree (deletion-safety ownership). */
  tree?: string;
  /** Files written into the rendered dir. */
  files: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit
// ─────────────────────────────────────────────────────────────────────────────

export interface AuditEntry {
  timestamp: string;
  machine: string;
  operator: string;
  verb: string;
  planHash?: string;
  summary: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI plumbing
// ─────────────────────────────────────────────────────────────────────────────

export interface VerbOptions {
  json: boolean;
  prune: boolean;
  yes: boolean;
  planFile?: string;
  fix: boolean;
  /** Legacy in-repo agents_home for `adopt custom-agents` (--agents-home). */
  agentsHome?: string;
  /** Positional args (e.g. `explain <skill>`, `root add <path>`). */
  args: string[];
}

/** What a verb returns to the CLI shell, which prints json vs human and exits. */
export interface VerbOutcome {
  exitCode: number;
  /** Stable --json shape. */
  json: unknown;
  /** Human-pretty rendering for a TTY. */
  human: string;
}

export type VerbHandler = (env: SkmEnv, opts: VerbOptions) => Promise<VerbOutcome>;

/** Terraform detailed-exitcode convention. */
export const ExitCode = {
  CLEAN: 0,
  ERROR: 1,
  PENDING: 2,
} as const;
export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
