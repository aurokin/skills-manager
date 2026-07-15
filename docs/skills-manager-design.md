# Skills Manager — Design

- Status: draft for implementation
- Date: 2026-07-10
- Decisions are recorded as ADRs in [docs/adr/](adr/); this doc is the
  integrated picture plus the research that grounds it.

## 1. Goals

- **R1 — Agent-scoped skills.** A skill can be restricted to specific agents.
  Canonical example: a "drive Codex" skill installed for Claude Code that
  Codex can never see (and the symmetric cases for Claude, Copilot, etc.).
- **R2 — Private skills.** Non-public skills (fleet machine details, private
  utilities) live in one or more separate private repos and sync through the
  same workflow as this public catalog.
- **R3 — Dual operator UX.** Humans in an interactive terminal get readable
  plans and status; coding agents (the majority operator) get idempotent
  verbs, `--json`, semantic exit codes, and drift detection.

Out of scope for v1: per-host/multi-machine layering inside the engine
(ADR 0005) — host variance is expressed by each machine's local config,
managed by the user's dotfiles if desired.

## 2. Decision summary

| ADR | Decision |
|---|---|
| [0001](adr/0001-overlay-repo-architecture.md) | This repo is the engine; private repos are registered data-only overlays |
| [0002](adr/0002-typescript-engine.md) | Engine rewritten in TypeScript (Bun runtime, Node-compatible) |
| [0003](adr/0003-agent-capability-registry.md) | Evidence-backed agent capability registry drives placement; scoped skills never touch `~/.agents/skills`; missing agent dirs created per that agent's documented standard |
| [0004](adr/0004-first-party-frontmatter-rendering.md) | Claude Code, Codex, Copilot are first-party: per-agent rendered frontmatter in their private dirs; shared-dir content leans Codex |
| [0005](adr/0005-machine-registry-in-xdg-config.md) | Machine-local registry in `~/.config/skills-manager/`; no per-host layering in v1 |
| [0006](adr/0006-plan-apply-ownership-state.md) | Terraform-style `plan`/`apply`, exit codes 0/1/2, ownership state file, delete-only-what-we-own |
| [0007](adr/0007-agent-definitions-artifact-type.md) | Agent definitions become a second artifact type; `custom_agents` absorbed |
| [0008](adr/0008-tprompt-export.md) | tprompt export as a generic prompt-export channel for agents and skills |
| [0009](adr/0009-dialect-document-emitter-rendering.md) | Rendering is dialect → document AST → emitter; byte quirks live only in emitters |
| [0010](adr/0010-composed-skills-artifact-type.md) | Composed skills: per-consumer rendered skills with a build matrix and posture |
| [0011](adr/0011-user-invoked-only-skill-gating.md) | User-invoked-only skills: intent declared once, gate translated per agent |
| [0012](adr/0012-shared-provider-pools.md) | Shared provider pools: multiple composed skills from one provider source |
| [0013](adr/0013-skm-review.md) | `skm review` verb for the skill-surface console |
| [0015](adr/0015-machine-local-override-roots.md) | Machine-local override roots disable an agent definition per host via an `export: none` stub |

## 3. Architecture overview

```
~/.config/skills-manager/config.json      machine-local: registered roots
        │
        ▼
┌─ resolve ──────────────────────────────────────────────┐
│ public repo (this repo)      catalog + skills/ + registry │
│ private overlay repo(s)      skills/ + overlay.json       │
│ upstream specs               via `skills` CLI (unscoped)  │
└────────────────────────────────────────────────────────┘
        │  desired state
        ▼
     plan  ──(review)──►  apply  ──►  placements
        │                              │
        ▼                              ▼
~/.local/state/skills-manager/     agent dirs:
  state.json (ownership)             ~/.agents/skills (shared, unscoped)
  audit.jsonl                        ~/.claude/skills, ~/.copilot/skills,
                                     ~/.factory/skills, ... (scoped/rendered)
```

Unscoped upstream skills keep the current cheap path: the vercel `skills`
CLI installs into `~/.agents/skills` and maintains the `~/.claude/skills`
symlinks. The engine adds what the CLI cannot express: scoped placement,
overlay composition, rendering, ownership, and plan/apply.

