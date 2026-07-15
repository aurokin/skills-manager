# ADR 0014: absorbing upstream sync and family deploys into `skm`

- Status: proposed
- Date: 2026-07-14
- Depends on: [ADR 0006](0006-plan-apply-ownership-state.md) (state,
  delete-only-what-we-own), [ADR 0013](0013-skm-review.md) (review console,
  `catalog-specs.ts`, the verified-origin deferral)
- Re-scopes: design doc §10 migration phases 6 and 7

## Context

Two bash scripts are the last holdouts of the migration plan
(`docs/skills-manager-design.md` §10, phases 6/7):

- `install-repro-skills.sh` — unscoped upstream sync. It diffs the desired
  set in `catalog/global-specs.txt` (plus `.skills.local.json` overrides)
  against `skills list -g --json`, then removes stale / updates / adds via
  the external vercel `skills` CLI. It carries real accumulated behavior:
  Hermes add-only scoping (stale removal narrowed with `-a` to non-Hermes
  agents; a broken-symlink sweep of our own dangling writes), the OpenClaw
  `--dangerously-accept-openclaw-risks` flag, diffwarden `--full-depth`,
  `preserveGlobalSkillNames`, and a full-coverage repo audit.
- `deploy-project-skills.sh` — project family deploys via
  `skills add --copy` into a target repo, with per-family exclude/coverage
  semantics.

Both share `lib/{agents,catalog,upstream-audit}.sh`.

The design doc (§3, §5) deliberately kept the `skills` CLI for unscoped
upstream **forever** and reserved vendoring (§5 store/pin) for *scoped*
specs only. That stance is still right: reimplementing git fetch and
multi-agent fan-out to drop a working dependency is not warranted.

But ADR 0013 exposed a real gap. Its review console can only attribute an
upstream install as **`catalogSpec`** — a name-match *expectation*, never
evidence of origin (ADR 0013 lines 88–93 defer verified origin
explicitly). Meanwhile the `skills` CLI already writes
`~/.agents/.skill-lock.json`: a version-3, per-skill install ledger
(`source`, `sourceType`, `sourceUrl`, `skillPath`, `skillFolderHash`,
`installedAt`/`updatedAt`). The evidence ADR 0013 said it lacked already
exists on disk, unread.

## Decision

A **hybrid**, in two independently valuable halves: decisions 1–2 (read
the lock, attribute origin in review) ship first and are complete on their
own; decisions 3–4 (port deploy and sync) are separately gated and
reversible — stopping after 1–2 is alternative (a′), not a broken state.
Throughout, the `skills` CLI stays the fetch/place engine.

### 1. Read-only lock loader (installation evidence)

`skm` gains a small read-only `.skill-lock.json` loader — the sibling of
`catalog-specs.ts`, and its doctrinal opposite: `catalog-specs.ts` parses
*desired* state (expectation), the lock loader reads *installation
evidence* (what the `skills` CLI reports it placed). It never writes the
lock.

Robustness is part of the contract:

- **Truncated/partial/invalid JSON** (the `skills` CLI can be writing
  concurrently) degrades **loudly**: the review model carries a
  "lock unreadable; attribution degraded" marker and every affected entry
  falls back to `catalogSpec` — never silently.
- **Silence is an expected case, not an error.** The real lock on this
  machine is incomplete: `diffwarden` (installed via `--full-depth`) has a
  directory in `~/.agents/skills` but no lock record.
- The golden fixture (`cli/test/fixtures/skill-lock.v3.json`, committed
  with this ADR) is a sanitized capture of the real machine's lock; the
  field names above were verified against it. The lock is keyed **per
  skill name**: a multi-skill repo install (e.g. `openai/skills`, four
  skills) yields one record per skill, so installs are enumerable from the
  lock even though catalog specs without `@` are not.

### 2. Attested-origin attribution in `skm review`

