# ADR 0016: Data-only agent variants — registry-driven render channels, enablement, and per-consumer provider exclusion

- Status: accepted
- Date: 2026-07-19
- Amends: [ADR 0010](0010-composed-skills-artifact-type.md) (additive consumer
  key), [ADR 0011](0011-user-invoked-only-skill-gating.md) (gated allow mode
  intersects enablement)

## Context

Registering a new agent — concretely a `CLAUDE_CONFIG_DIR` profile of the
claude binary ("super-claude"), a second claude-dialect agent with its own
config home and a native multi-provider model roster — exposed every place the
engine hardcoded per-agent knowledge instead of reading the registry:

1. Four sibling hardcodes of the {claude, copilot, codex} render set
   (`placements.ts DIR_DIALECT`, `gated.ts FIRST_PARTY_DIR_DIALECT`,
   `solver.ts renderKind`, and the `overrides.claude` branch of
   `solveUnscoped`) — a new claude-dialect dir would silently receive
   un-rendered symlinks where `~/.claude/skills` gets rendered overrides.
2. `solveUnscoped` enumerated shared + claude unconditionally plus
   antigravity/hermes branches — a new own-dir-only agent silently received no
   unscoped skills, and a host disabling claude-code still had
   `~/.claude/skills` populated.
3. `defaultEnabledAgents` hardcoded the hermes carve-out — a new registry agent
   auto-enabled fleet-wide.
4. Allow lists bypassed machine enablement (`scope.allow` used verbatim) in the
   scoped and gated solvers and agent-def fan-out, while composed consumers
   already intersected.
5. The composed-skill exclusion axis was self-only: a consumer that routes a
   provider's model family *natively* (shelling out to that CLI is
   redundant-self, not delegation) was inexpressible — ADR 0010 R4 restricts
   `selfProvider` to the `"none"` acknowledgment by design.

## Decision

All five become registry/skill-source **data**:

- **Render channel derivation** (`render.ts dialectForDir`): a dir renders iff
  its owning agent (`ownDir` == dir) is `firstParty: true` and its dialect ∈
  `RENDERER_DIALECTS` (a constant owned by the render code). `firstParty` is
  hereby defined as "has a first-party per-dialect frontmatter render channel";
  a config-home variant of a first-party binary qualifies. A renderer dialect
  *without* `firstParty` is legal and means deliberate symlink-only.
- **`unscopedOwnDir: true`** (registry agent field): when enabled, the agent
  receives unscoped skills in its own dir; kind from the derivation, add-only
  from the existing `addOnly` flag. claude-code, antigravity, and hermes
  migrate to the field; the enumeration is deleted. grok deliberately lacks it
  (reached only via maybeReads — recorded on its registry entry). Intended
  behavior change: a host that disables claude-code stops receiving unscoped
  placements in `~/.claude/skills`. Unscoped placements stay bleed-exempt (an
  unscoped skill is intended for every reader); the shared placement is not an
  agent and stays a literal.
- **`optIn: true`** (registry agent field) replaces the hermes hardcode in
  `defaultEnabledAgents`. Machine config gains **`optInAgents`** (additive to
  the default set); declaring both `agents` and `optInAgents` is a config
  error, and both lists are registry-validated. Defaulting moves out of the
  config loader into `enabledAgents()` so raw presence stays checkable.
- **Allow ∩ enabled** in the scoped solver, gated solver, and agent-def
  fan-out: an allow-listed agent the machine disables is skipped and surfaced
  as a reason-tagged unreachable entry (`agent disabled on this machine`) —
  the pre-existing `UnreachableEntry.reason` field, no new plan row kind.
  Deliberate asymmetry: only allow mode surfaces the skip (explicit intent);
  deny/unscoped filter disabled agents silently as before.
- **`excludeProviders`** (composed skill.yaml, per consumer): declared
  providers excluded from that consumer's routing beyond the derived self.
  Namespace-local validation (declared provider, no duplicates, never the
  derived self — mirroring the `selfProvider` coherence checks). R4 stands:
  this is an additive exclusion axis, not a self override. All-chains-empty
  renders a well-formed placeholder line instead of a dangling table header;
  `{{provider_clis}}` still lists every declared CLI. `excludeProviders`
  joins the composed selection fingerprint (a change refuses a stale
  reviewed plan once).

## Consequences

- Registering a variant is pure data: registry entry + machine opt-in +
  overlay scoping + composed consumer. See README "Registering an agent
  variant".
- The composed selection-fingerprint canonicalization changed (adds
  `excludeProviders`), so `desiredStateHash` differs across this upgrade;
  placements and actions are byte-identical (guarded by tests).
- The gate-version probe maps `super-claude` to the `claude` binary
  (same executable).
- Two registry entries for one binary means two `probedVersion` bumps per
  re-probe — accepted at one variant; `variantOf` inheritance was considered
  and deferred until a third variant exists.
