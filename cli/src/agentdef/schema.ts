// TypeScript port of custom_agents/src/shared_agents/schema.py.
//
// Parses + validates a single agent definition from an already-parsed
// `agentYaml` mapping plus the raw `instructionsMd` body. Reproduces every
// validation the Python oracle performs (field enums, regexes, reserved-key
// guards, XOR rules, copilot target gating, skill-name normalization, and the
// resolved_* helpers). Error strings are not byte-for-byte identical to Python
// but the accept/reject decisions are.
//
// Phase-2 scope (AUR-614): parse + validate only. Nothing here is wired into
// the resolver/plan/apply engine — that is phase 3 (AUR-616).

// ─────────────────────────────────────────────────────────────────────────────
// Constants (mirrors of the Python module-level constants)
// ─────────────────────────────────────────────────────────────────────────────

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SKILL_SEPARATOR_RE = /[-_]+/g;
const NICKNAME_RE = /^[A-Za-z0-9 _-]+$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const EXPORT_MODE_VALUES = new Set(["agent", "skill", "none"]);
const SHARED_SANDBOX_VALUES = new Set(["read-only", "workspace-write", "full-access"]);
const MODEL_STRATEGY_VALUES = new Set(["pinned-defaults", "floating"]);
const CLAUDE_PERMISSION_VALUES = new Set([
  "default",
  "acceptEdits",
  "dontAsk",
  "bypassPermissions",
  "plan",
]);
const CLAUDE_EFFORT_VALUES = new Set(["low", "medium", "high", "max"]);
const CODEX_REASONING_VALUES = new Set(["low", "medium", "high", "xhigh"]);
const CODEX_SANDBOX_VALUES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const COPILOT_TARGET_VALUES = new Set(["vscode", "github-copilot"]);
const OPENCODE_MODE_VALUES = new Set(["primary", "subagent", "all"]);
const OPENCODE_THEME_COLORS = new Set([
  "primary",
  "secondary",
  "accent",
  "success",
  "warning",
  "error",
  "info",
]);

const DEFAULT_CLAUDE_MODEL = "opus-4.7";
const DEFAULT_CLAUDE_EFFORT = "high";
const DEFAULT_CODEX_MODEL = "gpt-5.5";
const DEFAULT_CODEX_REASONING_EFFORT = "high";
const DEFAULT_COPILOT_MODEL = "gpt-5.5-high";
const COPILOT_GITHUB_TARGET = "github-copilot";
const COPILOT_VSCODE_TARGET = "vscode";

const OPENCODE_RESERVED_OPTION_KEYS = new Set([
  "color",
  "description",
  "disable",
  "hidden",
  "maxSteps",
  "mode",
  "model",
  "name",
  "options",
  "permission",
  "prompt",
  "steps",
  "temperature",
  "tools",
  "top_p",
  "variant",
]);

