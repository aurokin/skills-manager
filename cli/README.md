# skm — Skills Manager CLI

A TypeScript CLI (Bun runtime, Node-compatible APIs) that manages **local**
agent skills: skill directories under `<root>/skills/<name>/` of the public repo
and registered overlay repos, placed into each agent's skill directories
according to per-agent scoping, with first-party frontmatter rendering,
ownership tracking, and drift detection.

This is the engine described in [`docs/skills-manager-design.md`](../docs/skills-manager-design.md)
and ADRs [0003](../docs/adr/0003-agent-capability-registry.md),
[0004](../docs/adr/0004-first-party-frontmatter-rendering.md),
[0006](../docs/adr/0006-plan-apply-ownership-state.md).

## v1 scope

In scope:

- **Local skills** from the public repo plus registered overlay roots.
- **Agent-scoped placement** via a read-graph solver over
  `registry/agents.json` (`allow` = exactly-these; `deny` = hard guarantee).
- **First-party rendering** for claude-code / codex / github-copilot
  (`agents/*.yaml` frontmatter deep-merged into a real dir copy).
- **Composed skills** from `composed/<name>/` of any root: one source
  (`skill.yaml` + `SKILL.tmpl.md` + `providers/*.md` + `consumers/*.md`)
  rendered into a per-consumer skill tree — routing table with ordinal
  fallback chains, registry-derived self-exclusion, compile-time posture
  (`sandboxed`/`yolo`), only-referenced provider references. Placement hash
  is the full rendered-tree hash; hand-edited trees are detected by
  `status`/`doctor` and repaired by remove-then-re-apply
  ([ADR 0010](../docs/adr/0010-composed-skills-artifact-type.md)).