The review model's inventory provenance gains an attested tier, labeled
**"attested · `<source>`"** (from `sourceUrl`/`source`). *Attested*, not
*verified*: the lock is the `skills` CLI's self-report, not proof —
ADR 0013's expectation-vs-evidence line is kept, one rung higher.

The claim is hash-gated: attribution may say attested **only when the
directory's current folder hash matches the lock's `skillFolderHash`**. On
mismatch it falls back to the `catalogSpec` expectation plus an explicit
"modified since install" marker. Where the lock is silent, attribution
falls back to `catalogSpec` or `foreign` exactly as today.

**Drift classification changes not at all in phases 1–2.** `computeDrift`
consults neither catalog nor lock — it iterates state-owned and desired
placements only, and unowned upstream paths produce no drift findings
(inventory provenance is a review-model concern, ADR 0013). That stays
true; no implementer should wire lock or catalog into `computeDrift`.

### 3. Families port to `skm deploy` (the reserved verb)

`skm deploy <family> <dir>` (design doc §8) ports `deploy-project-skills.sh`
on the copy path (`skills add --copy` per repo batch, not symlinks). The
surviving surface, enumerated: repeatable `--family`, `--all-families`,
`--agents`, `--dry-run`, `--yes`, `--list-families`; custom families and
`familySpecs`/`excludeFamilySpecs` from `.skills.local.json`; the
curated-family exclude resolution (whole-repo preserve-vs-explicit
expansion in `lib/catalog.sh`); the family coverage audit. **Interactive
prompt mode is dropped** — `skm` is agent-first (R3), and
`--list-families` plus flags cover the human path.

### 4. Unscoped upstream sync absorbed as `skm upstream sync`

`skm` owns the desired-state diff against `catalog/global-specs.txt` and
shells out to the `skills` CLI as the fetch/place engine. Behavior
preserved verbatim: Hermes add-only scoping and the owned-target
broken-symlink sweep, OpenClaw risk flags, diffwarden full-depth,
`preserveGlobalSkillNames`, the coverage audit.

**`.skills.local.json` is a required input of both new verbs**, not an
optional nicety: `lib/catalog.sh` reads `globalSpecs`,
`excludeGlobalSpecs`, `preserveGlobalSkillNames`, `familySpecs`,
`excludeFamilySpecs`, and `customFamilies` from this gitignored quick-tweak
file, with validation. The port carries the whole override + validation
surface, or users' machine-local overrides silently die.

**No reproducibility is added.** Sync is latest-wins today and stays
latest-wins after the port; pinning belongs to the deferred vendoring path
(decision 5) and nothing here preempts it.

**Ownership boundary (load-bearing):** `skm` **never adopts** upstream
real-dirs into `state.json` — the delete-only-what-we-own guarantee
(ADR 0006) depends on that, full stop: a bad prune cannot delete what was
never owned. The lock and catalog inform *attribution in the review model
only*; drift computation ignores upstream dirs before and after this ADR.

**Deletion is deferred, and is its own commit.** The bash scripts are
*not* deleted in the cutover PR: `install-repro-skills.sh` /
`deploy-project-skills.sh` / `lib/*.sh` stay through one post-cutover soak
period; deletion lands as a final separate commit with the parity
evidence, when `maintenance/test-*.sh` converts to goldens.

**Doc surface reconciliation.** Root `CLAUDE.md`'s "Adding a New Upstream
Skill" ("add an entry to the `specs` array in `install-repro-skills.sh`")
is stale *today* — the truth is `catalog/global-specs.txt`. The port
updates every doc surface that names the bash entrypoints (`CLAUDE.md`,
`README`, `cli/README.md`).

### 5. True vendoring stays deferred

The design doc §5 store/pin path (scoped upstream: clone/sparse-checkout
into a manager-owned cache at a pinned revision, adopted into state) is
**unchanged** — still deferred until a real scoped-upstream need appears.
This ADR reads the lock; it does not build the store.

### Out of scope

