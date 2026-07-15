# Exclude Overrides

This document describes the implemented user-facing behavior for exclusion
overrides.

`excludeGlobalSpecs` and `excludeFamilySpecs` let `.skills.local.json` subtract
from upstream-managed curated skills as well as add to them.

Use this when the curated catalog is almost right, but you want to remove
specific upstream skills or whole upstream repos from your personal overlay.

For handmade global skills that should survive sync but are not upstream specs,
use `preserveGlobalSkillNames` instead. Preservation only protects existing
skill names from stale removal; it does not install or audit them.

## Glossary

- Include: a spec contributed by curated config or additive local config.
- Exclude: a spec in local config that removes matching upstream-managed specs.
- Normalized explicit set: the resolved `owner/repo@skill-name` list after
  repo-wide specs are expanded.
- Family-scoped exclusion: an exclusion that only applies to one curated
  family's resolved contribution.

## Supported Keys

Add these optional keys to `.skills.local.json`:

- `excludeGlobalSpecs`
  exclusions applied to the merged global set used by
  `skm upstream sync`; accepts repo-wide `owner/repo` and explicit
  `owner/repo@skill-name` entries
- `preserveGlobalSkillNames`
  exact global skill names protected from stale removal by
  `skm upstream sync`; accepts names only, not upstream specs
- `excludeFamilySpecs`
  exclusions keyed by curated family name, applied only to that family's merged
  set during `skm deploy`; accepts explicit
  `owner/repo@skill-name` entries only

## Merge Order

Globals:

1. Load curated global includes.
2. Append local `globalSpecs`.
3. Normalize includes to explicit `owner/repo@skill-name` specs.
4. Load and normalize `excludeGlobalSpecs`.
5. Remove excluded specs from the merged explicit set.
6. Dedupe the final explicit set.

Families:

1. Load curated includes for one family.
2. Append local `familySpecs[family]`.
3. If exclusions are present, normalize repo-wide includes to explicit
   `owner/repo@skill-name` specs for filtering.
4. Load and normalize `excludeFamilySpecs[family]`.
5. Remove excluded specs from that family's merged contribution.
6. Preserve a repo-wide spec when that repo survives filtering unchanged;
   otherwise keep only the explicit surviving specs for that repo.
7. Dedupe the final family contribution and merge selected families into the
   final deploy set.

`exclude > include` is the precedence rule. Once a spec is excluded, it stays
out of the final resolved set even if it was also added locally.

## Matching Rules

- Matching is exact and case-sensitive after normalization.
- Repo-wide exclusions are allowed in `excludeGlobalSpecs`.
- `excludeFamilySpecs` requires explicit skill specs.
- Repo-wide includes and excludes are both expanded to current upstream skills
  before exclusions are applied when the workflow supports them.
- Unknown exclusion specs are valid and silent no-ops.
- Unknown `excludeFamilySpecs` family keys are validation errors.
- Unknown `excludeGlobalSpecs` repo or skill names are accepted and ignored.

## Scope Rules

- `excludeGlobalSpecs` only affects global sync.
- `excludeFamilySpecs[family]` only affects that curated family.
- A skill excluded from one family can still be deployed if another selected
  family contributes it.
- Exclusions can remove locally added upstream specs from `globalSpecs` and
  `familySpecs`.
- Exclusions do not remove local repo-managed skills from `skills/`.
- `excludeFamilySpecs` only targets curated families, not `customFamilies`.
- `preserveGlobalSkillNames` only affects global stale removal and is intended
  for already-installed handmade skills.

## Validation Boundaries

- `.skills.local.json` must remain a JSON object.
- `excludeGlobalSpecs` must be an array of valid skill specs.
- `preserveGlobalSkillNames` must be an array of non-empty strings with no
  whitespace, `/`, or `@`.
- `excludeFamilySpecs` must be an object keyed by curated family name, and each
  value must be an array of explicit skill specs.
- `familySpecs` can only target curated families that exist in the catalog.
- `customFamilies` must define a single-line `description` and at least one
  valid spec.

## Operational Notes

- Some repo-wide include and exclude cases require enumerating current upstream
  skills.
- `skm upstream sync` prints a resolved global summary from the final
  post-exclusion explicit set before mutating installed upstream skills.
- `skm deploy` also enumerates current upstream skills when it
  needs to print exact resolved repo summaries and `^` full-coverage markers,
  even when the selected family specs are already explicit.
