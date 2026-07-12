# ADR 0011: User-invoked-only skills — intent declared once, gate translated per agent

- Status: accepted
- Date: 2026-07-12

## Context

Some skills are runbooks the user triggers deliberately — the motivating
case is a fleet-update runbook that SSHes across machines and upgrades
packages. Such a skill must never be *model-invoked*: no agent should
decide on its own that "now is a good time to update the fleet." The
skill ecosystem has a field for this — `disable-model-invocation: true`
in SKILL.md frontmatter — but support is wildly uneven, and one agent
gates through a different mechanism entirely.

Every claim below was probed live on koopa (10-agent research workflow
`wf_a88d05f6-9b9`, 2026-07-11: two-dummy probes — one gated skill, one
control — per agent) plus a follow-up companion-file probe and 3-agent
vendor-file research pass (2026-07-12). The full matrix lives in the
"Gated skills + fleet-update" Linear milestone; the registry entries
added by this ADR cite it per agent.

Findings that shape the design:

- **Frontmatter gate honored** — claude-code 2.1.207 (docs + probe;
  known upstream bugs can also block the *user* half, which fails safe),
  cursor 2026.07.09, copilot 1.0.65 (**probe-only, undocumented** — no
  docs mention the field, behavior could change silently on upgrade),
  grok 0.2.93 (first-class, plus `user-invocable`), pi 0.80.2,
  droid 0.167.0 (plus a separate `user-invocable` field).
