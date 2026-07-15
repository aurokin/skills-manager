# ADR 0013: `skm review` — the skill-surface review console as a first-class verb

- Status: proposed
- Date: 2026-07-14
- Depends on: [ADR 0006](0006-plan-apply-ownership-state.md) (state),
  [ADR 0009](0009-dialect-document-emitter-rendering.md) (rendering),
  [ADR 0010](0010-composed-skills-artifact-type.md) /
  [ADR 0012](0012-shared-provider-pools.md) (composed skills),
  [ADR 0011](0011-user-invoked-only-skill-gating.md) (gating)

## Context

During the 2026-07 skill-surface review, a prototype console
(`~/workspace/skill-review/`: a Bun build script plus an HTML template)
proved its worth: a single self-contained page showing every unit the
manager owns — private/public native skills, composed skills with a full
consumer × posture matrix, agent definitions across six harness renders —
plus an installed-now inventory of every agent skill directory with
provenance labels, click-to-read SKILL.md content, and deployed-vs-compiled
drift chips. It became the primary review instrument for a multi-day
curation pass and doubled as a drift detector.

The prototype is also exactly the kind of artifact this repo's doctrine
rejects:

- It re-derives facts the engine already owns. Unit membership, deploy
  locations, gating, agent dirs, and machine identity are **hardcoded
  lists** in the build script. During one session they drifted from
  reality three times (a skill moved repos, a skill became gated, a
  skill was retired) and each drift required a hand edit to a file the
  engine knew nothing about.
- It reaches into `cli/src/` internals via a cross-repo relative import
  (`../../code/custom_skills/cli/src/composed/render`), so engine
  refactors can silently break it.
- Its drift detection is a parallel implementation (ad-hoc byte
  compares) of what `skm status` already computes as a three-way
  desired/state/disk diff with named drift classes.
- It lives outside any repo, untested, unreviewed, and unversioned.

The feature is wanted permanently ("extremely useful"), so it graduates
into the manager proper: data-driven, accurate, tested — a renderer over
the engine's model, not a second model.

## Decision

### New read-only verb: `skm review`

`skm review` joins `status` and `doctor` as a reporting verb. It mutates
nothing. Two output modes:

- `skm review` — writes a single self-contained HTML file and prints its
  path.
- `skm review --json` — emits the underlying **review model** to stdout.

The HTML is a pure function of the review model. Everything the page
shows must exist in the model; the template computes presentation only
(diff highlighting, layout), never facts.

### The review model is the contract

A versioned JSON document (`reviewModelVersion: 1`) assembled entirely
from engine APIs — no filesystem knowledge or name lists of its own:

| Model section | Source of truth |
|---|---|
| Units (native, composed, agent-def) and their grouping | root loaders via `loadContext` — every artifact the resolver sees, public and overlay roots alike |
| Gating, scoping, badges | the same frontmatter/overlay/`skill.yaml` parsing the solver uses |
| Variant renders (per consumer, per posture, per harness dialect) | `renderComposedSkill` / agent-def emitters — the real pipeline, both postures compiled for composed units |
| Deploy locations and ownership | `computeDesiredPlacements` + the state file (ADR 0006) |
| Deployed-vs-compiled accuracy chips | `computeDrift` drift classes (`missing`/`stale`/`modified`/`foreign`/`unsafe`) — not a parallel byte-compare |
| Installed-now inventory dirs | the agent registry's per-agent skill dirs — not a hardcoded dir list |
| Inventory provenance labels | `scan.ts` classification + state ownership + the new specs loader (below) |
| Embedded skill documents (click-to-read) | file reads deduplicated by resolved real path, size-capped, keyed into inventory entries |
| Machine identity, build time | state file machine + clock — no literals |