## 4. Agent capability matrix (researched 2026-07-10)

Sources: source code under `~/code/upstream/<agent>` (clone dates noted),
official docs, and the vercel-labs `skills` CLI registry (`src/agents.ts`,
commit `9513878`), plus on-machine verification by the owner where noted.
The machine-readable registry derived from this table lives at
`registry/agents.json`.

### Global skill directories and read graph

| Agent | Global dirs read (precedence notes) | Reads `~/.agents/skills`? | Own private dir | Evidence |
|---|---|---|---|---|
| **claude-code** | `~/.claude/skills` only | **No** | `~/.claude/skills` | source (clone 2026-04, stale) + docs |
| **codex** | `~/.agents/skills` (primary), `$CODEX_HOME/skills` (**deprecated in source**), `/etc/codex/skills`, bundled `.system` | Yes | `~/.codex/skills` (deprecated) | source (clone 2026-07-09) |
| **github-copilot** (CLI) | `~/.copilot/skills`, `~/.agents/skills` | Yes (documented) | `~/.copilot/skills` | docs |
| **gemini-cli** | `~/.gemini/skills`, then `~/.agents/skills` (later wins) | Yes | `~/.gemini/skills` | source (clone 2026-05) |
| **opencode** | `~/.claude/skills`, `~/.agents/skills`, opencode config dirs | Yes | `~/.config/opencode/skills` | source (clone 2026-07-09) |
| **pi** | `~/.pi/agent/skills`, `~/.agents/skills` | Yes | `~/.pi/agent/skills` | source (clone 2026-05) |
| **cursor** (cursor-agent) | `~/.agents/skills`, `~/.cursor/skills`, `~/.claude/skills`, `~/.codex/skills` (compat) | Yes | `~/.cursor/skills` | docs |
| **grok** | `~/.grok/skills`, config `[skills] paths` | **Ambiguous** in docs | `~/.grok/skills` | docs (flagged) |
| **droid** | `~/.factory/skills`, `~/.agents/skills` | **Yes** — user-verified on-machine 2026-07-10; Factory docs lag and list only `~/.factory/skills` | `~/.factory/skills` | user-verified + docs |
| **antigravity** | `~/.gemini/config/skills` (all variants); variant-specific extras | No evidence (home level) | `~/.gemini/config/skills` | docs (flagged, variant-inconsistent) |
| **hermes** | `~/.hermes/skills`, config `skills.external_dirs` | No | `~/.hermes/skills` (add-only policy retained) | source (clone 2026-05) |
| **aider** | — | No | — (`skills-support: none`) | source (clone 2026-05) |

Project-level dirs (for the family/deploy workflow): `.agents/skills` is read
by codex, gemini-cli, opencode, pi, cursor, copilot, antigravity; agent-own
project dirs include `.claude/skills` (claude, opencode, cursor, copilot,
grok-compat), `.codex/skills` (codex, cursor), `.factory/skills` and
`.agent/skills` (droid — note **singular** `.agent`), `.github/skills`
(copilot), `.gemini/skills` (gemini), `.pi/skills` (pi), `.grok/skills`
(grok), `.hermes/skills` (hermes).

Symlink handling: codex, claude-code, opencode, pi, hermes, gemini-cli
confirmed to follow symlinked skill dirs (source or docs); others
undocumented — the registry records `symlinks: unknown` and `doctor` can
probe empirically.

### Corrections to prior assumptions

- **Gemini CLI supports skills** (`~/.gemini/skills` + shared) — the empty
  dir on this machine just hasn't been created.
