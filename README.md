# Custom Skills

Curated local and upstream skills — plus agent definitions — for multiple coding agents.

This repo has two distinct workflows:

1. Global normalization for your personal always-on setup
2. Project deployment for repo-specific skill families like Expo and Convex

It also carries **agent definitions** under [`agents/`](agents/): one
`agent.yaml` + `instructions.md` per subagent, rendered per-harness by `skm`
into each agent's definitions dir (Claude, Codex, Copilot, Cursor, Gemini,
OpenCode) and optionally exported as a derived skill or a `tprompt` prompt.
These were absorbed from the retired `custom_agents` repo at cutover; running
its `shared-agents` tool after cutover is forbidden (see AGENTS.md).

> **Engine:** a TypeScript CLI (`skm`, under [`cli/`](cli/)) runs the whole
> surface, adding agent-scoped skills, private overlay repos, composed skills
> (one source rendered per consumer — routing tables, self-exclusion,
> compile-time posture;
> [ADR 0010](docs/adr/0010-composed-skills-artifact-type.md)), gated
> (user-invoked-only) skills (`disable-model-invocation: true` translated to
> each agent's gate — frontmatter or a codex companion file — placed only into
> gate-honoring agents' own dirs;
> [ADR 0011](docs/adr/0011-user-invoked-only-skill-gating.md)), and
> Terraform-style plan/apply with an ownership state file. Design:
> [docs/skills-manager-design.md](docs/skills-manager-design.md) · decisions:
> [docs/adr/](docs/adr/) · usage: [cli/README.md](cli/README.md). The bash
> sync/deploy scripts were retired at the ADR 0014 final commit: `skm upstream
> sync` and `skm deploy` replace them (`skm` still shells to the external
> `skills` CLI as the fetch/place engine).

It also supports an optional gitignored personal overlay file for extra global
skills, per-family additions, and custom project families.

## Requirements

- `bun` (runs the `skm` CLI under `cli/`)
- `skills` CLI (skm shells to it as the fetch/place engine)
- `git`
- `curl` for the `agents-md` sync maintenance script
- `jq` is only needed to run the golden-backed parity suites' `git` shim (dev/test), not at runtime

## Commands

### `skm upstream sync`

Normalizes your global skill setup under `~/.agents/skills` and `~/.claude/skills`.

It will:
- remove globally installed skills that are no longer in the curated global catalog
- update existing global skills
- add any missing curated global skills
- audit selected upstream repos for coverage drift
- clean up broken symlinks in those global directories

Local repo skills are placed separately by `skm` (see below).

Use it when you want to update your personal baseline skill environment.

If `.skills.local.json` exists, its `globalSpecs` are merged into the desired
global set and its `excludeGlobalSpecs` remove explicit upstream skills, or
whole upstream repos after normalization, from that resolved global set before
stale-skill removal runs. Its `preserveGlobalSkillNames` protects named
handmade global skills from stale removal without adding them to the resolved
managed install set.

Exclusion-override behavior, resolved repo summaries, and the `^` full-coverage
marker are documented in [docs/exclude-overrides.md](docs/exclude-overrides.md).
The `^` marker means the final resolved set covers all current upstream skills
for that repo.

Examples:

```bash
cd cli && bun src/cli.ts upstream sync
cd cli && SKILLS_AGENTS="codex opencode" bun src/cli.ts upstream sync
cd cli && SKILLS_AUDIT_REPO_COVERAGE=0 bun src/cli.ts upstream sync
```

### Agent targets

`SKILLS_AGENTS` is a single space-separated override. When unset, `skm` uses
the standard set:

- `codex`
- `opencode`
- `gemini-cli`
- `github-copilot`
- `claude-code`

Override the list to scope a run to a subset of agents, or to opt into
additional agents like Hermes (see below).

### Hermes opt-in

`hermes-agent` is supported as an opt-in target. Include it in `SKILLS_AGENTS`:

```bash
cd cli && SKILLS_AGENTS="codex opencode gemini-cli github-copilot claude-code hermes-agent" \
    bun src/cli.ts upstream sync
```

Hermes behavior is intentionally different:

- Hermes does **not** read `~/.agents/skills` by default. The `skills` CLI
  installs Hermes targets under `~/.hermes/skills/<name>`. Local repo skills
  are symlinked there by `skm` when hermes is enabled (add-only: skm never
  prunes hermes placements).
