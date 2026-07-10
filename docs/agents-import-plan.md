# Plan: Absorb custom_agents into skm (agent definitions + tprompt export)

- Status: draft for implementation (next phase after `feat/skm-cli`)
- Date: 2026-07-10
- Decisions: [ADR 0007](adr/0007-agent-definitions-artifact-type.md) (agent
  definitions as artifact type), [ADR 0008](adr/0008-tprompt-export.md)
  (tprompt export channel), [ADR 0009](adr/0009-dialect-document-emitter-rendering.md)
  (dialect → document AST → emitter rendering). Research grounded in source dives of
  `~/code/custom_agents` @ 6eacdbe (tests: 210 pass; 2 TUI-only failures
  from a missing optional dep) and `~/code/tprompt`.

## 1. What is being absorbed

`shared-agents` renders `agents/<name>/{agent.yaml, instructions.md}` into
per-harness native files, tracks them in a manifest, and cleans only what it
owns. skm replaces its sync/clean/manifest/selection layers wholesale; what
must be genuinely ported is the **schema** and the **renderers**.

### Source schema (port in full)

`agent.yaml` top-level keys: `name`, `description`, `export`
(`agent|skill|none`), `defaults` (`sandbox`, `model_strategy`, `skills`),
per-harness blocks (`claude`, `codex`, `copilot`, `cursor`, `opencode`,
`gemini`, `tprompt`), `harness` (`include` XOR `exclude`), `skill`.
Highlights the port must preserve exactly:

- `name` regex `^[a-z0-9][a-z0-9_-]*$`; unknown top-level keys are errors.
- `defaults.model_strategy`: `pinned-defaults` emits resolved default
  model/effort per harness; `floating` emits only explicit values.
- `defaults.sandbox` (`read-only|workspace-write|full-access`) maps into
  harness vocabulary (codex `sandbox_mode`, cursor `readonly`, opencode
  permission injection `{edit: deny, bash: deny}` when read-only).
- Escape hatches with reserved-key guards: `codex.config`,
  `opencode.options`, `claude` unknown-key passthrough (`extra`).
- Copilot `target` gating (`vscode` vs `github-copilot`) with
  mutually-exclusive field sets.
- `skill:` block + skill-name normalization (lowercase, `[-_]+`→`-`,
  `^[a-z0-9]+(-[a-z0-9]+)*$`, ≤64).

Reference: custom_agents `src/shared_agents/schema.py` (validation rules,
value enums, per-field line references live in the research report and the
Python source, which stays available as the oracle until cutover).

### Renderers (port with golden-file byte compatibility)

| Dialect | Target (registry `agentDefDir`) | Notes |
|---|---|---|
| claude-md | `~/.claude/agents/<name>.md` | YAML frontmatter, insertion-ordered; camelCase renames (`disallowedTools`, `permissionMode`, `maxTurns`, `mcpServers`) |
| codex-toml | `~/.codex/agents/<name>.toml` | `developer_instructions` = full body as TOML multi-line string; ordering scalars→tables→array-tables; `skills.config` merge + dedup |
| copilot-agent-md | `~/.copilot/agents/<name>.agent.md` (`$COPILOT_HOME` honored) | hyphenated keys; target-dependent fields |
| cursor-md | `~/.cursor/agents/<name>.md` | `readonly` resolved from sandbox |
| opencode-md | `~/.config/opencode/agents/<name>.md` | **no `name` key**; `mode` default `subagent`; resolved `permission` |
| gemini-md | `~/.gemini/agents/<name>.md` | `mcpServers` |
| (skill export) | standard skill pipeline (render-only) | `# {title}` + `## Instructions` + `## Source Notes` body shape; `metadata.source: custom_agents` becomes `skm`; hermes adds `metadata.hermes`. **Exempt from byte-equality**: semantic equality with declared substitutions (source string, "shared agent" wording), since ADR 0007 renames the generator strings |

Golden files are captured from the Python tool's **pure render functions**
(or a fully isolated `HOME`/XDG sandbox) — never by running `shared-agents
sync` against the live home, which would recreate the two-managers hazard
during capture. Ported Python unit-test fixtures are the primary golden
source; the fixture set must include long/unicode descriptions and nested
`mcp_servers` maps, not just the three real definitions (whose short-ASCII,
floating-strategy shape exercises almost none of the formatting surface).
Byte-equality is the acceptance bar during migration (except the derived
skill dialect, above); post-cutover, skm's output is canonical and goldens
may be regenerated deliberately.

### Selection precedence → skm mapping