- **Droid does read `~/.agents/skills`** (user-verified on-machine;
  Factory's docs list only `~/.factory/skills` and lag actual behavior).
  The CLAUDE.md note stands. Registry evidence cites the empirical
  verification.
- **OpenCode and Cursor read `~/.claude/skills`**, so Claude's dir is not
  Claude-private. See placement semantics below.
- The vercel `skills` CLI's per-agent `globalSkillsDir` values for
  "universal" agents (codex, copilot, cursor, gemini, opencode, antigravity,
  …) are hints only — it writes solely to `~/.agents/skills` for them.
  Non-universal agents (claude-code, droid, pi, hermes) get per-skill
  symlinks from their own dir back to canonical.

## 5. Placement model

### The read graph, not "private dirs"

Scoping is a property of *who reads a directory*, and several dirs have
multiple readers (`~/.agents/skills` has ~7; `~/.claude/skills` has at least
claude, opencode, cursor). The registry therefore models each directory
with its reader set, and placement is a small solver:

- **Deny is a hard guarantee.** A skill's placements must include no
  directory that any denied agent reads. This is checkable, and `doctor`
  verifies it against the live registry.
- **Allow is best-effort.** For each allowed agent, choose a directory that
  the agent reads and no denied agent reads — preferring the agent's own
  dir. If none exists (agent lacks a usable dir, e.g. aider), the plan
  reports that agent as `unreachable` rather than silently skipping.
- **Incidental visibility ("bleed-over") is reported, not blocked.**
  Example: a skill allowed to `claude-code` only, placed in
  `~/.claude/skills`, is incidentally visible to opencode and cursor. The
  plan and `explain` list incidental readers; if the user wants strictness,
  deny those agents explicitly (the solver may then have no placement and
  will say so) or use the agents' own kill-switches (e.g.
  `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1`), which `doctor` can recommend.
- **Own dirs are the scoped-placement targets.** Each supported agent has a
  specific directory used for scoped placement — notably opencode
  (`~/.config/opencode/skills`) and cursor (`~/.cursor/skills`) are treated
  as own-dir agents, never reached through another agent's directory.

Known global bleed-over (registry-derived; kept current by `doctor`):

| Directory | Intended agent | Also read by |
|---|---|---|
| `~/.agents/skills` | (shared) | codex, gemini-cli, opencode, pi, cursor, github-copilot, droid |
| `~/.claude/skills` | claude-code | opencode, cursor, (grok: claude-compat, unconfirmed) |
| `~/.codex/skills` | codex | cursor |
| all other own dirs | one agent each | no known bleed |

Any skill with scoping is excluded from `~/.agents/skills` entirely
(ADR 0003), since the shared dir's reader set is effectively "everyone".

### Missing directories