- `~/.hermes/skills` is treated as **add-only**. Stale-skill removal is scoped
  with `-a` to non-Hermes agents so the CLI never removes a Hermes entry on
  our behalf. Hermes packages and creates its own skills in that directory,
  and we don't manage what we didn't install.
- We do clean up our own dangling symlinks. After a stale removal, any
  `~/.hermes/skills/<name>` symlink whose target resolves into `skills/` or
  `~/.agents/skills/` is removed. Real directories and symlinks pointing
  elsewhere are left untouched.
- Without `hermes-agent` in `SKILLS_AGENTS`, `skm upstream sync` never reads or
  writes `~/.hermes/skills`. To clean up past Hermes writes after opting out,
  opt back in for one run.
- Running with `SKILLS_AGENTS="hermes-agent"` alone is supported but is an
  edge case: the CLI installs as real directories under `~/.hermes/skills`,
  which look like Hermes-owned content on disk and won't be cleaned up by
  future runs. Use the additive form (standard + `hermes-agent`) for any
  install you want round-trip cleanup on.
- A fresh Hermes session or `/reset` is needed for Hermes to pick up
  newly-added skills. Local entries in `~/.hermes/skills` win on name
  collisions with externally-configured skill roots
  (`skills.external_dirs` in `~/.hermes/config.yaml`).

### `skm deploy`

Deploys curated skill families into a target directory with project-scoped `skills add --copy` installs.

Use it when a repo needs a focused set of skills, for example Expo or Convex, without making them part of your global always-on setup.

If `.skills.local.json` exists, its `familySpecs` extend curated families and
its `customFamilies` become selectable alongside the curated ones.

Behavior:
- targets the exact directory you choose
- expands current-user `~` and `~/...` target paths, including interactive input and quoted `--target` values
- does not expand `~user/...` target paths
- works in plain directories and git repos
- copies skills into the project-managed agent directories
- installs only the selected families
- does not normalize or remove unrelated project skills
- audits selected curated family repos for upstream drift when coverage manifests are configured
- requires `git` whenever upstream enumeration is needed for deploy planning, resolved summaries, or coverage-driven full-coverage markers
- as a result, `--dry-run` also requires `git` when the printed summary needs exact upstream coverage information

If `.skills.local.json` exists, its `familySpecs` extend curated families and
its `excludeFamilySpecs` remove explicit upstream skills from each curated
family's resolved contribution before the selected families are merged.

Exclusion-override behavior, resolved repo summaries, and the `^` full-coverage
marker are documented in [docs/exclude-overrides.md](docs/exclude-overrides.md).
The `^` marker means the final resolved set covers all current upstream skills
for that repo.

The bash interactive prompt mode is dropped (`skm` is agent-first);
`--list-families` plus flags cover the human path:

```bash
cd cli && bun src/cli.ts deploy \
  ~/code/my-app \
  --family expo \
  --family convex \
  --agents "codex claude-code" \
  --yes
```

List available families:

```bash
cd cli && bun src/cli.ts deploy ~/code/my-app --list-families
```

### Local-skill placement (`skm`)

Local skills from `skills/` (and overlay roots) are placed by the `skm` CLI —
symlinks into shared roots for unscoped skills, rendered per-agent trees for
gated ones, ownership-tracked and prunable:

```bash
cd cli
bun src/cli.ts plan   # preview
bun src/cli.ts apply  # place
```

The former `./link-skills.sh` was retired once skm reached placement parity
(gate awareness, hermes add-only, stale-link pruning are covered by
`cli/test`).

### `bash maintenance/sync-agents-md.sh`

Refreshes the forked `agents-md` local skill from upstream `getsentry/skills@agents-md`.

`skills/agents-md/SKILL.md` is generated output. Do not edit it by hand.

```bash
bash maintenance/sync-agents-md.sh
```

## Catalog

The source of truth is split by purpose:

- `catalog/global-specs.txt`
  global skills managed by `skm upstream sync`
- `upstream-coverage.json`
  global upstream repos audited for skill drift during
  `skm upstream sync` (when `SKILLS_AUDIT_REPO_COVERAGE=1`)
- `catalog/families.tsv`
  family names and descriptions for project deployment
- `catalog/families/*.txt`
  explicit per-family upstream skill specs
- `catalog/family-coverage.json`
  upstream repos that should be audited for family drift

Current project families:
- `expo`
- `convex`
- `mattpocock-teaching`
- `react`
- `security`

### Notable catalog changes