- **Frontmatter gate ignored** — codex 0.144.1, gemini 0.49.0 (source
  shows the field ignored; runtime probe was auth-blocked, so medium
  confidence), opencode 1.17.11 (upstream explicitly declined per-skill
  gating, opencode #11972), hermes 0.18.2 (zero source references).
  antigravity was not probed: unknown.
- **codex gates through a companion file, not frontmatter.** An
  `agents/openai.yaml` next to SKILL.md with
  `policy: { allow_implicit_invocation: false }` hides the skill from
  the model while an explicit `$name` mention still works (probed live).
  The schema (local authoritative copy:
  `~/.codex/skills/.system/skill-creator/references/openai_yaml.md`)
  also carries UI metadata (`interface`) and MCP dependencies
  (`dependencies.tools`); `allow_implicit_invocation` is the only
  `policy` key.
- **The companion file is a codex one-off today.** No other agent ships
  an analogous per-skill vendor file, and none reads codex's. OpenAI
  frames `agents/<vendor>.yaml` as a namespace other vendors could
  adopt, and is still iterating on the explicit-invocation contract
  (openai/codex #19695). Tool restriction (`allowed-tools`) is portable
  SKILL.md frontmatter, not companion material.
- **Shared roots leak.** A gated skill placed in `~/.agents/skills` is
  read by agents that ignore the gate (probes demonstrated the exposure
  live) — the one placement mechanism symlinked local skills default to
  is exactly the one that breaks the guarantee.

## Decision

### Intent is declared once, in the source

The author writes `disable-model-invocation: true` in the source
SKILL.md frontmatter and nothing else. That field is the *portable
intent signal*, not a literal passthrough: skm owns translating it into
whatever each agent actually enforces. No per-agent gate declarations in
overlays or skill.yaml — the research burden of "which agent needs which
mechanism" lands on the registry once, not on every skill author per
skill.

### The registry models the gate mechanism generically

Each agent entry in `registry/agents.json` gains a `skillInvocation`
block:

```jsonc
"skillInvocation": {
  "userInvocation": "slash" | "mention" | "none" | "unknown",
  "gate": "frontmatter" | "companion:agents/openai.yaml" | "none" | "unknown",
  "evidence": "…",           // citation, always required
  "probedVersion": "2.1.207", // CLI version the probe ran against
  "probedOn": "2026-07-11",   // probe date
  "note": "…"                 // optional caveat
}
```

- `userInvocation` records whether (and how) the user can still trigger
  the skill once gated — an agent where gating would make the skill
  unreachable by *anyone* (`none`) is equivalent to a no-gate agent for
  placement purposes.
- `gate` is an open enum: `frontmatter` (the agent honors
  `disable-model-invocation` in SKILL.md), `companion:<relpath>` (the
  agent honors a companion file; the path names the file so future
  vendor adoptions become new enum values, not schema changes), `none`
  (no enforceable mechanism), `unknown` (not probed — treated as `none`
  for guarantees).
- `probedVersion`/`probedOn` pin what was actually verified. Gate
  behavior is version-behavior, not spec-behavior — copilot's gate is
  entirely undocumented — so `skm doctor` (issue 2) can warn when the
  installed CLI has drifted past the probed version. Both fields are
  required whenever anything was probed, and forbidden on a fully
  `unknown` entry.

### Placement rules (implemented in the follow-up issue)

This ADR fixes the semantics; ADR-level rules the implementation must
honor:

1. **Shared roots are forbidden for gated skills.** A gated skill never
   places into `~/.agents/skills` — solver hard error, not a warning.
   Incidental no-gate readers of a *private* ownDir (e.g. opencode
   reading `~/.claude/skills`) are NOT a hard error — that would make
   claude-code unreachable for gated skills whenever opencode is
   enabled. They are surfaced as a loud gated-exposure warning in plan
   and a doctor finding, with three acknowledgment paths: the reader's
   kill switches (opencode's `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`),
   the skill's prose gate, or listing the reader in the permissive
   override (which silences the warning — explicit acceptance).
   Readers that themselves honor the frontmatter gate (cursor) are not
   exposure.
2. **Per-agent translation**: frontmatter passthrough for
   frontmatter-gate agents; companion-file emission for codex; agents
   whose gate is `none`/`unknown` are excluded from placement entirely.
3. **Permissive override**: an overlay may opt specific no-gate agents
   back in (`gating: { permissive: [...] }`) — the skill then relies on
   its prose gate ("only proceed when the user explicitly asked") for
   those agents. Explicit, per-skill, per-agent; never a default.
4. **Gated placements are rendered files, never symlinks** (a symlink
   into the repo would be byte-identical everywhere and couldn't carry
   the per-agent frontmatter or companion), and the content hash covers
   *all* placed files including the companion, reusing the composed-
   skill tree-hash machinery (ADR 0010).
5. **Doctor findings**: a gated skill found in a shared root or a
   no-gate agent's directory is a finding; probed-version drift is a
   warning.

### Only the codex emitter ships

The emitter interface is general (a gate renderer per `gate` value),
but only two renderers exist: frontmatter passthrough and the
`agents/openai.yaml` companion. We do not emit `agents/<vendor>.yaml`
for any other vendor.

## Consequences

- Skill authors get one portable line; deployment correctness stops
  depending on the author knowing eleven CLIs' gating quirks.
- Gated skills lose the symlink deployment path and shared-root reach —
  deliberately. A gated skill's audience is per-agent and intentional.
- Agents without an enforceable gate silently don't get the skill
  unless explicitly opted in — the safe default costs coverage, and the
  permissive override is the pressure valve.
- The user-invoked-only guarantee is per-agent best-effort, not
  absolute: a no-gate agent that reads another agent's private dir can
  still see the skill ungated. skm cannot close that hole without
  refusing the placement entirely, so it warns loudly instead and
  leaves the acknowledgment to the user.
- The registry gains its third probed-capability block (reads,
  agentDef, skillInvocation); validation keeps entries honest
  (enums, evidence, probe pinning) before any code consumes them.
- copilot's undocumented gate is a standing re-verification burden;
  the probed-version pin turns it from a silent risk into a doctor
  warning.

## Alternatives considered

- **Per-mechanism author declarations** (author writes the codex
  companion and per-agent fields herself): rejected — N skills × M
  agents research burden, and drift when an agent changes mechanism.
- **Strict-only, no permissive override**: rejected — the user
  explicitly wants the option to deploy a gated skill to a no-gate
  agent with prose gating ("maybe we do — it should be in the mix").
- **Speculative vendor companion files** (emit `agents/<vendor>.yaml`
  for non-codex agents on the theory they'll adopt the namespace):
  rejected — nothing reads them today; emit on evidence, not
  prophecy. The open `gate` enum keeps the door open.
- **Gate via shared-root placement + prose only**: rejected — probes
  showed real cross-agent exposure; prose is a request, not a gate.