If placement targets an agent whose directory doesn't exist (e.g. first
Droid deploy), the engine creates the directory the agent actually reads
per the registry evidence — e.g. `~/.factory/skills` for droid, never an
invented path (ADR 0003). Deprecated dirs (codex's `$CODEX_HOME/skills`)
are used only when they are the sole scoped option, and the plan flags the
deprecation.

### Scoped upstream skills

The `skills` CLI cannot scope (it always writes canonical shared copies), so
a scoped spec is **vendored**: the engine clones/sparse-checkouts the
upstream skill into a manager-owned cache
(`~/.local/state/skills-manager/store/<owner>__<repo>__<skill>/`) at a
pinned revision recorded in state, then places it like a local skill.
`update` refreshes vendored copies. Unscoped specs stay with the `skills`
CLI.

## 6. Frontmatter dialects and rendering (ADR 0004)

Baseline: the [agentskills.io](https://agentskills.io/specification) spec —
`name` (kebab-case, matches dir), `description`, optional `license`,
`compatibility`, `metadata`, `allowed-tools`. Every canonical SKILL.md in
our repos must be spec-valid (CI runs `skills-ref validate` or equivalent).

Per-agent dialects that matter:

- **claude-code**: rich extensions — `allowed-tools`, `disallowed-tools`,
  `model`, `effort`, `context: fork`, `agent`, `hooks`, `paths`,
  `when_to_use`, `argument-hint`, `disable-model-invocation`,
  `user-invocable`.
- **codex**: spec frontmatter + optional `agents/openai.yaml` descriptor
  (`interface` display/branding/default_prompt, `policy.allow_implicit_invocation`,
  `dependencies.tools`).
- **github-copilot**: spec frontmatter; honors `allowed-tools` for shell
  pre-approval and `license`.
- Everyone else parses roughly `name` + `description` (+ scattered extras:
  pi/droid honor `disable-model-invocation`; cursor honors `paths`).

Authoring and rendering:

```
skills/drive-codex/
  SKILL.md              # canonical, agentskills.io-valid
  agents/openai.yaml    # codex descriptor (shipped as-is; others ignore it)
  agents/claude.yaml    # claude-dialect frontmatter overrides (merge patch)
  agents/copilot.yaml   # copilot overrides (e.g. allowed-tools tuning)
  scoping in manifest or frontmatter metadata (see §7)
```

- Placement into `~/.claude/skills` with a `claude.yaml` present → **render**
  (canonical frontmatter deep-merged with the override) as a real file; no
  override → plain symlink.
- Placement into `~/.copilot/skills` likewise with `copilot.yaml`.
- Shared `~/.agents/skills` content is the canonical file — which, carrying
  spec frontmatter plus `agents/openai.yaml`, is already Codex-optimal
  ("lean Codex" costs nothing beyond keeping the canonical file spec-clean).
- Rendered artifacts are hashed into the state file; hand-edits show as
  `modified` in `status` and are never silently overwritten.

## 7. File formats

### Machine config — `~/.config/skills-manager/config.json`

```json
{
  "version": 1,
  "roots": [
    { "name": "public",  "path": "~/code/custom_skills",  "visibility": "public" },
    { "name": "private", "path": "~/code/skills_private", "visibility": "private" }
  ]
}
```

A registered root that is missing on disk **aborts the run** (never treated
as "delete its skills"). The gitignored `.skills.local.json` remains the
quick-tweak layer during migration, merged last (ADR 0005).

### Overlay manifest — `<overlay>/overlay.json`

```json
{
  "version": 1,
  "name": "auro-private",
  "requiresPublic": "3abef4e",
  "upstream": ["someorg/private-skills@infra"],
  "skills": {
    "fleet-ops":   { "agents": { "allow": ["claude-code", "codex"] } },
    "drive-codex": { "agents": { "deny": ["codex"] } }
  }
}
```

Scoping for public-repo skills lives in `catalog/agent-scopes.json` (same
`skills` shape). A skill absent from any scoping map is unscoped (shared
path). `allow` and `deny` are mutually exclusive per skill; `deny` means
"all supported agents except these", `allow` means "exactly these,
deny-everyone-else".

### Ownership state — `~/.local/state/skills-manager/state.json`

```json
{
  "version": 1,
  "machine": "koopa",
  "artifacts": {
    "drive-codex": {
      "source": { "root": "private", "visibility": "private" },
      "placements": [
        { "agent": "claude-code", "path": "~/.claude/skills/drive-codex",
          "kind": "rendered", "hash": "sha256:9f2c…" },
        { "agent": "github-copilot", "path": "~/.copilot/skills/drive-codex",
          "kind": "symlink" }
      ]
    }
  }
}
```

## 8. CLI surface

```
skm plan     [--json]              # exit 0 clean / 2 changes pending
skm apply    [--json] [--plan f] [--prune] [--yes]
skm status   [--json]              # desired vs state vs disk; drift classes
skm doctor   [--json] [--fix]      # leaks, broken links, registry contradictions,
                                   # deny-guarantee verification, env-var suggestions
skm review   [--json] [--out f]    # skill-surface review: self-contained HTML page (or --json model)
skm explain  <skill> [--json]      # source root, scoping, placements, visibility/bleed
skm root     add|list|remove <path>
```

Project-family deploys are **not** a skm verb yet: they remain the bash
`deploy-project-skills.sh` path until migration phase 6 completes (§10).

Conventions (ADR 0006): `plan` never mutates; `apply --plan` executes
exactly the reviewed plan; exit codes 0/1/2; `--json` on every verb;
append-only audit log; deletion restricted to state-file-owned artifacts;
Hermes stays add-only by the same universal rule.

Dogfooding: `skills/skills-manager/SKILL.md` ships in this repo (unscoped,
so every agent gets it) teaching the verbs, "always plan before apply",
exit-code meanings, and the privacy rules — any agent on any synced machine
knows how to operate the system.

## 9. Privacy guards (enforced in code, not convention)

- Private-root skills are placed as symlinks where possible; rendered copies
  carry state-file hashes and provenance.
- `apply` refuses to place a private artifact inside any git worktree whose
  `origin` is not allowlisted.
- `doctor` scans agent dirs for private content in unexpected locations
  (copies matching private-source hashes, symlinks resolving into
  unregistered repos) and reports `unsafe`.
- This repo's CI/pre-commit: no symlinks escaping the repo under `skills/`,
  grep-guard for private-root path fragments.

## 10. Migration and sequencing

Each phase lands as an independent PR with tests; bash behavior
(`maintenance/test-*.sh`) is the contract until parity. Status markers below
reflect what has shipped; [cli/README.md](../cli/README.md)'s "Relationship to
the bash scripts" section is the authoritative current-status note. (ADR 0014,
separate work, re-scopes phases 6/7.)

1. **Registry + read-only core** *(done)* — `registry/agents.json` generated from §4
   with citations; TypeScript `plan`/`status` running against the *current*
   layout (validates resolver + registry with zero mutation risk).
2. **Ownership state + `apply`** *(done)* — adopt existing installs into state on
   first run; ownership-aware prune replaces readlink heuristics and the
   Hermes special case.
3. **Scoped placement (R1)** *(done)* — read-graph solver, missing-dir creation,
   deny verification in `doctor`; first real scoped skills (drive-codex /
   drive-claude / drive-copilot).
4. **Overlays (R2)** *(done)* — machine config, overlay manifest, missing-root
   abort, privacy guards; create the private repo with its own AGENTS.md
   pointing back at this engine.
5. **Rendering (first-party polish)** *(done)* — `agents/*.yaml` overrides, rendered
   placements, `modified` detection.
6. **Retire bash** *(partial; re-scoped by
   [ADR 0014](adr/0014-upstream-sync-absorption.md))* — port
   `deploy-project-skills.sh` families; script deletion is deferred to
   ADR 0014's phase-4 parity gate (post-cutover soak, deletion as its own
   commit), then bash tests convert to golden `plan --json` tests.
   Local-skill placement and drift are ported; project families still run
   on bash.
