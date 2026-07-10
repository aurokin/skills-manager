# ADR 0009: Rendering is dialect → document AST → emitter; byte-format quirks live only in emitters

- Status: accepted
- Date: 2026-07-10

## Context

skm now renders many frontmatter/document formats, and the set is growing:

- **Skills**: agentskills.io spec frontmatter, plus per-harness overrides
  (Claude dialect fields, Copilot `allowed-tools`, Hermes `metadata.hermes`)
  and Codex's separate `agents/openai.yaml` descriptor (ADR 0004).
- **Agent definitions** (ADR 0007): six harness formats — four distinct
  YAML-frontmatter dialects with per-harness key renames
  (`disallowedTools`, `mcp-servers`, OpenCode's no-`name` document) plus
  Codex **TOML** with a bespoke serializer.
- **Prompts** (ADR 0008): tprompt's own frontmatter vocabulary.

Migration adds a second axis: during the custom_agents port, output must be
byte-identical to PyYAML (`safe_dump` wrapping/escaping/quoting heuristics)
and to the hand-rolled Python TOML emitter — but post-cutover we want clean
canonical output, not PyYAML emulation forever. The Python tool interleaved
field mapping and serialization inside each generator; porting that shape
would smear byte-format quirks across every dialect and make the eventual
emitter swap a rewrite.

## Decision

Rendering is three strictly separated layers:

1. **Canonical model.** Each artifact type has one validated, typed
   in-memory representation (skill, agent definition, prompt), built by the
   resolver. Override deep-merge (ADR 0004 `agents/*.yaml`) happens here,
   before any dialect runs.
2. **Dialects** are pure functions `canonical model → Document`, where
   `Document` is a format-neutral AST: an ordered map of scalars, lists,
   nested tables, and multi-line text blocks. Dialects own field selection,
   key renames, ordering, resolved defaults, and target gating — and never
   touch bytes. One dialect per (artifact type × harness surface), e.g.
   `skill-spec`, `skill-claude`, `agentdef-claude-md`, `agentdef-codex-toml`,
   `agentdef-opencode-md`, `prompt-tprompt`.
3. **Emitters** are pure functions `Document → bytes`, and are the ONLY
   place byte-format quirks exist:
   - `yaml-pyyaml-compat` — reproduces PyYAML `safe_dump(sort_keys=False,
     allow_unicode=False)` wrapping, escaping, and quoting; used during
     migration.
   - `toml-codex-compat` — the Python custom TOML emitter ported verbatim
     (scalars→tables→array-tables, triple-quote multiline), with a real
     TOML parser as round-trip validator only.
   - `yaml-canonical` — clean output for post-migration and for formats
     with no legacy (tprompt prompts, skill rendering, which already ship
     from skm today).

Bindings of (dialect, emitter) are explicit configuration pinned by golden
tests. Swapping `yaml-pyyaml-compat` → `yaml-canonical` after cutover is a
one-line binding change plus a deliberate, reviewed golden regeneration —
not a code change in any dialect.

Emitters are tested in isolation against adversarial fixtures (long
wrapped scalars, unicode, `yes/no/on` bare-string traps, leading specials,
nested maps, multi-line bodies) independent of any dialect.

## Consequences

- Dialect count grows linearly with harness surfaces, not multiplicatively
  with formats; adding a harness is a dialect, adding a format is an
  emitter.
- Byte-compat risk (the plan's top two risk-register entries) is
  quarantined in two compat emitters with their own fixture suites; golden
  failures point at exactly one layer.
- The Document AST must be rich enough for TOML tables/arrays-of-tables
  and multi-line strings from day one; keep it minimal otherwise (no
  comments, no anchors).
- Slightly more ceremony for trivial formats — accepted; the existing
  skill renderer migrates to this shape in the same phase so there is one
  pipeline, not two.
