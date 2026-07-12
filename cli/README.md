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

- **Upstream skills.** The vercel `skills` CLI and `install-repro-skills.sh`
  remain authoritative for upstream, unscoped installs into `~/.agents/skills`.
  skm treats anything it does not own as **foreign** — reported, never touched.
- No `deploy`/project families, no upstream vendoring, no TUI.

## Verbs

```
skm plan    [--json]                     desired vs state; exit 2 if changes pending
skm apply   [--json] [--plan <f>] [--prune] [--yes]
skm status  [--json]                     drift: missing|stale|modified|foreign|unsafe
skm doctor  [--json] [--fix]             leaks, broken links, deny-guarantee checks
skm explain <skill> [--json]             source, scoping, placements, bleed
skm root    add|list|remove [<path>]     edit machine config roots
```

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

`link-skills.sh`, `install-repro-skills.sh`, and `lib/agents.sh` remain the
**authoritative** installers until phase 6 of the design doc's migration plan.
During migration skm runs alongside them: it manages local + scoped placement
and ownership, while the bash path continues to install upstream skills. skm
never deletes what it does not own, so the two coexist safely. The scripts are
retired only once skm reaches parity (design doc §10).

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
