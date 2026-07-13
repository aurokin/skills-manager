# ADR 0010: Composed skills — per-consumer rendered skills with a build matrix and posture

- Status: accepted
- Date: 2026-07-11
- Amended by: [ADR 0012](0012-shared-provider-pools.md) (shared provider pools; provider-set derivation)

## Context

Local skills are symlinks: one source, byte-identical in every directory
they are placed. The `orchestrate` skill — which teaches a coding agent
(the *consumer*) when and how to delegate to other coding agents (the
*providers*) — cannot be that. Its routing table, its included
per-provider reference files, its frontmatter description, and even its
safety instructions all differ per consumer (a consumer must never see
itself as a provider) and per deployment posture (sandboxed vs
permission-bypassed hosts). skm already renders per-target artifacts —
agent definitions fan one source into N differently-hashed
`rendered-file` placements under one state artifact (ADR 0007) — so the
precedent exists; skills just never used it.

The design behind this ADR went through two full adversarial review
rounds (5 lenses + synthesis each, the second verifying the first) plus a
targeted review of the posture mechanism; the full design lives in the
"Composed skills + orchestrate" Linear milestone description. This ADR
records the architectural decisions.

## Decision

A third artifact type: **`composed-skill`**.

### Source and identity

- New per-root scan dir `composed/<name>/`, marker `skill.yaml` —
  mirroring `skills/` (SKILL.md) and `agents/` (agent.yaml). A composed
  source under `skills/` would be silently skipped by the scanner, so it
  gets its own dir rather than a second marker inside `skills/`.
- Source = `skill.yaml` (posture, consumers with per-consumer
  descriptions, ordered dimensions with candidate lists) +
  `SKILL.tmpl.md` (named slots only, no expressions) + `providers/<p>.md`
  (frontmatter = the provider registry: cli, models, verified; body = the
  progressively disclosed reference) + optional `consumers/<c>.md`
  (marker-split into a pre-table gate section and an end-of-body
  appendix).
