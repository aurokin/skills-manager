# parity goldens

`deploy.json` and `sync.json` are the recorded outputs of the retired bash
scripts `deploy-project-skills.sh` and `install-repro-skills.sh` (plus
`lib/upstream-audit.sh`'s `collect_upstream_skill_names`). They were captured
from those bash scripts one final time at the ADR 0014 deletion commit — the
same fixtures the live-bash parity suites used, frozen the moment before the
scripts were deleted. `deploy-parity.test.ts` and `upstream-sync-parity.test.ts`
now assert the TypeScript `skm deploy` / `skm upstream sync` implementations
against these goldens instead of shelling out to bash.

- `deploy.json` — per-scenario `skills add --copy` argv (six deploy scenarios)
  plus the upstream-enumerator (`collect_upstream_skill_names`) results.
- `sync.json` — per-scenario recorded `skills` argv stream and the resulting
  `$HOME`-normalized filesystem snapshot for the four destructive-edge sync
  scenarios (standard agents, hermes, hermes-only, no-hermes).
