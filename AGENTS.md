## Purpose

This repo manages a curated set of agent skills (for Claude Code, Codex, OpenCode, Gemini CLI, GitHub Copilot, optionally Hermes) and agent definitions via these mechanisms:
1. **Upstream skills** installed globally from GitHub repos using the `skills` CLI
2. **Local skills** in `skills/` symlinked into `~/.agents/skills` and `~/.claude/skills`
3. **Agent definitions** in `agents/` (one `agent.yaml` + `instructions.md` per subagent), rendered per-harness by `skm` into each agent's definitions dir (`~/.claude/agents/*.md`, `~/.codex/agents/*.toml`, `~/.copilot/agents/*.agent.md`, `~/.cursor/agents/*.md`, `~/.gemini/agents/*.md`, `~/.config/opencode/agent/*.md`)
4. **Composed skills** in `composed/<name>/` of any root (`skill.yaml` + `SKILL.tmpl.md` + `providers/*.md` + `consumers/*.md`), rendered by `skm` into one skill tree per declared consumer (routing table, self-exclusion, compile-time posture, only-referenced provider references). See ADR 0010; the shipped example is `orchestrate` in the private overlay root.
5. **Gated (user-invoked-only) skills** — any local skill whose `SKILL.md` frontmatter declares `disable-model-invocation: true`. `skm` translates that one portable intent line into each agent's actual gate (frontmatter passthrough, or a codex `agents/openai.yaml` companion) and places the skill as a rendered tree ONLY into gate-honoring agents' own dirs — never a symlink, never a shared root. Per-skill overlay `gating: { permissive: [...] }` opts named no-gate agents in (prose gate). See ADR 0011.

A TypeScript CLI (`skm`, under `cli/`, run with `bun`) is replacing the bash
engine per `docs/skills-manager-design.md` and the ADRs in `docs/adr/`. It
adds agent-scoped skills (registry-driven placement, `registry/agents.json`),
private overlay repos, plan/apply with an ownership state file, per-agent
frontmatter rendering, and composed skills (per-consumer rendered skill
trees, ADR 0010). Until migration phase 6 completes, the bash scripts
remain authoritative for upstream-skill sync; `skm` owns local-skill
placement, scoping, composed-skill rendering, and drift detection. See
`cli/README.md`.

## Key Commands

```bash
# Full sync: remove stale, update existing, add missing upstream skills, then link local skills
./install-repro-skills.sh

# Link local skills only (no upstream sync)
./link-skills.sh

# Refresh the forked agents-md skill from upstream
bash maintenance/sync-agents-md.sh

# Override which agents get skills (default: standard agents from lib/agents.sh —
# codex opencode gemini-cli github-copilot claude-code)
SKILLS_AGENTS="codex opencode" ./install-repro-skills.sh

# Opt in to Hermes (add-only; never removes from ~/.hermes/skills)
SKILLS_AGENTS="codex opencode gemini-cli github-copilot claude-code hermes-agent" \
    ./install-repro-skills.sh
```

Requires: `skills` CLI and `jq` on PATH. Maintenance sync also uses `curl`.

## Architecture

- `install-repro-skills.sh` — Declarative sync script. The `specs` array is the source of truth for desired upstream skills. Runs four phases: remove stale, update existing, add missing, link local. Uses `skills list -g --json` to diff current state against desired state. Skills with `@` target a specific skill from a multi-skill repo; without `@` installs all skills from the repo.
- `link-skills.sh` — Symlinks each `skills/<name>/` directory into `~/.agents/skills/` and `~/.claude/skills/` (and `~/.hermes/skills/` when `hermes-agent` is opted in).
- `lib/agents.sh` — Defines `STANDARD_AGENTS` and helpers (`compute_skills_agents`, `agents_include_hermes`, `agents_excluding_hermes`). Sourced by both install scripts and `link-skills.sh`.
- `skills/<name>/SKILL.md` — Each local skill is a single markdown file with YAML frontmatter (`name`, `description`) followed by the skill prompt content.

## Hermes Behavior

When `hermes-agent` is in `SKILLS_AGENTS`:
- `install-repro-skills.sh` passes `hermes-agent` to `skills add`. Stale removal is scoped with `-a` to non-Hermes agents so the CLI never deletes from `~/.hermes/skills`.
- A post-removal sweep deletes broken symlinks in `~/.hermes/skills` whose targets resolve into `skills/` or `~/.agents/skills/` (our own dangling writes). Real directories and foreign-target symlinks are never touched.
- `link-skills.sh` adds `~/.hermes/skills` as a symlink target. Stale-link cleanup only removes symlinks pointing back into this repo's `skills/`.
- Without `hermes-agent` in `SKILLS_AGENTS`, scripts never read or write `~/.hermes/skills`.

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

Create `skills/<name>/SKILL.md` with frontmatter and prompt content, then run either install script.

## Making a Skill Gated (User-Invoked-Only)

Add `disable-model-invocation: true` to the skill's `SKILL.md` frontmatter. `skm`
then places it (as rendered trees, never symlinks) only into agents whose registry
`skillInvocation.gate` is a real gate; no-gate agents are excluded unless an overlay
`skills.<name>.gating.permissive` list opts them in. Codex additionally gets an
`agents/openai.yaml` companion. See ADR 0011. Run `skm plan` / `skm apply`.

## Adding a New Agent Definition

Create `agents/<name>/agent.yaml` + `agents/<name>/instructions.md`, then run
`skm plan` / `skm apply` (from `cli/`, via `bun`).

## Adding a New Composed Skill

Create `composed/<name>/` (in this repo or an overlay root) with `skill.yaml`
(posture, consumers with descriptions, dimensions), `SKILL.tmpl.md`,
`providers/*.md`, and `consumers/*.md` per ADR 0010, then run `skm plan` /
`skm apply`. Applying edits requires re-apply; hand-edited deployed trees are
repaired by remove-then-re-apply.

## Adding a New Upstream Skill

Add a `"owner/repo@skill-name"` entry to the `specs` array in `install-repro-skills.sh`.