- `skm deploy` prints the final post-exclusion planned install
  set before copying skills.
- `^` means the final resolved set covers every currently enumerated upstream
  skill for that repo.
- That means deploys, including `--dry-run`, require `git` whenever exact
  summary coverage cannot be determined from already-cached enumeration data.
- If required upstream enumeration fails, the command fails rather than
  guessing.
- Empty results are valid:
  global sync may resolve to zero upstream-managed globals, and family deploy
  may resolve to zero skills after exclusions. In those cases the summary
  prints `(none)` and the command continues successfully.

## Implementation Notes

- Global sync resolves to a final explicit post-exclusion set. That explicit
  set drives stale removal, install batching, summaries, and coverage audit.
- Family deploy resolves to a final post-exclusion deploy set. If exclusions do
  not narrow a repo-wide family spec, the deploy set can keep the repo-wide
  `owner/repo` entry. If exclusions narrow that repo, the deploy set falls back
  to explicit surviving skills for that repo.
- Resolved repo summaries and coverage audit operate on the effective
  post-exclusion desired state, so intentionally excluded skills do not appear
  as drift and summary lines remain interpretable even when deploy batching
  preserves repo-wide specs.
- Upstream enumeration is reused within one invocation across normalization,
  summary generation, and coverage audit.
- `excludeFamilySpecs` does not apply to `customFamilies`; custom families are
  additive only.

## Verification Notes

- The golden-backed parity suites
  [cli/test/upstream-sync-parity.test.ts](../cli/test/upstream-sync-parity.test.ts)
  and
  [cli/test/deploy-parity.test.ts](../cli/test/deploy-parity.test.ts)
  cover exclusion precedence, repo-wide normalization, resolved summaries,
  `^` marker behavior, and exclusion-aware coverage audit against the retired
  bash scripts' captured output (`cli/test/fixtures/parity-goldens/`). Broader
  validation and empty-result cases live in the `skm` unit suites
  (`cli/test/deploy-*.test.ts`).
- These tests assert observable behavior and exact `skills` CLI arguments
  rather than internal helper structure, which keeps the documented guarantees
  tied to the actual command surface.

## Examples

Global explicit include plus explicit exclude:

```json
{
  "globalSpecs": [
    "owner/repo@skill-a",
    "owner/repo@skill-b"
  ],
  "excludeGlobalSpecs": [
    "owner/repo@skill-b"
  ]
}
```

Result: `skill-b` is excluded. `skill-a` remains.

Repo-wide include plus explicit exclude after normalization:

```json
{
  "globalSpecs": [
    "owner/repo"
  ],
  "excludeGlobalSpecs": [
    "owner/repo@skill-a"
  ]
}
```

Result: the repo-wide include is expanded first, then `skill-a` is removed from
the normalized explicit set.

Per-family exclusion is family-scoped:

```json
{
  "familySpecs": {
    "expo": [
      "owner/repo@team-skill"
    ]
  },
  "excludeFamilySpecs": {
    "expo": [
      "expo/skills@expo-cicd-workflows",
      "owner/repo@team-skill"
    ]
  }
}
```

Result: both exclusions apply to `expo` only. If another selected family also
contains one of those specs, that other family still contributes it.

Repo-wide exclusion:

```json
{
  "excludeGlobalSpecs": [
    "steipete/clawdis"
  ]
}
```

Result: every current upstream skill from `steipete/clawdis` is removed from the
resolved global set.

Empty-result global sync is valid:

```json
{
  "excludeGlobalSpecs": [
    "openai/skills@pdf"
  ]
}
```

Result: if `pdf` was the only resolved upstream-managed global skill, sync
removes it as stale, prints a resolved summary of `(none)`, and completes
without treating the empty result as an error.

Empty-result deploy is valid:

```json
{
  "excludeFamilySpecs": {
    "expo": [
      "expo/skills@building-native-ui",
      "expo/skills@expo-api-routes",
      "expo/skills@expo-cicd-workflows",
      "expo/skills@expo-deployment",
      "expo/skills@expo-dev-client",
      "expo/skills@expo-tailwind-setup",
      "expo/skills@native-data-fetching",
      "expo/skills@upgrading-expo",
      "expo/skills@use-dom"
    ]
  }
}
```

Result: if `expo` was the only selected family and nothing else contributes any
remaining specs, deploy is a successful no-op after exclusions.
