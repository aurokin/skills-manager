## Purpose

This repo manages a curated set of agent skills (for Claude Code, Codex, OpenCode, Gemini CLI, GitHub Copilot, optionally Hermes) and agent definitions via these mechanisms:
1. **Upstream skills** installed globally from GitHub repos using the `skills` CLI
2. **Local skills** in `skills/` symlinked into `~/.agents/skills` and `~/.claude/skills`
3. **Agent definitions** in `agents/` (one `agent.yaml` + `instructions.md` per subagent), rendered per-harness by `skm` into each agent's definitions dir (`~/.claude/agents/*.md`, `~/.codex/agents/*.toml`, `~/.copilot/agents/*.agent.md`, `~/.cursor/agents/*.md`, `~/.gemini/agents/*.md`, `~/.config/opencode/agent/*.md`)
4. **Composed skills** in `composed/<name>/` of any root (`skill.yaml` + `SKILL.tmpl.md` + `providers/*.md` + `consumers/*.md`), rendered by `skm` into one skill tree per declared consumer (routing table, self-exclusion, compile-time posture, only-referenced provider references). See ADR 0010; the shipped example is `orchestrate` in the private overlay root.
5. **Gated (user-invoked-only) skills** — any local skill whose `SKILL.md` frontmatter declares `disable-model-invocation: true`. `skm` translates that one portable intent line into each agent's actual gate (frontmatter passthrough, or a codex `agents/openai.yaml` companion) and places the skill as a rendered tree ONLY into gate-honoring agents' own dirs — never a symlink, never a shared root. Per-skill overlay `gating: { permissive: [...] }` opts named no-gate agents in (prose gate). See ADR 0011.

A TypeScript CLI (`skm`, under `cli/`, run with `bun`) is the engine, per
`docs/skills-manager-design.md` and the ADRs in `docs/adr/`. It adds
agent-scoped skills (registry-driven placement, `registry/agents.json`),
private overlay repos, plan/apply with an ownership state file, per-agent
frontmatter rendering, and composed skills (per-consumer rendered skill
trees, ADR 0010). The bash sync/deploy scripts were retired at the ADR 0014
final commit: `skm upstream sync` owns upstream-skill sync and `skm deploy`
owns project-family deploys, alongside local-skill placement, scoping,
composed-skill rendering, and drift detection. `skm` still shells to the
external `skills` CLI as the fetch/place engine. Scoped upstream vendoring
(design §5, phase 7) stays deferred. See `cli/README.md`.

## Key Commands

```bash
# Upstream sync: remove stale, update existing, add missing upstream skills
cd cli && bun src/cli.ts upstream sync

# Deploy curated skill families into a project directory (copy install)
cd cli && bun src/cli.ts deploy <dir> --family <name> --yes

# Place local skills (symlinks + gated per-agent renders) — skm owns this
cd cli && bun src/cli.ts plan && bun src/cli.ts apply

# Build the HTML review console (ADR 0013; writes $XDG_STATE_HOME/skills-manager/review.html)
cd cli && bun src/cli.ts review

# Refresh the forked agents-md skill from upstream
bash maintenance/sync-agents-md.sh

# Override which agents get skills (default: standard agents —
# codex opencode gemini-cli github-copilot claude-code)
cd cli && SKILLS_AGENTS="codex opencode" bun src/cli.ts upstream sync

# Opt in to Hermes (add-only; never removes from ~/.hermes/skills)
cd cli && SKILLS_AGENTS="codex opencode gemini-cli github-copilot claude-code hermes-agent" \
    bun src/cli.ts upstream sync
```

Requires: the external `skills` CLI on PATH (`skm` shells to it as the
fetch/place engine). Maintenance sync also uses `curl`. `jq` is no longer a
runtime dependency — only the golden-backed parity suites' `git` shim uses it.

## Architecture

- `cli/src/upstream/` (`skm upstream sync`) — Declarative upstream-sync verb, the ADR 0014 port of the retired `install-repro-skills.sh`. `catalog/global-specs.txt` is the source of truth for desired upstream skills. Runs three phases: remove stale, update existing, add missing. Uses `skills list -g --json` to diff current state against desired state. Skills with `@` target a specific skill from a multi-skill repo; without `@` installs all skills from the repo. `sync.ts` holds the pure diff/plan; `verb.ts` drives the `skills` CLI. Never adopts upstream installs into `state.json` (ADR 0014 ownership boundary).
- `cli/src/deploy/` (`skm deploy`) — Project-family deploys via `skills add --copy`, the ADR 0014 port of the retired `deploy-project-skills.sh`. `resolve.ts` is the pure catalog/family/exclude resolver; `local-config.ts` reads and validates `.skills.local.json`; `upstream.ts` enumerates upstream skill names; `verb.ts` runs the plan. `computeSkillsAgents` (in `verb.ts`) reads `$SKILLS_AGENTS`, else the standard agent set. `link-skills.sh` was retired earlier at placement parity.
- `skills/<name>/SKILL.md` — Each local skill is a single markdown file with YAML frontmatter (`name`, `description`) followed by the skill prompt content.

