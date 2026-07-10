# ADR 0007: Agent definitions become a second skm artifact type; custom_agents is absorbed

- Status: accepted
- Date: 2026-07-10

## Context

`~/code/custom_agents` (`shared-agents`, Python, ~3.5k lines, last commit
2026-05-14) generates consumer-native agent/subagent definitions (Claude
`~/.claude/agents/<name>.md`, Codex `~/.codex/agents/<name>.toml`, Copilot
`.agent.md`, Cursor/OpenCode/Gemini markdown) from a shared source tree of
`agent.yaml` + `instructions.md`, with per-harness include/exclude, an
ownership manifest, and skill-bundle export modes.

It is architecturally a twin of skm: per-consumer rendering, scoping,
manifest-based delete-only-what-you-own cleanup, Hermes special-casing, and a
hardcoded copy of consumer-directory knowledge. Two live problems force the
decision:

1. **Split-brain writes.** Its `export: skill` mode writes `SKILL.md`
   bundles into `~/.claude/skills` and `~/.agents/skills` — directories skm
   now owns with its own state file. Two managers with independent ownership
   records in the same directories is the failure mode ADR 0001 rejected.
2. **Duplicated, drifting consumer knowledge.** Its output paths are
   hardcoded in Python; skm has the evidence-backed `registry/agents.json`.

## Decision

1. **Agent definitions become a first-class skm artifact type**, alongside
   skills. Sources live at `<root>/agents/<name>/agent.yaml` +
   `instructions.md` in this repo and in overlay repos (private agent
   definitions come free via ADR 0001).
2. **The registry models agent-definition targets**: each consumer gains an
   `agentDefDir` (e.g. `~/.claude/agents`, `~/.codex/agents`) and an
   agent-definition dialect (`claude-md`, `codex-toml`, `copilot-agent-md`,
   `cursor-md`, `opencode-md`, `gemini-md`), evidence-cited like skill dirs.
3. **The Python schema and generators are ported**, full schema (not just
   the slice the three shipped definitions use), per the functional spec in
   [docs/agents-import-plan.md](../agents-import-plan.md). Rendering byte
   compatibility with the Python output is the porting acceptance test
   (golden files generated from `shared-agents` while it still runs); after
   cutover, skm's output is canonical.
4. **skm machinery replaces the duplicated layers**: `resolve → solve → plan
   → apply` replaces `sync`; ownership state (ADR 0006) replaces the
   custom_agents manifest (one-time adoption imports manifest v2 entries);
   `harness.include`/`exclude` in `agent.yaml` maps onto allow/deny scoping;
   the `claude-skills` / `agent-skills` / `hermes-skills` pseudo-harnesses
   disappear — `export: skill` produces a derived skill artifact that flows
   through the **standard skill placement pipeline** (shared + claude +
   hermes-add-only, scoping and all), with two derived-skill caveats:
   placements are always rendered (there is no source `SKILL.md` to
   symlink), and artifact state keys are type-qualified so a derived skill
   colliding with a native skill is a deterministic plan-time authoring
   error, not a silent overwrite. Details in the plan.
5. **custom_agents is archived after cutover.** Its three definitions
   (plan-reviewer, codexrabbit-code-reviewer, retrorabbit-code-reviewer)
   move into this repo's `agents/`. The gitignored-`agent.yaml` +
   committed-`.example` personal-override convention is **not ported**:
   canonical `agent.yaml` is committed; personal/private overrides live in
   an overlay repo or machine config, consistent with ADR 0001/0005.
6. **Terminology**: in prose and docs, consumer tools (claude-code, codex,
   …) are called **harnesses** from now on, freeing "agent definition" for
   the artifact. `registry/agents.json` keys and existing skm identifiers
   are unchanged (renaming code is churn without behavior).

Explicitly not ported: the TUI, manifest v1 migration and ghost-entry
machinery, the legacy manifest path, the one-off stale-rename map, and the
`.example` materialization flow. The `--link-canonical` `~/.agents/agents`
symlink is dropped unless a consumer is shown to read it (registry evidence
required, per ADR 0003).

## Consequences

- One engine, one state file, one plan covers skills and agent definitions;
  overlays give private agent definitions with the same privacy guards.
- The registry gains a second per-harness surface to keep evidence-fresh.
- Codex TOML rendering must reproduce ordering and multi-line
  `developer_instructions` quirks during migration: the Python tool's
  small custom emitter is ported verbatim, with a real TOML library used
  only for round-trip validation (matching the Python architecture) — a
  general-purpose emitter cannot match its bytes. See plan for details.
- Existing installs made by `shared-agents` are adopted, not clobbered:
  anything its manifest doesn't attribute stays `foreign` under skm rules.