**Upstream attribution needs a new engine API — that is in scope.**
Upstream skills are not in skm's model today: bash owns upstream sync
until migration phase 6/7, they are absent from the ownership state, and
`computeDrift` rightly classes them `foreign`. No engine loader parses
`catalog/global-specs.txt`. Rather than let the review model re-parse
catalogs inline (the prototype's sin), phase 1 adds a small read-only
specs loader to the engine (`cli/src/catalog-specs.ts`: global specs,
overlay catalogs, families). One honesty rule governs its use: **catalog
specs are desired state, not installation evidence.** A name-match
cannot prove where a directory came from (a manual install shadowing a
catalog name would be misattributed, and repo-wide specs without
`@skill-name` don't enumerate names at all). The model field is
therefore `catalogSpec` — "matches curated entry `<owner>/<repo>`" — and
the page labels it as catalog expectation, never as verified origin.
Verified origin requires real installation metadata (the `skills` CLI's
own records, or skm's state once phase-7 vendoring lands) and is
explicitly deferred to that path. Sync stays with bash; the loader is
the natural first brick of phase 7.

**Editorial notes are authored data, not view strings.** The prototype's
per-unit prose ("byte-for-byte fork of the Cursor app's shipped skill…")
was hardcoded in the build script. Mechanical notes (gating behavior,
rendered-by, sync provenance) are generated from model facts. Anything
beyond that moves into the source artifact as an optional `review-note`
frontmatter key (SKILL.md, `skill.yaml`, `agent.yaml`) rendered
verbatim — authored once, next to the thing it describes, or dropped.

**The drift join is model-assembly work, specified here.** `computeDrift`
emits findings only for drifted placements, keyed by path. The model
assembler joins the full desired-placement set against those findings:
placement present + no finding = clean chip; finding present = its drift
class; placement absent from desired = not a chip at all. Every matrix
cell and inventory row carries the joined result, so the template never
reasons about drift — it colors what the model says.

Golden tests pin the review model the way plan goldens pin plans — but
the fixture is a **complete fabricated `SkmEnv`**, not just a source
root: fake HOME with fabricated deploy dirs, a fabricated state file,
and fixture catalogs, because the model spans desired state, disk state,
and inventory. The engine already routes filesystem access through
`env`/`expandTilde`, which is what makes this feasible. The model is the
tested surface; the HTML renderer is smoke-checked (sections present,
data JSON parses, no external URLs) — the interaction JS is reviewed and
versioned, not unit-tested, except `linediff.ts` (below).

### View layer

- The template moves into the repo at `cli/src/review/template.html` and
  is loaded relative to the module (no cross-repo imports). Output is
  produced by injecting the model JSON (with `<` escaped) into the
  template — same single-file mechanism as the prototype, now versioned
  and reviewed.
- The page keeps the prototype's proven interactions: unit sidebar with
  groups, name/text filter, consumer segmented control + posture switch,
  source lens with posture-block dimming and ghost lines, matrix map,
  file-tree deltas, inventory with provenance dots and expandable
  SKILL.md panels, keyboard shortcuts. It must remain fully
  self-contained (inline CSS/JS, `<meta charset>`, no external requests)
  so it renders anywhere a file can be opened.
- Embedded documents are budgeted: per-doc cap (80 KB, as the prototype)
  plus a page-total docs budget (default 4 MB); past it, docs are
  dropped largest-first with a visible "content omitted, run with
  `--no-doc-budget`" marker — never silently.
- The posture line-diff (LCS ghosts) becomes a small pure module
  (`cli/src/review/linediff.ts`) with unit tests — it is the one piece
  of real algorithmic logic in the view path.

### Privacy

The rendered page embeds private-overlay content (it is precisely the
review of that content), so the output is treated like a private
artifact under the ADR 0001/0006 privacy rules:

- Default output path is machine-local state, not a repo:
  `$XDG_STATE_HOME/skills-manager/review.html` (fallback
  `~/.local/state/...`).
- `--out <path>` refuses to write inside any git worktree whose origin
  is not privacy-allowlisted, reusing the `privacy.ts` guard that
  already protects private placements.
- The page is never committed, published, or served; `review` gets no
  HTTP mode.

### Explicitly out of scope (v1)

- Watch/serve modes, live reload. A static file regenerated on demand is
  the feature.
- Multi-machine aggregation (fleet review) — revisit only after ADR 0005's
  single-machine correctness stance loosens.
- Editing from the page. The console reviews; `skm apply` changes.

### Inventory coverage and registration

Inventory enumerates the skill dirs of **all registered agents**
(enabled or not) that exist on disk, **plus** any dir the state file has
ever placed into — so leftovers under a since-disabled agent stay
visible. A dir belonging to an agent absent from the registry is
invisible to `skm review`; the fix is registering the agent, which is
the doctrine (the prototype's hardcoded list currently covers one dir,
`~/.factory/skills`, whose agent is not in the registry — it gets a
registry entry or is knowingly dropped, decided at implementation).

Likewise, private units appear only when the private overlay root is
registered in machine config. On an unregistered machine `skm review`
shows no private units — by design, but stated here so an empty private
section reads as "root not registered," not "no private skills."

### Prototype retirement

`~/workspace/skill-review/` is deleted once `skm review` reaches parity.
The parity checklist ships as an assertion list in the phase-4 PR (not
prose): unit groups (private native incl. gated variants, composed
matrix with both postures + deployed chips, shared provider pool, public
native, agent definitions across harness renders), inventory with
provenance + docs, ghosts toggle, source lens, matrix map, sidebar
filter, keyboard shortcuts, drift indicators.

## Implementation plan

Each phase is an independently reviewable PR with tests; the verb ships
usable at every step.

1. **Review model + `--json`** — the `catalog-specs.ts` loader (with its
   own unit tests), then `cli/src/review/model.ts` assembling the model
   from engine APIs including the drift join; golden fabricated-`SkmEnv`
   fixture tests; `review` verb registered with `--json` only.
2. **HTML renderer** — template ported into `cli/src/review/`, model
   injection, rendering tests; `skm review` writes the file to the
   default state path; `--out` with the privacy guard.
3. **Diff/ghost module** — `linediff.ts` extracted pure with unit tests;
   posture matrix cells carry diff annotations in the model rather than
   being computed in the page.
4. **Retirement** — prototype deleted after a side-by-side parity pass;
   README/AGENTS.md document the verb; review-console workflow notes move
   into `cli/README.md`.

## Consequences

- The console can no longer drift from reality: a skill added, gated,
  moved, or retired appears correctly in the next `skm review` run with
  zero edits, because membership and placement come from the same code
  paths `plan`/`apply` use.
- `--json` makes the review model scriptable (e.g. CI could diff two
  models, or a future fleet report could aggregate them) without
  committing to the HTML as an interface.
- The engine gains its first consumer of `computeDrift` and
  `renderComposedSkill` outside their home verbs. That is a maintenance
  cost as much as a benefit: engine refactors will sometimes break
  review, and the golden tests exist to catch it in-repo instead of
  silently, as the prototype's cross-repo import broke.
- Cost: the template (~700 lines of HTML/CSS/JS) enters the reviewed,
  versioned surface of the CLI — model and `linediff.ts` tested,
  interaction JS smoke-checked. That trade is the point.