- Single sources of truth, no parallel registries: the provider set is
  the filenames under `providers/`; models live only in provider
  frontmatter; the consumer's "self" provider is derived from the
  registry `ownDir` (not declared). Guards, because ownDir↔provider-id
  alignment is a coincidence of the v1 set (droid's ownDir is `factory`):
  provider filenames must match registry directory ids, and a consumer
  whose derived self matches no declared provider requires an explicit
  `selfProvider: none` acknowledgment.
- Composed names participate in the one shared output-namespace collision
  guard (pairwise vs native and derived skills). Two consumers resolving
  to the same ownDir is a build error.

### Render

Pure function: bytes = f(source, consumer, posture).

- Enabled providers for consumer C = declared providers − self(C). Per
  dimension, the emitted row is the resolved candidate **chain** (all
  candidates whose provider is enabled; first is primary, the rest render
  as fallback annotations). Fallback providers count as *referenced*.
  References copied into the deployed tree are exactly the referenced
  providers — never the consumer's own. An empty chain drops the
  dimension silently (self-exclusion drops are designed outcomes; plan
  warnings are reserved for availability-caused drops when that machinery
  lands). When self was the rank-1 candidate, the row carries a
  conditional note (offload for parallelism/quota, not capability).
- Posture (`sandboxed` type default | `yolo`) selects instruction
  variants via marker blocks filtered at render, in the template,
  provider bodies, and consumer files alike. Normative grammar — the
  failure mode of leaving it loose is silent content loss from a compile:
  markers only at line start and outside fenced code blocks;
  `<!-- @posture <value> -->` must name a declared posture; every block
  closed by `<!-- @end -->` before EOF; no nesting; no crossing an
  `@section` boundary in consumer files. All violations are build errors.
  Filtering runs per source file before slot insertion. Unfiltered marker
  text in rendered output is a golden-detectable bug.
- Provider bodies are not verbatim: they get the same slot substitution
  (v1 legal slot: `{{provider_clis}}`, which expands to ALL declared
  providers' CLIs regardless of reference copying — the anti-recursion
  line must inoculate against every provider). Authoring rule: provider
  bodies are consumer-neutral in voice; consumer-relative material lives
  in the consumer gate/appendix.
- Frontmatter (name + per-consumer description) is emitted via
  `yaml-canonical` uniformly (ADR 0009); there is no per-consumer skill
  frontmatter dialect split — it buys no byte difference.

### Placement, plan, state

- `appendComposedSkills` fans out one `kind: "rendered"` placement per
  consumer to that consumer's `ownDir`, bypassing the read-graph solver
  (agent-def precedent, ADR 0007). It sets `placement.deprecated` from
  the registry directory entry itself (the solver's lookup does not run),
  and reports bleed with a readers-including-maybeReads variant (the
  deny-guarantee `bleedFor` deliberately excludes maybeReads and would
  hide, e.g., grok's read of the claude dir).
- **Content binding: a composed placement's `hash` IS the full
  rendered-tree hash**, computed in-memory byte-compatibly with
  `treeHashOf`. Precedent: `hash` already means file-sha for
  `rendered-file` vs SKILL.md-sha for `rendered`. Consequences:
  `planHashOf` is untouched; `materializeComposed` keeps the single
  hash-precondition idiom; `diffComposed` compares expected in-memory
  tree hash and on-disk `treeHashOf` against state; `computeDrift`
  (status) and doctor `diagnose` each gain a composed arm keyed on
  artifact type — and those arms MUST run before the `rendered` branches,
  whose SKILL.md-sha checks would false-positive under the new hash
  meaning. Doctor reports composed placements `fixable: false`; hand-edit
  drift is repaired by remove-then-re-apply, not plain `skm apply`.
- `hashDesiredState` carries selection identity only ({name, root,
  visibility, source path, posture, consumers}), consistent with every
  other artifact type; content is bound by the placement hash plus the
  apply-time stale re-check.
- Doctor's unmanaged-private-leak scan additionally indexes every
  consumer's expected rendered SKILL.md hash (the scan otherwise only
  hashes plain-skill source SKILL.md files, leaving copies of deployed
  composed trees invisible).
- `explainSkill` gains a composed lookup arm.
- `STATE_VERSION` 3→4 as a pure forward-compatibility fence: no transform
  body (v3 states are valid v4); the bump exists so an older skm
  hard-fails instead of mis-pruning composed trees it would misread as
  generic rendered artifacts.
- The privacy guard applies unchanged (placements carry source
  visibility; checked at plan and at write time).

### Deferred, with reserved shape

Per-machine provider availability (and a machine posture override) ships
only when a machine actually missing a provider onboards. Reserved
machine-config shape, namespaced so its single consumer is obvious:
`{ "composedSkills": { "providers": { "available": [...] }, "posture":
"..." } }` — config wins over skill.yaml when it lands; explicit config
is truth and PATH detection stays doctor advice, so plans remain
deterministic and reviewable.

## Probe results recorded (koopa, 2026-07-11)

- **Cursor duplicate-name collision** (cursor reads both target dirs and
  would see two skills named `orchestrate`): probed with two same-named
  dummy skills — cursor-agent 2026.06.26 dedupes by name with
  **claude-dir precedence**, no error; the codex-dir variant is silently
  shadowed. Stable across runs. So cursor loads only the claude-code
  variant, whose first body line is the self-abort guard ("do not follow
  its instructions" — obeying is forbidden, reading is not). Name-suffix
  mitigation is structurally unavailable (the agent-skills spec ties
  frontmatter name to directory name). Accepted; long-term fix is an
  upstream kill-switch (opencode precedent). The plan warning for the
  claude placement records this.
- **YOLO bypass forms** (all verified writing a probe file, exit 0):
  `claude -p --dangerously-skip-permissions` (2.1.207); `codex exec
  --dangerously-bypass-approvals-and-sandbox` (0.144.1); grok accepts
  both `--permission-mode bypassPermissions` and `--always-approve`
  (0.2.93) — `bypassPermissions` is the documented form.

## Consequences

- Per-consumer differentiated skills become a first-class, hash-gated,
  privacy-guarded artifact type; `orchestrate` replaces the drive-codex /
  drive-claude pair (their hardened bodies become provider references).
- Deletion safety, prunes, and state shapes are reused as-is
  (`classifyRemoval`, `collectPrunes`, tree hashes); the new code is the
  renderer plus explicit dispatch arms in plan/apply/status/doctor —
  the diff/materialize path does NOT come free with the `rendered` kind,
  and claiming otherwise was a reviewed-and-corrected error.
- Rendered trees update only on `skm apply` (unlike symlinked skills);
  goldens (fixtures × consumer × posture-where-borne) pin the renderer.
- The sandboxed compile of `orchestrate` is exercised only by goldens on
  this fleet (every host runs yolo) — accepted rot risk, revisited if a
  sandboxed host appears.
- Cutover to `orchestrate` must be two-phase (`apply` then
  `apply --prune`): a refused create does not halt prunes, and a one-shot
  prune could otherwise leave a consumer with neither the old nor the new
  skill.