**Impeccable replaces Anthropic `frontend-design`.** The global catalog now
installs [`pbakaus/impeccable@impeccable`](https://impeccable.style/) instead of
`anthropics/skills@frontend-design`. Impeccable v2.0 replaced the old skill with
a single `/impeccable` namespace.

After you run `skm upstream sync`:

- `frontend-design` is removed from `~/.agents/skills` and `~/.claude/skills`
  if it was installed by this workflow
- `impeccable` is added when missing

If you still want the old skill name on disk, add `frontend-design` to
`preserveGlobalSkillNames` in `.skills.local.json`. That only blocks stale
removal; it does not reinstall the Anthropic package.

`pbakaus/impeccable` is listed in `upstream-coverage.json` so installs are
audited for upstream drift. The repo ships the same skill under many agent
paths (`.cursor/skills/impeccable`, `skill/SKILL.md`, and others); enumeration
dedupes by frontmatter `name: impeccable`, so only the curated skill is tracked.

## Personal Overlay

Create `.skills.local.json` in the repo root to add personal skills without
changing the curated catalog. The file is gitignored; start from
`.skills.local.json.example`. The example file uses placeholder exclusions, so
copying it does not opt you out of curated skills until you replace those
values intentionally.

This gitignored `.skills.local.json` is only a quick-tweak layer for the
`skm upstream sync` / `skm deploy` upstream/family sets — it is **not** the
private overlay repo. Private
skills and agent definitions live in a separate registered overlay root (a real
repo, resolved by `skm`); see
[ADR 0001](docs/adr/0001-overlay-repo-architecture.md).

Supported keys:

- `globalSpecs`
  additive upstream specs merged into the `skm upstream sync` desired set
- `excludeGlobalSpecs`
  upstream specs removed from the resolved global install set
- `preserveGlobalSkillNames`
  handmade global skill names protected from stale removal
- `familySpecs`
  additive specs keyed by existing curated family name
- `excludeFamilySpecs`
  explicit upstream specs removed from a curated family's resolved deploy set
- `customFamilies`
  new family definitions with `description` and `specs`

See [docs/exclude-overrides.md](docs/exclude-overrides.md) for the implemented
exclusion-override semantics, normalization rules, resolved summary output,
examples, and implementation notes.

Example:

```json
{
  "globalSpecs": [
    "owner/repo@my-global-skill"
  ],
  "excludeGlobalSpecs": [
    "owner/repo@skill-to-exclude",
    "owner/another-repo"
  ],
  "preserveGlobalSkillNames": [
    "my-handmade-global-skill"
  ],
  "familySpecs": {
    "expo": [
      "owner/repo@my-expo-skill"
    ]
  },
  "excludeFamilySpecs": {
    "expo": [
      "owner/repo@family-skill-to-exclude"
    ]
  },
  "customFamilies": {
    "acme-mobile": {
      "description": "Company mobile workflow skills",
      "specs": [
        "owner/repo@release-ops"
      ]
    }
  }
}
```

Rules:

- `excludeGlobalSpecs` accepts repo-wide `owner/repo` and explicit `owner/repo@skill-name` entries
- `preserveGlobalSkillNames` accepts exact skill names only, not upstream specs
- `excludeFamilySpecs` only accepts explicit `owner/repo@skill-name` entries
- `familySpecs` can only target existing curated families
- `excludeFamilySpecs` can only target existing curated families
- `customFamilies` cannot reuse a curated family name
- duplicate specs are deduped with curated entries first

## Local Skills

Local repo-managed skills live in `skills/<name>/SKILL.md`.

Current local skills:
- `agents-md`
- `to-issues` — gated (`disable-model-invocation: true`); distilled from the
  retired mattpocock fork down to the non-native methodology (tracer-bullet
  vertical slices, HITL/AFK classification, calibration questions), writing
  blockers-first into the connected tracker via MCP

`to-prd` and `linear-yeet` were retired 2026-07 (frontier agents produce
PRDs and drive the Linear MCP natively); `split-to-prs`, an exact fork of
the Cursor app's shipped skill, moved to the private overlay root. Gated
local skills are never placed in shared roots; `skm` renders them per-agent
(ADR 0011).

To add a new local skill:

1. Create `skills/<name>/SKILL.md`
2. Add frontmatter with `name` and `description`
3. Run `skm plan` / `skm apply` (from `cli/`, via `bun`)

## Tests

The `skm` engine (including the `upstream sync` / `deploy` parity suites, now
golden-backed against the retired scripts' captured output) runs under `bun`:

```bash
cd cli && bun test
```

The one remaining shell test covers the `agents-md` fork sync:

```bash
bash maintenance/test-agents-md.sh
```