7. **Scoped upstream vendoring** *(deferred; re-scoped by
   [ADR 0014](adr/0014-upstream-sync-absorption.md) — unscoped sync absorbed
   as `skm upstream sync`, true vendoring still deferred)* — the store/pinning
   path (deferred until a
   real scoped-upstream need appears; canonical R1 examples are
   locally-authored).
8. **Agent definitions + tprompt export** *(done)* — absorb `custom_agents` as a
   second artifact type and generalize its tprompt harness into a prompt
   export channel for skills too. Decisions: ADR 0007 / ADR 0008; plan:
   [agents-import-plan.md](agents-import-plan.md).

## 11. Deferred / explicitly not-v1

- Per-host layering, machine profiles, fleet state mirroring into the
  private repo (`apply --record`) — revisit only after single-machine
  correctness is proven (ADR 0005).
- TUI — `plan`/`status` human output first; a TUI is a renderer over
  `status --json` if ever wanted.
- npm publishing of the CLI; repo-local execution suffices.

## 12. Open items

- Re-verify flagged registry entries when convenient: grok `~/.agents` and
  claude-compat reads, antigravity's variant-inconsistent global dirs,
  cursor `~/.cursor/skills` vs the `~/.cursor/skills-cursor` dir observed
  on this machine. (Droid shared-dir read: resolved, user-verified yes.)
- Claude Code clone under `~/code/upstream` is ~3 months stale; refresh
  before trusting its frontmatter field list over current docs.
- CLI name: **`skm`** (decided). Private repo name still open.
- Whether `catalog/agent-scopes.json` vs SKILL.md `metadata` is the scoping
  source of truth for public skills (manifest keeps SKILL.md spec-pure;
  frontmatter keeps scoping next to content — currently leaning manifest).
