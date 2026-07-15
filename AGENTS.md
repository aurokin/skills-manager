# Agent Instructions

## Purpose

- This repo is the public engine and catalog for Skills Manager (`skm`).
- `skm` manages local, gated, composed, and upstream skills plus agent definitions.
- The external `skills` CLI remains the fetch/place backend for `skm upstream sync` and `skm deploy`.

## Commands

| Task | Command |
|---|---|
| Install CLI dependencies | `cd cli && bun install` |
| Run all CLI tests | `cd cli && bun test` |
| Run one CLI test | `cd cli && bun test test/<name>.test.ts` |
| Preview managed placements | `cd cli && bun src/cli.ts plan` |
| Apply managed placements | `cd cli && bun src/cli.ts apply` |
| Build the review console | `cd cli && bun src/cli.ts review` |
| Sync upstream skills | `cd cli && bun src/cli.ts upstream sync` |
| Deploy a project family | `cd cli && bun src/cli.ts deploy <dir> --family <name> --yes` |
| Validate the `agents-md` fork | `bash maintenance/test-agents-md.sh` |
| Refresh the `agents-md` fork | `bash maintenance/sync-agents-md.sh` |

## Repository Map

| Need | Path |
|---|---|
| Operator guide | `README.md` |
| CLI reference | `cli/README.md` |
| Integrated architecture | `docs/skills-manager-design.md` |
| Decisions | `docs/adr/README.md` |
| Upstream catalog | `catalog/global-specs.txt` |
| Project families | `catalog/families.tsv`, `catalog/families/*.txt` |
| Catalog conventions | `catalog/README.md` |
| Agent capabilities | `registry/README.md`, `registry/agents.json` |
| Local skills | `skills/<name>/SKILL.md` |
| Agent definitions | `agents/<name>/agent.yaml`, `agents/<name>/instructions.md` |

## Conventions

- Use `bun` from `cli/`; `skm` shells to an external `skills` executable when fetching or placing upstream skills.
- Add local skills under `skills/`; add upstream skills to `catalog/global-specs.txt`.
- Add agent definitions as a complete `agent.yaml` plus non-empty `instructions.md` pair.
- Put private skills and host-specific overrides in a registered overlay root, not this public repo.
- Treat `skills/agents-md/SKILL.md` as generated; change it only through the maintenance sync.
- Declare user-invoked-only skills with `disable-model-invocation: true`; see ADR 0011.
- Never run the archived `custom_agents` repo's `shared-agents` tool; `skm` owns those placements now.
- Preserve the ownership boundary: `plan`/`apply` state never adopts installs made by `upstream sync` or `deploy`.
- Preserve user changes in dirty worktrees and never delete foreign placements.
- Keep `CLAUDE.md` as a symlink to this file; do not maintain a divergent copy.

## Verification

- Run the narrowest relevant test while iterating, then `cd cli && bun test` before handoff.
- For catalog or sync changes, run the targeted upstream/deploy unit and parity tests; never exercise real global sync as a test.
- For placement or rendered-artifact changes, inspect `skm plan`; do not apply to the real home during tests.