The `agents-md` weekly CI fork-sync (`maintenance/sync-agents-md.sh`) is
untouched — a generator, not upstream placement; it keeps its own CI job.

## Consequences

- `skm review` reports attested provenance where lock and on-disk hash
  agree, distinct from catalog expectation; mismatch and unreadable-lock
  states surface as explicit markers, never silently.
- One tool operates the whole surface (`plan`/`apply`/`review`/`deploy`/
  `upstream sync`); the `skills` CLI shrinks to a fetch backend behind a
  `skm` verb rather than a parallel entrypoint.
- Cost: `skm` depends on the `skills` CLI's on-disk lock schema (v3). A
  schema bump could break the loader; the committed fixture pins the shape,
  and the loader degrades to marked `catalogSpec` fallback, not a failure.
- Two ownership models coexist by design: state-owned (skm artifacts,
  prunable) and lock-attested (upstream, never pruned by skm). The boundary
  is the safety property, stated so it is not "fixed" into one model later.

## Implementation plan

Each phase is an independently reviewable, diffwarden-gated PR with tests
(ADR 0013 precedent); the tool stays usable at every step. Phases 1–2
carry no mutation risk; phases 3–4 are separately gated and reversible.

1. **Lock loader** — read-only loader with unit tests: v3 shape (against
   the committed sanitized fixture), missing lock, truncated/partial JSON
   (loud degradation), lock-silent skills (the real full-depth case).
2. **Attested origin in review** — the attested tier with its
   `skillFolderHash` gate; "modified since install" and "attribution
   degraded" markers; model goldens; a test asserting drift classification
   is byte-identical before/after. *Stopping here is (a′).*
3. **`skm deploy` families** — port with a parity assertion: TS path and
   bash script run against fixture families (including `.skills.local.json`
   overrides and custom families) and their resolved install plans diffed.
4. **`skm upstream sync` cutover** — parity must assert the **destructive
   edges**, not just converged sets: (i) Hermes add-only `-a` scoping —
   never deletes from `~/.hermes/skills`; (ii) the broken-symlink sweep
   touches only links resolving to our targets; (iii) OpenClaw risk flag
   and diffwarden full-depth arguments; (iv) preserve-lists; (v)
   `.skills.local.json` excludes/preserves honored. Bash stays in place for
   one soak period post-cutover; deletion (+ bash-test → golden conversion,
   doc-surface reconciliation) is its own final commit with the parity
   evidence.
5. **Deferred vendoring** — unchanged from design doc §5; opened only when
   a scoped-upstream need is real.

## Alternatives considered

- **(a) Status quo — bash forever.** Keep both scripts; leave review at
  `catalogSpec`. Cons: install evidence unread, two entrypoints persist,
  phases 6/7 never close. No upside beyond doing nothing.
- **(a′) Evidence only — read the lock for review now; leave bash sync and
  deploy in place indefinitely.** The dominant alternative: all of the
  attribution value, none of the port risk — phases 1–2 *are* it. The cost
  is a permanent two-manager split — two entrypoints, two test harnesses,
  three `lib/*.sh` files nobody maintains — which the repo's own docs
  (cli/README, design §10) treat as migration debt, with every future sync
  feature still landing in bash. Porting anyway buys the single-manager end
  state, retires two scripts plus the lib trio, and converts the bash tests
  to goldens; the phase structure keeps (a′) as the standing fallback if
  3–4 stall.
- **(b) Full vendoring — `skm` clones/pins everything and drops the
  `skills` CLI.** One ownership model, no external dependency. Cons:
  reimplements git fetch, multi-agent fan-out, and upstream repo
  enumeration the CLI already does well; and requires a risky one-time
  adoption migration of existing upstream real-dirs into `state.json` — the
  exact move decision 4's ownership boundary exists to avoid. Rejected as
  disproportionate; the store/pin path remains available (§5) if a scoped
  case ever forces it.