- **Gated (user-invoked-only) skills.** Any local skill whose source `SKILL.md`
  frontmatter declares `disable-model-invocation: true`. The declared intent is
  translated per agent from `registry/agents.json`'s `skillInvocation.gate`:
  gate-honoring agents (frontmatter, or codex's `agents/openai.yaml` companion)
  get the skill as a **rendered tree** in their own dir — never a symlink, never a
  shared root (a forced shared root is a hard error). No-gate/unknown agents are
  excluded unless an overlay opts them in per-skill
  (`gating: { permissive: ["gemini-cli", ...] }`, relying on the skill's prose
  gate). The placement hash covers every rendered file (SKILL.md + companion),
  reusing the composed tree-hash binding, so a tampered/deleted companion drifts;
  `doctor` also flags gated skills found in a shared root or a no-gate agent's dir,
  and warns when an agent's installed CLI has drifted from its probed gate version
  ([ADR 0011](../docs/adr/0011-user-invoked-only-skill-gating.md)).
- **Ownership state** + `plan`/`apply` (Terraform-style), drift `status`,
  `doctor`, `explain`.

Out of scope for v1 (unchanged; owned elsewhere):

- No upstream vendoring, no TUI.

Now in scope (ADR 0014): **project-family deploys** via `skm deploy` and
**unscoped upstream sync** via `skm upstream sync` (see below). The vercel
`skills` CLI stays the fetch/place engine behind both verbs; skm treats any
upstream install it does not own as **foreign** — reported, never touched,
never adopted into `state.json`.

## Verbs

```
skm plan    [--json]                     desired vs state; exit 2 if changes pending
skm apply   [--json] [--plan <f>] [--prune] [--yes]
skm status  [--json]                     drift: missing|stale|modified|foreign|unsafe
skm doctor  [--json] [--fix]             leaks, broken links, deny-guarantee checks
skm explain <skill> [--json]             source, scoping, placements, bleed
skm review  [--json] [--out <path>]      HTML review console (ADR 0013); --json emits the model
skm root    add|list|remove [<path>]     edit machine config roots
skm deploy  <dir> [--family <n>]… [--all-families] [--agents "<a b>"] [--dry-run] [--yes] [--list-families]
skm upstream sync                        sync global upstream skills (remove stale / update / add missing)
```

`skm deploy` (ADR 0014 decision 3) copies curated / custom skill **families**
into a project directory via `skills add --copy` — the port of the retired
`deploy-project-skills.sh` on the copy path. It reads the curated catalog
(`catalog/families.tsv` + `catalog/families/*.txt`) plus the `.skills.local.json`
`familySpecs` / `excludeFamilySpecs` / `customFamilies` overrides (validated),
resolves the whole-repo preserve-vs-explicit exclude expansion, runs the family
coverage audit, and shells out to the `skills` CLI per repo batch. The bash
interactive prompt mode is dropped (`--list-families` + flags are the human path).
Deployed copies are **not skm-owned**: `deploy` never reads or writes `state.json`
(ADR 0014 ownership boundary), so it coexists with `plan`/`apply`.

`skm upstream sync` (ADR 0014 decision 4) is the port of the retired
`install-repro-skills.sh`: it diffs the desired set in
`catalog/global-specs.txt` (+ `.skills.local.json` `globalSpecs` /
`excludeGlobalSpecs` / `preserveGlobalSkillNames`, validated) against
`skills list -g --json` and drives the `skills` CLI through the same three
phases — remove stale, update existing, add missing. Behavior preserved
verbatim: Hermes add-only scoping (stale removal narrowed with `-a` to
non-Hermes agents — never deletes from `~/.hermes/skills`) plus the
owned-target broken-symlink sweep; the OpenClaw
`--dangerously-accept-openclaw-risks` flag; diffwarden `--full-depth`;
preserve-lists; the full-coverage repo audit; and the `$SKILLS_AGENTS` /
`$SKILLS_BIN` / `$SKILLS_AUDIT_REPO_COVERAGE` / `$UPSTREAM_COVERAGE_FILE`
env semantics. Sync is latest-wins (no pinning); upstream installs are never
adopted into `state.json`.

Conventions: `plan` never mutates. `apply --plan <file>` runs exactly the
reviewed plan (refused if the desired-state hash changed). Every verb supports
`--json` (stable shapes); a TTY without `--json` gets human-pretty output.

**Exit codes** (Terraform detailed-exitcode): `0` clean · `1` error ·
`2` changes pending / drift.

## Safety rules

- **Deletion invariant.** `apply` only ever deletes paths recorded in the
  ownership state. Pruning owned-but-undesired placements requires `--prune`.
  Anything else on a target is `foreign` — skipped and reported.
- **Adoption.** An existing symlink already pointing at the correct source is
  adopted into state, not treated as an error.
- **Hermes is add-only.** Hermes placements are never pruned and never
  overwrite a real directory.
- **Privacy guards.** Private-visibility skills refuse placement inside a git
  worktree whose `origin` is not in `privateOriginAllowlist`; `doctor` scans for
  private content in unexpected locations and deny-guarantee violations.
- **No real HOME in tests.** Every path resolves through the injected `SkmEnv`
  (`src/env.ts`); tests build a temp sandbox and never touch the real machine.
  Determinism: time comes from `env.clock`, machine name is injected.

## Configuration

- Machine config: `~/.config/skills-manager/config.json`
  (honors `XDG_CONFIG_HOME`). Missing file ⇒ one public root at the repo
  containing this CLI, standard agents (every `supported` agent except hermes).
- Ownership state: `~/.local/state/skills-manager/state.json` +
  append-only `audit.jsonl` (honors `XDG_STATE_HOME`).
- Public scoping: `catalog/agent-scopes.json`. Overlay scoping:
  `<root>/overlay.json`.

## Relationship to the bash scripts

The bash scripts are **retired**. skm is the sole owner of the whole surface.
`link-skills.sh` went first, at local-skill placement parity (gate awareness,
hermes add-only, stale-link pruning are covered by `cli/test`). ADR 0014
completed the migration: `skm deploy` is the port of `deploy-project-skills.sh`
on the copy path (decision 3) and `skm upstream sync` is the port of
`install-repro-skills.sh` (decision 4). At the ADR 0014 final commit
`install-repro-skills.sh`, `deploy-project-skills.sh`, and `lib/*.sh` were
deleted, and the live-bash parity suites became golden-backed:
`test/deploy-parity.test.ts` and `test/upstream-sync-parity.test.ts` now assert
the TS paths against `test/fixtures/parity-goldens/{deploy,sync}.json` — the
bash scripts' recorded install plans / `skills` argv / filesystem state,
captured one final time from those scripts the moment before deletion. The
destructive edges (Hermes add-only narrowing and sweep, OpenClaw/diffwarden
flags, preserve-lists, excludes) survive as golden assertions. skm never
deletes what it does not own — and neither the `deploy` nor `upstream sync`
verb touches `state.json` (ADR 0014 ownership boundary). Scoped upstream
vendoring (design §5, phase 7) stays deferred.

## Development

```bash
bun install         # once; single dependency: yaml
bun test            # bun test discovers test/*.test.ts
bun src/cli.ts …    # run the CLI (also: bun run skm …)
```

Module layout (`src/`): `types.ts` (domain contract), `env.ts` (injected env +
path roots), `registry.ts` / `machine-config.ts` (implemented), and stubs for
`resolve`, `solver`, `render`, `plan`, `apply`, `status`, `doctor`, `explain`,
`state`, `scan`, `audit`, `catalog`, `overlay` — each throwing `NotImplemented`
until its owning team fills it in.
