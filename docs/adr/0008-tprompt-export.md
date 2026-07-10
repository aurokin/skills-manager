# ADR 0008: tprompt export is a generic prompt-export channel for agents AND skills

- Status: accepted
- Date: 2026-07-10

## Context

tprompt (`~/code/tprompt`, Go) is a tmux-first prompt library: prompts are
plain markdown files with YAML frontmatter (`title`, `description`, `tags`,
`mode`, `enter`, `key`, `variables`) in `~/.config/tprompt/prompts/`
(configurable via `config.toml` `prompts_dir`), discovered by file drop —
no registration, no daemon. Its locked decisions: prompt ID = filename stem,
directories never namespace, duplicate stems are hard errors.

custom_agents ships a tprompt harness that writes `<name>-ca.md` into the
prompts dir (scaffolds via `tprompt new`, then atomically overwrites),
appends a "Do not use subagents for this specific request." footer, and
tracks the file in its manifest. Known defects: it hardcodes the default
prompts dir and ignores `config.toml` `prompts_dir`; the footer is
agent-framed; and the `tprompt new` subprocess is a pointless external
dependency (the file is overwritten immediately).

Today the export is **agent-definitions only** — the sync loop explicitly
skips `export: skill` definitions (`main.py`: `if agent.export != "agent":
continue`, and skill-mode selection never includes the tprompt harness).
Extending tprompt export to skills is therefore a new capability, not a
formalization of existing behavior. The owner wants tprompt export
preserved in the skm absorption and extended to skills, not just agent
definitions.

## Decision

1. **tprompt becomes an export channel in skm**, available to both artifact
   types. Any skill or agent definition may declare a `tprompt:` block
   (same fields as today: `title`, `description`, `tags`, `key`, `mode`,
   `enter`, `filename`); skm renders a tprompt prompt file as one more
   placement of that artifact — owned in state, planned/applied/pruned and
   drift-checked like every other placement.
2. **The prompts directory is resolved from tprompt's own config**:
   `config.toml` `prompts_dir` when set, else the XDG default — never
   hardcoded. tprompt-binary-on-PATH remains the availability probe; when
   absent, the plan reports the channel unavailable (it does not silently
   skip).
3. **File-drop stays the integration seam.** tprompt's pluggable
   `ImportSource` registry was considered and rejected: it models one-way
   pulls initiated by tprompt (e.g. Wispr), while skm's sync is a push with
   ownership and pruning; file drop is tprompt's documented discovery
   surface and keeps tprompt dependency-free of skm.
4. **Rendering fixes**: no subprocess scaffolding (skm writes the file
   atomically itself); the "Do not use subagents" footer applies only to
   agent-definition-derived prompts (configurable off), never to
   skill-derived prompts; every exported prompt is stamped with tags
   `[skm, agent-def|skill]` in addition to declared tags so the flat
   library stays filterable.
5. **Naming respects tprompt's locked flat namespace**: exported filename is
   `<filename or artifact name>` + suffix `-ca` — kept purely as a
   collision guard segregating exported prompts from hand-authored ones
   (there are no legacy tprompt installs to stay compatible with: none of
   the shipped definitions enable tprompt). The collision guard scans the
   entire resolved tprompt namespace (`prompts_dir` plus
   `additional_prompts_dirs`): skm-vs-skm stem clashes hard-fail the plan
   (authoring error, caught before mutation); clashes with foreign prompts
   are reported and skipped per ADR 0006, never failing the rest of the
   apply.

## Consequences

- Skills gain a human-invoked delivery path (tmux popup → paste into any
  pane) without becoming less agent-invokable — the two surfaces are
  independent placements of one canonical body.
- skm reads (never writes) tprompt's `config.toml`; a user-customized
  prompts dir now works, fixing the silent desync in custom_agents.
- If a machine ever ran the old integration, its `-ca` files are claimed
  through the normal custom_agents manifest adoption (ADR 0007); on this
  fleet none exist, so the export starts clean.
- tprompt itself needs no changes; if its config schema moves, the registry
  evidence rules (ADR 0003) apply to the prompts-dir resolution logic.