## Hermes Behavior

When `hermes-agent` is in `SKILLS_AGENTS`:
- `skm upstream sync` passes `hermes-agent` to `skills add`. Stale removal is scoped with `-a` to non-Hermes agents so the CLI never deletes from `~/.hermes/skills`.
- A post-removal sweep deletes broken symlinks in `~/.hermes/skills` whose targets resolve into `skills/` or `~/.agents/skills/` (our own dangling writes). Real directories and foreign-target symlinks are never touched.
- `skm apply` places local skills into `~/.hermes/skills` add-only: placements are created but never pruned (covered by `cli/test/e2e.test.ts`).
- Without `hermes-agent` in `SKILLS_AGENTS`, `skm upstream sync` never reads or writes `~/.hermes/skills`.

## Forked Skills

- `skills/agents-md/SKILL.md` — Generated from upstream `getsentry/skills@agents-md` by `maintenance/sync-agents-md.sh`. Do not hand-edit. The Commit Attribution section is removed. CI syncs it weekly.
- `maintenance/test-agents-md.sh` — Validates the generated `agents-md` fork before it is written or committed.

## Agent Definitions

`agents/<name>/` holds one agent definition: `agent.yaml` (schema ported from
the absorbed `custom_agents` tool) plus `instructions.md`. `skm plan/apply`
renders each definition for every enabled harness that supports agent
definitions, as owned, hash-gated files. Definitions may declare
`harness.include/exclude` scoping, `export: agent|skill|none` (skill produces
a derived SKILL.md instead), and an optional `tprompt:` block to also export a
prompt for the `tprompt` CLI.

The three shipped definitions (`plan-reviewer`, `codexrabbit-code-reviewer`,
`retrorabbit-code-reviewer`) were migrated from `~/code/custom_agents` at
cutover (AUR-618). That repo is archived; **running its `shared-agents` tool
after cutover is forbidden** — two managers writing the same files corrupts
skm's ownership state. The canonical `agent.yaml` is committed directly (the
old gitignored-yaml + `.example` convention is not ported; personal overrides
belong in a private overlay root or machine config).

## Adding a New Local Skill

Create `skills/<name>/SKILL.md` with frontmatter and prompt content, then run `skm plan` / `skm apply` (from `cli/`, via `bun`).

## Making a Skill Gated (User-Invoked-Only)

Add `disable-model-invocation: true` to the skill's `SKILL.md` frontmatter. `skm`
then places it (as rendered trees, never symlinks) only into agents whose registry
`skillInvocation.gate` is a real gate; no-gate agents are excluded unless an overlay
`skills.<name>.gating.permissive` list opts them in. Codex additionally gets an
`agents/openai.yaml` companion. See ADR 0011. Run `skm plan` / `skm apply`.

## Adding a New Agent Definition

Create `agents/<name>/agent.yaml` + `agents/<name>/instructions.md`, then run
`skm plan` / `skm apply` (from `cli/`, via `bun`).

## Disabling an Agent Definition on One Host

In the machine-local override root (registered last in the machine config, e.g.
`~/.config/skills-manager/local-root`), create a complete stub — the loader
requires `name`, `description`, and a non-empty `instructions.md` beside the
yaml:

```yaml
# agents/<name>/agent.yaml
name: <name>
description: Host-local disable stub.
export: none
```

plus `agents/<name>/instructions.md` (one line is enough). Later-root-wins
makes it the effective definition on that host only; run `skm apply --prune`
to remove its rendered placements. The
review console shows the unit as disabled while keeping the shadowed
definition reviewable. See ADR 0015.

## Adding a New Composed Skill

Create `composed/<name>/` (in this repo or an overlay root) with `skill.yaml`
(posture, consumers with descriptions, dimensions), `SKILL.tmpl.md`,
`providers/*.md`, and `consumers/*.md` per ADR 0010, then run `skm plan` /
`skm apply`. Applying edits requires re-apply; hand-edited deployed trees are
repaired by remove-then-re-apply.

## Adding a New Upstream Skill

Add an `owner/repo@skill-name` line to `catalog/global-specs.txt` (the source of
truth for the desired upstream set), then run `skm upstream sync` (from `cli/`,
via `bun`).