// Harness keywords accepted in `harness.include` / `harness.exclude`.
// Mirror of custom_agents/src/shared_agents/harnesses.py HARNESS_KEYWORDS.
const HARNESS_KEYWORDS = new Set([
  "claude",
  "claude-skills",
  "codex",
  "copilot",
  "cursor",
  "opencode",
  "gemini",
  "agent-skills",
  "hermes-skills",
  "tprompt",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Error type
// ─────────────────────────────────────────────────────────────────────────────

/** Raised when an agent definition is invalid. */
export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Config value types (mirror the frozen dataclasses)
// ─────────────────────────────────────────────────────────────────────────────

export interface ClaudeConfig {
  model?: string;
  tools?: string[];
  disallowedTools?: string[];
  permissionMode?: string;
  maxTurns?: number;
  effort?: string;
  mcpServers?: unknown;
  extra: Record<string, unknown>;
}

export interface CodexConfig {
  model?: string;
  modelReasoningEffort?: string;
  sandboxMode?: string;
  nicknameCandidates?: string[];
  mcpServers?: Record<string, unknown>;
  skillsConfig: Record<string, unknown>[];
  config: Record<string, unknown>;
}

export interface CopilotConfig {
  target?: string;
  tools?: string[];
  model?: string | string[];
  agents?: string | string[];
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  infer?: boolean;
  mcpServers?: Record<string, unknown> | unknown[];
  metadata: Record<string, string>;
  argumentHint?: string;
  handoffs: Record<string, unknown>[];
  hooks?: Record<string, unknown>;
}

export interface GeminiConfig {
  tools?: string[];
  model?: string;
  temperature?: number;
  maxTurns?: number;
  timeoutMins?: number;
  mcpServers?: Record<string, unknown>;
}

export interface CursorConfig {
  model?: string;
  readonly?: boolean;
  description?: string;
}

export interface OpenCodeConfig {
  model?: string;
  variant?: string;
  temperature?: number;
  topP?: number;
  disable?: boolean;
  mode?: string;
  hidden?: boolean;
  color?: string;
  steps?: number;
  description?: string;
  permission?: Record<string, unknown>;
  tools?: Record<string, boolean>;
  options: Record<string, unknown>;
}

export interface HarnessConfig {
  include?: string[];
  exclude?: string[];
}

export interface SkillConfig {
  name?: string;
  description?: string;
  title?: string;
  tags?: string[];
  license?: string;
  compatibility?: string | string[];
  metadata: Record<string, string>;
}

export interface TpromptConfig {
  enabled: boolean;
  title?: string;
  description?: string;
  tags?: string[];
  key?: string;
  mode?: string;
  enter?: boolean;
  filename?: string;
  /** Suppress the no-subagents footer on this agent-def's prompt (default: appended). */
  footer?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentDefinition
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentDefinitionFields {
  name: string;
  description: string;
  instructions: string;
  sourceDir: string;
  export: string;
  sandbox: string;
  modelStrategy: string;
  skills: string[];
  claude: ClaudeConfig;
  codex: CodexConfig;
  copilot: CopilotConfig;
  cursor: CursorConfig;
  opencode: OpenCodeConfig;
  gemini: GeminiConfig;
  tprompt: TpromptConfig;
  harness: HarnessConfig;
  skill: SkillConfig;
}

export class AgentDefinition {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly sourceDir: string;
  readonly export: string;
  readonly sandbox: string;
  readonly modelStrategy: string;
  readonly skills: string[];
  readonly claude: ClaudeConfig;
  readonly codex: CodexConfig;
  readonly copilot: CopilotConfig;
  readonly cursor: CursorConfig;
  readonly opencode: OpenCodeConfig;
  readonly gemini: GeminiConfig;
  readonly tprompt: TpromptConfig;
  readonly harness: HarnessConfig;
  readonly skill: SkillConfig;

  constructor(fields: AgentDefinitionFields) {
    this.name = fields.name;
    this.description = fields.description;
    this.instructions = fields.instructions;
    this.sourceDir = fields.sourceDir;
    this.export = fields.export;
    this.sandbox = fields.sandbox;
    this.modelStrategy = fields.modelStrategy;
    this.skills = fields.skills;
    this.claude = fields.claude;
    this.codex = fields.codex;
    this.copilot = fields.copilot;
    this.cursor = fields.cursor;
    this.opencode = fields.opencode;
    this.gemini = fields.gemini;
    this.tprompt = fields.tprompt;
    this.harness = fields.harness;
    this.skill = fields.skill;
  }

  // Mirrors the oracle's output_name: always the agent name. The
  // tprompt.filename override is intentionally NOT applied here — it is
  // consumed only by the tprompt export channel (prompt id = filename or
  // name, plus suffix), matching generators/tprompt.py in the Python tool.
  get outputName(): string {
    return this.name;
  }

  resolvedCursorReadonly(): boolean | undefined {
    if (this.cursor.readonly !== undefined) return this.cursor.readonly;
    if (this.sandbox === "read-only") return true;
    return undefined;
  }

  resolvedOpencodeMode(): string {
    return this.opencode.mode || "subagent";
  }

  resolvedOpencodePermission(): Record<string, unknown> | undefined {
    const permission: Record<string, unknown> = {};
    if (this.sandbox === "read-only") {
      permission.edit = "deny";
      permission.bash = "deny";
    }
    if (this.opencode.permission && Object.keys(this.opencode.permission).length > 0) {
      Object.assign(permission, this.opencode.permission);
    }
    return Object.keys(permission).length > 0 ? permission : undefined;
  }

  resolvedCodexSandboxMode(): string {
    if (this.codex.sandboxMode) return this.codex.sandboxMode;
    const map: Record<string, string> = {
      "read-only": "read-only",
      "workspace-write": "workspace-write",
      "full-access": "danger-full-access",
    };
    return map[this.sandbox]!;
  }

  resolvedClaudeModel(): string {
    return this.claude.model || DEFAULT_CLAUDE_MODEL;
  }

  resolvedClaudeEffort(): string {
    return this.claude.effort || DEFAULT_CLAUDE_EFFORT;
  }

  resolvedCodexModel(): string {
    return this.codex.model || DEFAULT_CODEX_MODEL;
  }

  resolvedCodexReasoningEffort(): string {
    return this.codex.modelReasoningEffort || DEFAULT_CODEX_REASONING_EFFORT;
  }

  resolvedCopilotModel(): string | string[] {
    return this.copilot.model || DEFAULT_COPILOT_MODEL;
  }

  shouldEmitModelDefaults(): boolean {
    return this.modelStrategy === "pinned-defaults";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill-name normalization
// ─────────────────────────────────────────────────────────────────────────────

export function normalizeSkillName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(SKILL_SEPARATOR_RE, "-").replace(/^-+|-+$/g, "");
  if (!normalized || normalized.length > 64 || !SKILL_NAME_RE.test(normalized)) {
    throw new SchemaError(
      `Invalid skill name after normalization: ${JSON.stringify(value)}. ` +
        "Use 1-64 lowercase letters and digits separated by single hyphens.",
    );
  }
  return normalized;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentDefinitionInput {
  /** Already-parsed `agent.yaml` mapping (e.g. from `yaml.parse`). */
  agentYaml: unknown;
  /** Raw `instructions.md` body. */
  instructionsMd: string;
  /** Source directory (carried through; not read from disk). */
  sourceDir?: string;
  /** Label used in error messages (defaults to "agent.yaml"). */
  path?: string;
}

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse + validate an agent definition. */
export function loadAgentDefinition(input: AgentDefinitionInput): AgentDefinition {
  const path = input.path ?? "agent.yaml";
  const raw = asRootMapping(input.agentYaml, path);

  const name = requiredStr(raw, "name", path);
  validateName(name, path);
  const description = requiredStr(raw, "description", path);

  const instructions = input.instructionsMd;
  if (!instructions.trim()) {
    throw new SchemaError(`instructions.md is empty: ${path}`);
  }

  const exportMode = optionalStr(raw, "export", path) ?? "agent";
  if (!EXPORT_MODE_VALUES.has(exportMode)) {
    const allowed = [...EXPORT_MODE_VALUES].sort().join(", ");
    throw new SchemaError(`Invalid export in ${path}: ${JSON.stringify(exportMode)} (allowed: ${allowed})`);
  }

  // defaults
  const defaultsRaw = optionalMapping(raw, "defaults", path);
  rejectUnknownKeys(defaultsRaw, ["sandbox", "skills", "model_strategy"], `Unknown defaults keys in ${path}`);
  const sandbox = optionalStr(defaultsRaw, "sandbox", path) ?? "read-only";
  if (!SHARED_SANDBOX_VALUES.has(sandbox)) {
    throw new SchemaError(`Invalid defaults.sandbox in ${path}: ${JSON.stringify(sandbox)}`);
  }
  const modelStrategy = optionalStr(defaultsRaw, "model_strategy", path) ?? "pinned-defaults";
  if (!MODEL_STRATEGY_VALUES.has(modelStrategy)) {
    throw new SchemaError(`Invalid defaults.model_strategy in ${path}: ${JSON.stringify(modelStrategy)}`);
  }
  const skills = optionalStrList(defaultsRaw, "skills", path, []) as string[];

  const claude = loadClaudeConfig(raw, path);
  const codex = loadCodexConfig(raw, path);
  const copilot = loadCopilotConfig(raw, path);
  const cursor = loadCursorConfig(raw, path);
  const opencode = loadOpenCodeConfig(raw, path);
  const tprompt = loadTpromptConfig(raw, path);
  const gemini = loadGeminiConfig(raw, path);
  const harness = loadHarnessConfig(raw, path);
  const skill = loadSkillConfig(raw, path);

  rejectUnknownKeys(
    raw,
    [
      "name",
      "description",
      "export",
      "defaults",
      "claude",
      "codex",
      "copilot",
      "cursor",
      "opencode",
      "gemini",
      "tprompt",
      "harness",
      "skill",
    ],
    `Unknown top-level keys in ${path}`,
  );

  return new AgentDefinition({
    name,
    description,
    instructions,
    sourceDir: input.sourceDir ?? "",
    export: exportMode,
    sandbox,
    modelStrategy,
    skills,
    claude,
    codex,
    copilot,
    cursor,
    opencode,
    gemini,
    tprompt,
    harness,
    skill,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-block loaders
// ─────────────────────────────────────────────────────────────────────────────

function loadClaudeConfig(raw: Mapping, path: string): ClaudeConfig {
  const claudeRaw = optionalMapping(raw, "claude", path);
  const knownKeys = new Set([
    "model",
    "tools",
    "disallowed_tools",
    "permission_mode",
    "max_turns",
    "effort",
    "mcp_servers",
  ]);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(claudeRaw)) {
    if (!knownKeys.has(k)) extra[k] = v;
  }
  const permissionMode = optionalStr(claudeRaw, "permission_mode", path);
  if (permissionMode && !CLAUDE_PERMISSION_VALUES.has(permissionMode)) {
    throw new SchemaError(`Invalid claude.permission_mode in ${path}: ${JSON.stringify(permissionMode)}`);
  }
  const effort = optionalStr(claudeRaw, "effort", path);
  if (effort && !CLAUDE_EFFORT_VALUES.has(effort)) {
    throw new SchemaError(`Invalid claude.effort in ${path}: ${JSON.stringify(effort)}`);
  }
  return {
    model: optionalStr(claudeRaw, "model", path),
    tools: optionalStrList(claudeRaw, "tools", path),
    disallowedTools: optionalStrList(claudeRaw, "disallowed_tools", path),
    permissionMode,
    maxTurns: optionalInt(claudeRaw, "max_turns", path),
    effort,
    mcpServers: claudeRaw.mcp_servers,
    extra,
  };
}

function loadCodexConfig(raw: Mapping, path: string): CodexConfig {
  const codexRaw = optionalMapping(raw, "codex", path);
  rejectUnknownKeys(
    codexRaw,
    ["model", "model_reasoning_effort", "sandbox_mode", "nickname_candidates", "mcp_servers", "skills_config", "config"],
    `Unknown codex keys in ${path}`,
    "Use codex.config for additional valid Codex config fields.",
  );
  const modelReasoningEffort = optionalStr(codexRaw, "model_reasoning_effort", path);
  if (modelReasoningEffort && !CODEX_REASONING_VALUES.has(modelReasoningEffort)) {
    throw new SchemaError(`Invalid codex.model_reasoning_effort in ${path}: ${JSON.stringify(modelReasoningEffort)}`);
  }
  const sandboxMode = optionalStr(codexRaw, "sandbox_mode", path);
  if (sandboxMode && !CODEX_SANDBOX_VALUES.has(sandboxMode)) {
    throw new SchemaError(`Invalid codex.sandbox_mode in ${path}: ${JSON.stringify(sandboxMode)}`);
  }
  const nicknameCandidates = optionalStrList(codexRaw, "nickname_candidates", path);
  if (nicknameCandidates && nicknameCandidates.length > 0) {
    validateNicknameCandidates(nicknameCandidates, path);
  }
  const skillsConfig = optionalDictList(codexRaw, "skills_config", path);
  for (const entry of skillsConfig) {
    validateSkillsConfigEntry(entry, path);
  }
  const mcpServersMapping = optionalMapping(codexRaw, "mcp_servers", path);
  const mcpServers = Object.keys(mcpServersMapping).length > 0 ? mcpServersMapping : undefined;
  const config = optionalMapping(codexRaw, "config", path);
  validateCodexConfig(config, path);
  return {
    model: optionalStr(codexRaw, "model", path),
    modelReasoningEffort,
    sandboxMode,
    nicknameCandidates,
    mcpServers,
    skillsConfig,
    config,
  };
}

function loadCopilotConfig(raw: Mapping, path: string): CopilotConfig {
  const copilotRaw = optionalMapping(raw, "copilot", path);
  rejectUnknownKeys(
    copilotRaw,
    [
      "target",
      "tools",
      "model",
      "agents",
      "disable_model_invocation",
      "user_invocable",
      "infer",
      "mcp_servers",
      "metadata",
      "argument_hint",
      "handoffs",
      "hooks",
    ],
    `Unknown copilot keys in ${path}`,
  );
  // hooks: Python `_optional_mapping(...) or None` → an empty/absent mapping is None.
  const hooksMapping = optionalMapping(copilotRaw, "hooks", path);
  const config: CopilotConfig = {
    target: optionalStr(copilotRaw, "target", path),
    tools: optionalStrList(copilotRaw, "tools", path),
    model: optionalCopilotModel(copilotRaw, path),
    agents: optionalCopilotAgents(copilotRaw, path),
    disableModelInvocation: optionalBool(copilotRaw, "disable_model_invocation", path),
    userInvocable: optionalBool(copilotRaw, "user_invocable", path),
    infer: optionalBool(copilotRaw, "infer", path),
    mcpServers: optionalCopilotMcpServers(copilotRaw, path),
    metadata: optionalStrMapping(copilotRaw, "metadata", path),
    argumentHint: optionalStr(copilotRaw, "argument_hint", path),
    handoffs: optionalCopilotHandoffs(copilotRaw, path),
    hooks: Object.keys(hooksMapping).length > 0 ? hooksMapping : undefined,
  };
  if (config.target && !COPILOT_TARGET_VALUES.has(config.target)) {
    throw new SchemaError(`Invalid copilot.target in ${path}: ${JSON.stringify(config.target)}`);
  }
  validateCopilotConfig(config, path);
  return config;
}

function loadCursorConfig(raw: Mapping, path: string): CursorConfig {
  const cursorRaw = optionalMapping(raw, "cursor", path);
  rejectUnknownKeys(cursorRaw, ["model", "readonly", "description"], `Unknown cursor keys in ${path}`);
  return {
    model: optionalStr(cursorRaw, "model", path),
    readonly: optionalBool(cursorRaw, "readonly", path),
    description: optionalStr(cursorRaw, "description", path),
  };
}

function loadOpenCodeConfig(raw: Mapping, path: string): OpenCodeConfig {
  const opencodeRaw = optionalMapping(raw, "opencode", path);
  rejectUnknownKeys(
    opencodeRaw,
    ["model", "variant", "temperature", "top_p", "disable", "mode", "hidden", "color", "steps", "description", "permission", "tools", "options"],
    `Unknown opencode keys in ${path}`,
    "Use opencode.options for additional provider-specific fields.",
  );
  const config: OpenCodeConfig = {
    model: optionalStr(opencodeRaw, "model", path),
    variant: optionalStr(opencodeRaw, "variant", path),
    temperature: optionalNumber(opencodeRaw, "temperature", path),
    topP: optionalNumber(opencodeRaw, "top_p", path),
    disable: optionalBool(opencodeRaw, "disable", path),
    mode: optionalStr(opencodeRaw, "mode", path),
    hidden: optionalBool(opencodeRaw, "hidden", path),
    color: optionalStr(opencodeRaw, "color", path),
    steps: optionalInt(opencodeRaw, "steps", path),
    description: optionalStr(opencodeRaw, "description", path),
    permission: optionalMappingOrUndefined(opencodeRaw, "permission", path),
    tools: optionalBoolMapping(opencodeRaw, "tools", path),
    options: optionalMapping(opencodeRaw, "options", path),
  };
  validateOpenCodeConfig(config, path);
  return config;
}

/**
 * Parse + validate a `tprompt:` block out of an already-parsed mapping (an
 * agent.yaml root, or a skill SKILL.md frontmatter). Exported so the tprompt
 * export channel validates skill blocks with the identical rules as agent defs.
 * `enabled` is true iff the mapping declares a `tprompt` key.
 */
export function loadTpromptConfig(raw: Mapping, path: string): TpromptConfig {
  const enabled = "tprompt" in raw;
  const tpromptRaw = optionalMapping(raw, "tprompt", path);
  rejectUnknownKeys(
    tpromptRaw,
    ["title", "description", "tags", "key", "mode", "enter", "filename", "footer"],
    `Unknown tprompt keys in ${path}`,
  );
  const filename = optionalStr(tpromptRaw, "filename", path);
  if (filename !== undefined && !NAME_RE.test(filename)) {
    throw new SchemaError(
      `Invalid tprompt.filename in ${path}: ${JSON.stringify(filename)}. ` +
        "Use lowercase letters, digits, hyphens, and underscores.",
    );
  }
  return {
    enabled,
    title: optionalStr(tpromptRaw, "title", path),
    description: optionalStr(tpromptRaw, "description", path),
    tags: optionalStrList(tpromptRaw, "tags", path),
    key: optionalStr(tpromptRaw, "key", path),
    mode: optionalStr(tpromptRaw, "mode", path),
    enter: optionalBool(tpromptRaw, "enter", path),
    filename,
    footer: optionalBool(tpromptRaw, "footer", path),
  };
}

function loadGeminiConfig(raw: Mapping, path: string): GeminiConfig {
  const geminiRaw = optionalMapping(raw, "gemini", path);
  rejectUnknownKeys(
    geminiRaw,
    ["tools", "model", "temperature", "max_turns", "timeout_mins", "mcp_servers"],
    `Unknown gemini keys in ${path}`,
  );
  const mcpServersMapping = optionalMapping(geminiRaw, "mcp_servers", path);
  const config: GeminiConfig = {
    tools: optionalStrList(geminiRaw, "tools", path),
    model: optionalStr(geminiRaw, "model", path),
    temperature: optionalNumber(geminiRaw, "temperature", path),
    maxTurns: optionalInt(geminiRaw, "max_turns", path),
    timeoutMins: optionalInt(geminiRaw, "timeout_mins", path),
    mcpServers: Object.keys(mcpServersMapping).length > 0 ? mcpServersMapping : undefined,
  };
  validateGeminiConfig(config, path);
  return config;
}

function loadHarnessConfig(raw: Mapping, path: string): HarnessConfig {
  if (!("harness" in raw)) return {};
  const harnessRaw = optionalMapping(raw, "harness", path);
  rejectUnknownKeys(harnessRaw, ["include", "exclude"], `Unknown harness keys in ${path}`);
  const includePresent = "include" in harnessRaw && harnessRaw.include !== null;
  const excludePresent = "exclude" in harnessRaw && harnessRaw.exclude !== null;
  if (includePresent && excludePresent) {
    throw new SchemaError(`harness in ${path} must set only one of 'include' or 'exclude'`);
  }
  const include = includePresent ? loadHarnessKeywordList(harnessRaw, "include", path) : undefined;
  const exclude = excludePresent ? loadHarnessKeywordList(harnessRaw, "exclude", path) : undefined;
  return { include, exclude };
}

function loadHarnessKeywordList(data: Mapping, key: string, path: string): string[] {
  const value = data[key];
  if (!Array.isArray(value)) {
    throw new SchemaError(`Expected harness.${key} to be a list in ${path}`);
  }
  if (value.length === 0) {
    throw new SchemaError(`harness.${key} in ${path} must not be empty`);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      throw new SchemaError(`Expected every item in harness.${key} to be a non-empty string in ${path}`);
    }
    const keyword = item.trim();
    if (!HARNESS_KEYWORDS.has(keyword)) {
      const allowed = [...HARNESS_KEYWORDS].sort().join(", ");
      throw new SchemaError(
        `Unknown harness keyword in harness.${key} in ${path}: ${JSON.stringify(keyword)} (allowed: ${allowed})`,
      );
    }
    if (seen.has(keyword)) {
      throw new SchemaError(`Duplicate harness keyword in harness.${key} in ${path}: ${JSON.stringify(keyword)}`);
    }
    seen.add(keyword);
    result.push(keyword);
  }
  return result;
}

function loadSkillConfig(raw: Mapping, path: string): SkillConfig {
  const exportMode = optionalStr(raw, "export", path) ?? "agent";
  if (!("skill" in raw)) {
    if (exportMode === "skill") {
      normalizeSkillName(requiredStr(raw, "name", path));
    }
    return { metadata: {} };
  }
  const skillRaw = optionalMapping(raw, "skill", path);
  rejectUnknownKeys(
    skillRaw,
    ["name", "description", "title", "tags", "license", "compatibility", "metadata"],
    `Unknown skill keys in ${path}`,
  );
  const compatibility = optionalStrOrStrList(skillRaw, "compatibility", path);
  const name = optionalStr(skillRaw, "name", path);
  if (exportMode === "skill") {
    normalizeSkillName(name ?? requiredStr(raw, "name", path));
  } else if (name !== undefined) {
    normalizeSkillName(name);
  }
  return {
    name,
    description: optionalStr(skillRaw, "description", path),
    title: optionalStr(skillRaw, "title", path),
    tags: optionalStrList(skillRaw, "tags", path),
    license: optionalStr(skillRaw, "license", path),
    compatibility,
    metadata: optionalStrMapping(skillRaw, "metadata", path),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Validators
// ─────────────────────────────────────────────────────────────────────────────

function validateName(name: string, path: string): void {
  if (!NAME_RE.test(name)) {
    throw new SchemaError(
      `Invalid name in ${path}: ${JSON.stringify(name)}. Use lowercase letters, digits, hyphens, and underscores.`,
    );
  }
}

function validateNicknameCandidates(values: string[], path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new SchemaError(`Nickname candidates must be non-empty in ${path}`);
    }
    if (!NICKNAME_RE.test(trimmed)) {
      throw new SchemaError(`Invalid codex.nickname_candidates entry in ${path}: ${JSON.stringify(value)}`);
    }
    const lowered = trimmed.toLowerCase();
    if (seen.has(lowered)) {
      throw new SchemaError(`Duplicate codex.nickname_candidates entry in ${path}: ${JSON.stringify(value)}`);
    }
    seen.add(lowered);
  }
}

function validateCopilotConfig(config: CopilotConfig, path: string): void {
  if (config.target === COPILOT_GITHUB_TARGET) {
    if (Array.isArray(config.model)) {
      throw new SchemaError(`copilot.model must be a string for target '${COPILOT_GITHUB_TARGET}' in ${path}`);
    }
    if (config.mcpServers !== undefined && !isMapping(config.mcpServers)) {
      throw new SchemaError(`copilot.mcp_servers must be a mapping for target '${COPILOT_GITHUB_TARGET}' in ${path}`);
    }
    if (config.agents !== undefined) {
      throw new SchemaError(`copilot.agents is only supported for target '${COPILOT_VSCODE_TARGET}' in ${path}`);
    }
    if (config.argumentHint !== undefined) {
      throw new SchemaError(`copilot.argument_hint is only supported for target '${COPILOT_VSCODE_TARGET}' in ${path}`);
    }
    if (config.handoffs.length > 0) {
      throw new SchemaError(`copilot.handoffs is only supported for target '${COPILOT_VSCODE_TARGET}' in ${path}`);
    }
    if (config.hooks !== undefined) {
      throw new SchemaError(`copilot.hooks is only supported for target '${COPILOT_VSCODE_TARGET}' in ${path}`);
    }
    return;
  }

  if (config.target === COPILOT_VSCODE_TARGET) {
    if (Object.keys(config.metadata).length > 0) {
      throw new SchemaError(`copilot.metadata is only supported for target '${COPILOT_GITHUB_TARGET}' in ${path}`);
    }
    if (config.mcpServers !== undefined && !Array.isArray(config.mcpServers)) {
      throw new SchemaError(`copilot.mcp_servers must be a list for target '${COPILOT_VSCODE_TARGET}' in ${path}`);
    }
    return;
  }

  if (Array.isArray(config.model)) {
    throw new SchemaError(`Set copilot.target to '${COPILOT_VSCODE_TARGET}' to use a model list in ${path}`);
  }
  if (config.argumentHint !== undefined || config.handoffs.length > 0) {
    throw new SchemaError(`Set copilot.target to '${COPILOT_VSCODE_TARGET}' to use argument_hint or handoffs in ${path}`);
  }
  if (config.agents !== undefined || config.hooks !== undefined) {
    throw new SchemaError(`Set copilot.target to '${COPILOT_VSCODE_TARGET}' to use agents or hooks in ${path}`);
  }
}

function validateCopilotHandoff(handoff: Mapping, path: string): void {
  rejectUnknownKeys(handoff, ["label", "agent", "prompt", "send", "model"], `Unknown keys in copilot.handoffs entry in ${path}`);
  for (const key of ["label", "agent"]) {
    const value = handoff[key];
    if (typeof value !== "string" || !value.trim()) {
      throw new SchemaError(`copilot.handoffs.${key} must be a non-empty string in ${path}`);
    }
  }
  if ("prompt" in handoff && (typeof handoff.prompt !== "string" || !handoff.prompt.trim())) {
    throw new SchemaError(`copilot.handoffs.prompt must be a non-empty string in ${path}`);
  }
  if ("send" in handoff && typeof handoff.send !== "boolean") {
    throw new SchemaError(`copilot.handoffs.send must be a boolean in ${path}`);
  }
  if ("model" in handoff) {
    const model = handoff.model;
    if (typeof model === "string") {
      if (!model.trim()) {
        throw new SchemaError(`copilot.handoffs.model must be non-empty in ${path}`);
      }
      return;
    }
    if (Array.isArray(model)) {
      if (model.length === 0) {
        throw new SchemaError(`copilot.handoffs.model list must be non-empty in ${path}`);
      }
      for (const item of model) {
        if (typeof item !== "string" || !item.trim()) {
          throw new SchemaError(`copilot.handoffs.model items must be strings in ${path}`);
        }
      }
      return;
    }
    throw new SchemaError(`copilot.handoffs.model must be a string or list in ${path}`);
  }
}

function validateSkillsConfigEntry(entry: Mapping, path: string): void {
  if (!("name" in entry) && !("path" in entry)) {
    throw new SchemaError(`Each codex.skills_config entry must include name or path in ${path}`);
  }
  rejectUnknownKeys(entry, ["name", "path", "enabled"], `Unknown keys in codex.skills_config entry in ${path}`);
  if ("name" in entry && (typeof entry.name !== "string" || !entry.name.trim())) {
    throw new SchemaError(`codex.skills_config.name must be a non-empty string in ${path}`);
  }
  if ("path" in entry && (typeof entry.path !== "string" || !entry.path.trim())) {
    throw new SchemaError(`codex.skills_config.path must be a non-empty string in ${path}`);
  }
  if ("enabled" in entry && typeof entry.enabled !== "boolean") {
    throw new SchemaError(`codex.skills_config.enabled must be a boolean in ${path}`);
  }
}

function validateCodexConfig(config: Mapping, path: string): void {
  const forbidden = new Set([
    "name",
    "description",
    "nickname_candidates",
    "developer_instructions",
    "model",
    "model_reasoning_effort",
    "sandbox_mode",
    "mcp_servers",
    "skills",
  ]);
  const conflict = Object.keys(config).filter((k) => forbidden.has(k));
  if (conflict.length > 0) {
    const keys = conflict.sort().join(", ");
    throw new SchemaError(`codex.config in ${path} contains fields handled elsewhere: ${keys}`);
  }
}

function validateGeminiConfig(config: GeminiConfig, path: string): void {
  if (config.temperature !== undefined && !(config.temperature >= 0.0 && config.temperature <= 2.0)) {
    throw new SchemaError(`Invalid gemini.temperature in ${path}: ${config.temperature}`);
  }
  for (const fieldName of ["maxTurns", "timeoutMins"] as const) {
    const value = config[fieldName];
    if (value !== undefined && value <= 0) {
      throw new SchemaError(`Invalid gemini.${fieldName === "maxTurns" ? "max_turns" : "timeout_mins"} in ${path}: ${value}`);
    }
  }
}

function validateOpenCodeConfig(config: OpenCodeConfig, path: string): void {
  if (config.mode && !OPENCODE_MODE_VALUES.has(config.mode)) {
    throw new SchemaError(
      `Invalid opencode.mode in ${path}: ${JSON.stringify(config.mode)} (allowed: primary, subagent, all)`,
    );
  }
  if (config.temperature !== undefined && !(config.temperature >= 0 && config.temperature <= 1)) {
    throw new SchemaError(`Invalid opencode.temperature in ${path}: ${config.temperature}`);
  }
  if (config.topP !== undefined && !(config.topP >= 0 && config.topP <= 1)) {
    throw new SchemaError(`Invalid opencode.top_p in ${path}: ${config.topP}`);
  }
  if (config.steps !== undefined && config.steps <= 0) {
    throw new SchemaError(`Invalid opencode.steps in ${path}: ${config.steps}`);
  }
  if (config.color !== undefined) {
    if (!HEX_COLOR_RE.test(config.color) && !OPENCODE_THEME_COLORS.has(config.color)) {
      throw new SchemaError(`Invalid opencode.color in ${path}: ${JSON.stringify(config.color)}`);
    }
  }
  const optionConflicts = Object.keys(config.options).filter((k) => OPENCODE_RESERVED_OPTION_KEYS.has(k));
  if (optionConflicts.length > 0) {
    const keys = optionConflicts.sort().join(", ");
    throw new SchemaError(`opencode.options in ${path} contains fields handled elsewhere: ${keys}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Copilot value helpers
// ─────────────────────────────────────────────────────────────────────────────

function optionalCopilotModel(data: Mapping, path: string): string | string[] | undefined {
  if (!("model" in data) || data.model === null) return undefined;
  const value = data.model;
  if (typeof value === "string") {
    const stripped = value.trim();
    if (!stripped) throw new SchemaError(`Expected 'model' to be non-empty in ${path}`);
    return stripped;
  }
  if (Array.isArray(value)) {
    const models: string[] = [];
    for (const item of value) {
      if (typeof item !== "string" || !item.trim()) {
        throw new SchemaError(`Expected every item in 'model' to be a string in ${path}`);
      }
      models.push(item.trim());
    }
    if (models.length === 0) throw new SchemaError(`Expected 'model' list to be non-empty in ${path}`);
    return models;
  }
  throw new SchemaError(`Expected 'model' to be a string or list in ${path}`);
}

function optionalCopilotMcpServers(data: Mapping, path: string): Record<string, unknown> | unknown[] | undefined {
  if (!("mcp_servers" in data) || data.mcp_servers === null) return undefined;
  const value = data.mcp_servers;
  if (isMapping(value)) return { ...value };
  if (Array.isArray(value)) {
    const servers: unknown[] = [];
    for (const item of value) {
      if (typeof item === "string") {
        const stripped = item.trim();
        if (!stripped) {
          throw new SchemaError(`Expected every string item in 'mcp_servers' to be non-empty in ${path}`);
        }
        servers.push(stripped);
        continue;
      }
      if (isMapping(item)) {
        servers.push({ ...item });
        continue;
      }
      throw new SchemaError(`Expected every item in 'mcp_servers' to be a string or mapping in ${path}`);
    }
    return servers;
  }
  throw new SchemaError(`Expected 'mcp_servers' to be a mapping or list in ${path}`);
}

function optionalCopilotAgents(data: Mapping, path: string): string | string[] | undefined {
  if (!("agents" in data) || data.agents === null) return undefined;
  const value = data.agents;
  if (typeof value === "string") {
    const stripped = value.trim();
    if (!stripped) throw new SchemaError(`Expected 'agents' to be non-empty in ${path}`);
    return stripped;
  }
  if (Array.isArray(value)) {
    const agents: string[] = [];
    for (const item of value) {
      if (typeof item !== "string" || !item.trim()) {
        throw new SchemaError(`Expected every item in 'agents' to be a string in ${path}`);
      }
      agents.push(item.trim());
    }
    return agents;
  }
  throw new SchemaError(`Expected 'agents' to be a string or list in ${path}`);
}

function optionalCopilotHandoffs(data: Mapping, path: string): Record<string, unknown>[] {
  if (!("handoffs" in data) || data.handoffs === null) return [];
  const value = data.handoffs;
  if (!Array.isArray(value)) throw new SchemaError(`Expected 'handoffs' to be a list in ${path}`);
  const handoffs: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!isMapping(item)) {
      throw new SchemaError(`Expected every item in 'handoffs' to be a mapping in ${path}`);
    }
    const copied = { ...item };
    validateCopilotHandoff(copied, path);
    handoffs.push(copied);
  }
  return handoffs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Primitive helpers (mirror the Python `_optional_*` functions)
// ─────────────────────────────────────────────────────────────────────────────

function asRootMapping(value: unknown, path: string): Mapping {
  if (value === undefined || value === null) return {};
  if (!isMapping(value)) throw new SchemaError(`Expected a mapping in ${path}`);
  return value;
}

function absent(value: unknown): boolean {
  return value === undefined || value === null;
}

function requiredStr(data: Mapping, key: string, path: string): string {
  const value = optionalStr(data, key, path);
  if (value === undefined) {
    throw new SchemaError(`Missing required field '${key}' in ${path}`);
  }
  return value;
}

function optionalMapping(data: Mapping, key: string, path: string): Mapping {
  const value = key in data ? data[key] : {};
  if (absent(value)) return {};
  if (!isMapping(value)) throw new SchemaError(`Expected '${key}' to be a mapping in ${path}`);
  return { ...value };
}

function optionalMappingOrUndefined(data: Mapping, key: string, path: string): Mapping | undefined {
  if (!(key in data) || data[key] === null) return undefined;
  return optionalMapping(data, key, path);
}

function optionalBoolMapping(data: Mapping, key: string, path: string): Record<string, boolean> | undefined {
  const value = optionalMappingOrUndefined(data, key, path);
  if (value === undefined) return undefined;
  const result: Record<string, boolean> = {};
  for (const [itemKey, itemValue] of Object.entries(value)) {
    if (typeof itemKey !== "string" || !itemKey.trim()) {
      throw new SchemaError(`Expected every '${key}' key to be a non-empty string in ${path}`);
    }
    if (typeof itemValue !== "boolean") {
      throw new SchemaError(`Expected every '${key}' value to be a boolean in ${path}`);
    }
    result[itemKey] = itemValue;
  }
  return result;
}

function optionalStr(data: Mapping, key: string, path: string): string | undefined {
  if (absent(data[key])) return undefined;
  const value = data[key];
  if (typeof value !== "string") throw new SchemaError(`Expected '${key}' to be a string in ${path}`);
  const stripped = value.trim();
  if (!stripped) throw new SchemaError(`Expected '${key}' to be non-empty in ${path}`);
  return stripped;
}

function optionalInt(data: Mapping, key: string, path: string): number | undefined {
  if (absent(data[key])) return undefined;
  const value = data[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new SchemaError(`Expected '${key}' to be an integer in ${path}`);
  }
  return value;
}

function optionalBool(data: Mapping, key: string, path: string): boolean | undefined {
  if (absent(data[key])) return undefined;
  const value = data[key];
  if (typeof value !== "boolean") throw new SchemaError(`Expected '${key}' to be a boolean in ${path}`);
  return value;
}

function optionalNumber(data: Mapping, key: string, path: string): number | undefined {
  if (absent(data[key])) return undefined;
  const value = data[key];
  if (typeof value !== "number") throw new SchemaError(`Expected '${key}' to be a number in ${path}`);
  return value;
}

function optionalStrList(
  data: Mapping,
  key: string,
  path: string,
  fallback?: string[],
): string[] | undefined {
  if (absent(data[key])) return fallback;
  const value = data[key];
  if (!Array.isArray(value)) throw new SchemaError(`Expected '${key}' to be a list in ${path}`);
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      throw new SchemaError(`Expected every item in '${key}' to be a string in ${path}`);
    }
    items.push(item.trim());
  }
  return items;
}

function optionalStrOrStrList(data: Mapping, key: string, path: string): string | string[] | undefined {
  if (absent(data[key])) return undefined;
  const value = data[key];
  if (typeof value === "string") {
    const stripped = value.trim();
    if (!stripped) throw new SchemaError(`Expected '${key}' to be non-empty in ${path}`);
    return stripped;
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) {
      if (typeof item !== "string" || !item.trim()) {
        throw new SchemaError(`Expected every item in '${key}' to be a string in ${path}`);
      }
      items.push(item.trim());
    }
    if (items.length === 0) throw new SchemaError(`Expected '${key}' list to be non-empty in ${path}`);
    return items;
  }
  throw new SchemaError(`Expected '${key}' to be a string or list in ${path}`);
}

function optionalDictList(data: Mapping, key: string, path: string): Record<string, unknown>[] {
  if (absent(data[key])) return [];
  const value = data[key];
  if (!Array.isArray(value)) throw new SchemaError(`Expected '${key}' to be a list in ${path}`);
  const entries: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!isMapping(item)) throw new SchemaError(`Expected every item in '${key}' to be a mapping in ${path}`);
    entries.push({ ...item });
  }
  return entries;
}

function optionalStrMapping(data: Mapping, key: string, path: string): Record<string, string> {
  if (absent(data[key])) return {};
  const value = data[key];
  if (!isMapping(value)) throw new SchemaError(`Expected '${key}' to be a mapping in ${path}`);
  const result: Record<string, string> = {};
  for (const [itemKey, itemValue] of Object.entries(value)) {
    if (typeof itemKey !== "string" || !itemKey.trim()) {
      throw new SchemaError(`Expected '${key}' keys to be strings in ${path}`);
    }
    if (typeof itemValue !== "string" || !itemValue.trim()) {
      throw new SchemaError(`Expected '${key}' values to be strings in ${path}`);
    }
    result[itemKey.trim()] = itemValue.trim();
  }
  return result;
}

function rejectUnknownKeys(data: Mapping, allowed: string[], prefix: string, suffix?: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(data).filter((k) => !allowedSet.has(k));
  if (unknown.length > 0) {
    const keys = unknown.sort().join(", ");
    throw new SchemaError(`${prefix}: ${keys}${suffix ? `. ${suffix}` : ""}`);
  }
}