custom_agents resolves per-definition harness sets as: available ∩ CLI
include − CLI exclude ∩ `harness.include` − `harness.exclude`, then export
mode filters (skill mode keeps only skill targets, with `hermes-skills`
opt-in only), then tprompt drops without a `tprompt:` block. In skm:

- available → registry `skillsSupport`/`agentDefSupport` + probes (tprompt
  binary is the only probe).
- `harness.include`/`exclude` → per-artifact allow/deny scoping, same
  semantics as skills (deny remains a hard guarantee). Agent-definition
  placements are *expected* to be own-dir with no cross-harness reads, but
  that is an assumption, not evidence — the phase-1 registry evidence pass
  must confirm which harnesses read which `agents/` dirs (see §5), and any
  cross-read found gets the same bleed modeling as skill dirs.
- Export modes: `agent` → agent-def placements only; `skill` → a **derived
  skill artifact**; `none` → resolved but placed nowhere. Derived skills
  need three rules the old tool never faced:
  - **Render-only.** A derived skill has no source `SKILL.md` to symlink;
    every placement (shared, claude, hermes) is a rendered, hashed artifact
    (ADR 0004 kind `rendered`), written independently per target — matching
    the old tool's independent copies. The symlink cheap-path never applies.
  - **Type-qualified namespace.** State keys become type-qualified
    (`skill:<name>` / `agent-def:<name>`); a derived skill whose normalized
    name collides with a native skill's placement path is an authoring
    error and hard-fails the plan (deterministic, before any mutation).
  - **Hermes opt-in mapping.** The old per-definition
    `harness.include: [hermes-skills]` opt-in maps to allow-scoping that
    includes `hermes`; machine-config hermes enablement still gates it
    (both required, matching skills semantics). This is a behavior change
    from the old CLI-flag opt-in; no shipped definition uses it.
- CLI `--agents/--harness` filters → not ported as flags; `skm plan/apply`
  operate on the whole desired state (partial syncs were a workaround for
  not having a differ).

### State/manifest adoption

One-time `skm adopt custom-agents` (or automatic on first plan when the
manifest exists): read manifest **v2** at
`$XDG_STATE_HOME/custom_agents/.shared-agents-manifest.json` **and** the
legacy in-repo location `<agents_home>/.shared-agents-manifest.json` (the
Python `load_manifest` still reads both; entries recorded only in the
legacy file must not be orphaned as foreign), convert attributed
`{agent, path}` entries into skm-owned placements (verifying the file
exists and matches a current render or marking it `stale`), ignore ghost
(`agent: ""`) entries, and leave the manifests untouched (archived with
the repo). v1 manifests are NOT supported — upgrade via the Python tool
first if ever encountered.

skm's own state schema bumps for the new artifact type with an explicit
forward-migration rule: read any older supported version, upgrade in
memory, write the current version; never hard-fail on an older state file
(only on a newer-than-supported one, per existing `state.ts` semantics).

## 2. tprompt export (ADR 0008 specifics)

- Prompts-dir resolution: parse tprompt `config.toml` (`prompts_dir`,
  `$XDG_CONFIG_HOME` aware); fall back to `~/.config/tprompt/prompts`.
- Render: frontmatter `title`, `description`, `tags` (declared + stamped
  `skm` and `agent-def|skill`), optional `key/mode/enter`; body = artifact
  instructions; agent-def prompts append the no-subagents footer
  (suppressible via `tprompt.footer: false`), skill prompts never do.
- Filename: `<tprompt.filename or name>-ca.md`. Collision handling respects
  both tprompt's flat-namespace locked decision and ADR 0006: the guard
  scans the **entire resolved tprompt namespace** — `prompts_dir` plus
  `additional_prompts_dirs` from `config.toml` — not just skm's own
  artifacts. skm-owned-vs-skm-owned stem clashes are authoring errors and
  hard-fail the plan; clashes against foreign prompts (user-dropped files,
  other dirs) are reported as `foreign`/skipped for that placement only,
  never failing the rest of the apply.
- Availability: `tprompt` binary on PATH; otherwise plan lists the channel
  as unavailable with a note, and existing owned prompt placements are left
  untouched (never pruned due to unavailability).
- No subprocess use; atomic writes; placements owned in state like any
  other.

## 3. Phases

Same delivery process as `feat/skm-cli`: each phase is an adversarially
reviewed workflow (multi-lens review + refutation panels), diffwarden gate
with the default reviewer set (both reviewers) before merge, sandboxed
tests only, read-only verbs against the real machine.

1. **Schema + registry.** TS port of the full `agent.yaml` schema with
   validation-parity tests derived from the Python test suite; registry
   gains `agentDefDir` + dialect per harness. **Gate:** the evidence pass
   on which harnesses actually read their `agents/` dirs (open question,
   §5) must be resolved in this phase — it determines the dialect set and
   phase 5's reap list, so it is a blocker, not a cosmetic follow-up.
   Verify: schema fixtures accept/reject identically to Python; registry
   entries cite evidence per ADR 0003.
2. **Renderers + goldens.** Build the ADR 0009 pipeline: Document AST, the
   `yaml-pyyaml-compat` and `toml-codex-compat` emitters with adversarial
   fixture suites, then all six agent-def dialects plus the derived skill
   body; migrate the existing skill renderer onto the same pipeline.
   Golden-file byte-equality tests per (dialect, emitter) binding.
   Verify: `bun test` goldens incl. long/unicode/nested fixtures; the
   three real definitions render byte-identically.
3. **Resolver/solver/state integration.** `agents/` sources in public +
   overlay roots; type-qualified artifact keys, plan actions, ownership
   state (schema bump with the read-old/write-new rule above), prune
   safety extended; cross-type collision check (derived skill vs native
   skill); `doctor` cross-reference check for `defaults.skills` entries
   that name skills hidden from (or absent for) the target harness;
   `skm adopt custom-agents` reading both manifest locations.
   Verify: e2e sandbox — fresh apply, adoption from fixture manifests
   (XDG + legacy), old-state-version upgrade, prune gating, deny scoping,
   cross-type collision hard-fail.
4. **tprompt channel.** Per §2, for both artifact types.
   Verify: sandbox with fake `config.toml` + custom prompts_dir; collision
   hard-fail; footer rules.
5. **Cutover.** Move the three definitions into `agents/`; run adoption on
   this machine; **reap dropped dialects** — files the Python tool wrote
   for any harness that phase 1's evidence pass removed from the dialect
   set are adopted-then-pruned under skm ownership (not orphaned as
   foreign); archive custom_agents (README pointer + final commit); update
   AGENTS.md/README here.
   Verify: `skm status` clean; surviving-dialect outputs byte-identical to
   pre-cutover; every old manifest path either owned by skm or deliberately
   pruned; running the Python tool afterwards is documented as forbidden.

## 4. Risks and mitigations

- **Codex TOML byte-compat** — custom serializer quirks (triple-quoted
  multi-line with `\`/`"""`-only escaping, scalars→tables→array-tables in
  insertion order). Mitigation: **port the ~60-line custom emitter
  verbatim** and use a real TOML library only for round-trip validation —
  the same architecture the Python uses (`tomllib.loads` as validator). A
  general-purpose TOML emitter will not reproduce the partition/order/
  escaping; do not try.
- **PyYAML frontmatter byte-compat** — the larger surface: every markdown
  dialect emits via `yaml.safe_dump(sort_keys=False, allow_unicode=False)`,
  whose 80-column scalar wrapping, `\xXX`/`\uXXXX` escaping, and
  bare-vs-quoted heuristics (`yes/no/on`, leading specials, `:`) no TS YAML
  library reproduces out of the box. Same mitigation shape: a constrained
  frontmatter emitter matched against goldens that include long/unicode/
  nested fixtures (the three real definitions are too simple to catch
  divergence).
- **Schema breadth vs. shipped usage** — the three real definitions cover a
  narrow slice; the untested breadth (copilot targets, opencode options,
  mcp_servers passthrough) is where port bugs will hide. Mitigation: port
  the Python tests, not just the code.
- **Two managers during migration** — until cutover, `shared-agents sync`
  and `skm apply` must not both run. Mitigation: phase 5 is a single
  sitting; before it, skm treats custom_agents outputs as `foreign`
  (safe by ADR 0006); after adoption, running the Python tool is the
  documented "don't".
- **`~/.agents/agents` canonical link** — dropped per ADR 0007 unless
  evidence of a consumer; `doctor` flags a leftover one as foreign.

## 5. Open questions

- Whether `skm adopt custom-agents` runs automatically on first plan
  (convenient) or stays an explicit verb (predictable). Leaning explicit.
- Repo rename (this repo is no longer only skills) — cosmetic, decide with
  the private-repo naming.
- **Phase-1 blocker (not cosmetic):** which of Gemini/Copilot/Cursor/
  OpenCode actually read their `agents/` dirs in current releases
  (custom_agents predates several harness changes), and whether any
  harness reads *another* harness's agents dir (the no-bleed assumption in
  §1 needs evidence). Resolving this fixes the dialect set and the phase-5
  reap list.
