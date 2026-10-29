# ADR 0012: Shared provider pools — multiple composed skills from one provider source

- Status: accepted
- Date: 2026-07-12
- Amends: [ADR 0010](0010-composed-skills-artifact-type.md) (source-layout and provider-set rules only; render, placement, and state are untouched)

## Context

ADR 0010 made composed skills a first-class artifact type, with one
skill (`orchestrate`) compiled per consumer from a single source. That
source conflates two things that turned out to be separable:

1. **Provider knowledge** — how to drive each coding-agent CLI headless
   (invocation forms, models, posture-specific bypass flags, failure
   modes). This must stay single-sourced; a second copy would drift.
2. **The trigger** — the moment a skill activates. Orchestrate's
   trigger is "I have work to route elsewhere." But one of its
   dimensions, the decision-point **consult** (the advisor pattern,
   private PRs #2/#3), has a different trigger: "I need judgment before
   proceeding." Live review found the consult contract effectively
   hidden — two files deep inside a skill named and described for
   offloading. The skill-selection problem a reader hits is the same
   one the model's skill list hits.

Extracting consult as its own composed skill fixes discoverability and,
thanks to only-referenced-provider inclusion, costs nearly nothing at
runtime (its rendered tree is the consult contract plus one provider
reference). What blocks it is purely structural: ADR 0010 defines the
provider set as "the filenames under `composed/<name>/providers/`", so
each composed skill owns its providers and two skills cannot share one
pool without copying files.

## Decision

### Shared pool directory

- New optional per-root dir `composed/_providers/<p>.md` — same file
  format as skill-local providers (frontmatter registry + reference
  body). The underscore name carries no `skill.yaml`, so the composed
  scanner already ignores it as a skill source; the loader learns to
  read it as the root's provider pool.
- Pools are per-root and do not merge across roots: a composed skill
  resolves providers from its own root's pool plus its own
  `providers/` dir only. (Cross-root sharing would couple overlay
  repos; nothing needs it.)

### Provider resolution

- For a given provider id, skill-local `providers/<p>.md` and the
  root's `_providers/<p>.md` are **mutually exclusive — both existing
  is a build error**, not shadowing. Per ADR 0010's authoring rule,
  consumer- or skill-relative material belongs in consumer files and
  the template, never in a provider body variant; silent shadowing
  would reintroduce exactly the drift the pool exists to prevent.
- A skill's **declared provider set** is no longer "filenames under
  `providers/`". It is derived: the union of provider ids named by the
  skill's dimension candidates, each of which must resolve (locally or
  in the pool) or the build fails. This keeps ADR 0010's
  no-parallel-registries principle — dimensions were already the
  authoritative statement of which providers a skill uses; the
  directory listing was only a proxy for it.
- Everything downstream of the declared set is unchanged and now
  per-skill: self-exclusion, the `selfProvider: none` guard,
  `{{provider_clis}}` expansion (all of *that skill's* declared
  providers), reference copying (only-referenced), and the empty-chain
  dimension drop.

### What does not change

- Render stays the pure function of ADR 0010; only source-path
  resolution feeds it differently. Placement shape, tree-hash content
  binding, plan/apply/status/doctor arms, and the privacy guard are
  untouched. No `STATE_VERSION` bump: state records placements, not
  source layout.
- Goldens gain fixtures for pool resolution, the local/pool collision
  error, and an unresolvable dimension candidate.

### Migration and worked example (private overlay)

1. Move `composed/orchestrate/providers/*.md` →
   `composed/_providers/`. Orchestrate's rendered bytes must not
   change (golden-verified); its declared set derives to the same
   three providers its dimensions already name.
2. Add `composed/consult/`: the consult dimension and contract move
   out of orchestrate; consumers are the agents that consult a
   stronger Claude model (codex first). claude-code is deliberately
   NOT a consult consumer — its single candidate is its own self, so
   the skill would render empty; its "use the native advisor tooling"
   line stays in orchestrate's consumer file.
3. Orchestrate drops the consult dimension. Both skills now compile
   from the same pool; the cutover is the standard two-phase
   `apply` then `apply --prune` (ADR 0010).

## Consequences

- Any future skill needing cross-harness knowledge (second-opinion
  review, delegated verification) references the pool instead of
  copying provider bodies — the drift surface stays a single set of
  files per root.
- One more entry in each consumer's skill list, which is the point:
  "consult at a decision point" gets its own name and trigger
  description instead of hiding behind "orchestrate".
- The declared-set derivation means a provider file in the pool that
  no skill's dimensions reference is dead content; doctor may warn on
  unreferenced pool providers (advice, not an error — a pool may
  legitimately stage a provider ahead of its first consumer).
- Deleting a composed skill never orphans shared knowledge (the pool
  outlives any one skill), at the cost that deleting the *last* skill
  in a root leaves the pool behind — acceptable; it is source, not a
  deployment.

## Background: the consult design

The consult contract this ADR extracts was designed and probed before the
split. Its content lives in the private overlay; the reasoning is kept here.

- **Contract.** A consult hands over a decision, not a task; the caller
  stays the owner. Triggers: committing to a consequential approach, the
  same error surviving a second distinct fix, and finishing work the
  caller cannot verify itself. The decision brief has four hard
  requirements: the situation; the options with the caller's leaning
  *and* the strongest case against it; verbatim evidence, never
  summarized; and one decision-shaped question that asks for a falsifier.
  Advice is evidence, not orders: the caller's own evidence wins and
  conflicts are surfaced.
- **Risks and mitigations.** Garbage-brief ratification (a caller curates
  evidence mid-mistake and a stronger model blesses the misframing) is
  countered by the mandatory counter-case field and the verbatim-evidence
  rule. Over-consulting (the decision-point trigger removes the user as a
  throttle, on the most expensive tier) is countered by one consult per
  decision, never a consult about a consult, plus an explicit
  do-not-consult list.
- **Native advisor.** claude-code has a native advisor that sees the full
  transcript, which a CLI consult cannot; it must never round-trip a
  consult through a provider CLI.
- **Advisor ≥ executor.** At design time the matrix was one cell (codex consults
  Claude opus, or fable for high stakes). If grok becomes a consumer, the
  advisor must be at least as capable as the executor; a peer model is a
  second opinion, not an advisor.
- **Decomposition rule.** A capability stays inside orchestrate while it
  is still "engage a provider CLI from within a task" through the same
  providers and safety gate (review panels, cost routing). It becomes a
  standalone skill only when both its trigger vocabulary and its
  infrastructure are disjoint (model benchmarking, probably). Split
  triggers: the description needs a third distinct intent clause,
  mis-activation is observed, or the body passes about 250 lines despite
  progressive disclosure. Precondition for any split: shared providers in
  skm first, which is this ADR.
- **Live probe facts (codex consulting Claude, July 2026).** A consult
  brief run to completion took 720 s, exit 0, so Claude runs need a timeout
  measured in minutes, not seconds. Claude writes stdout only at
  completion, so a killed run leaves both the report and stderr empty;
  empty report plus empty stderr means an infrastructure kill, never "no
  answer", and one retry after such a kill does not count against the
  one-consult cap. The completed run returned a 236-byte non-answer
  because opus spawned its own multi-agent workflow and replied before it
  finished; `--disallowedTools "Edit Write NotebookEdit Bash"` does not
  block that. Consult runs therefore add the spawner tools
  (`--disallowedTools "Edit Write NotebookEdit Bash Agent Workflow Task"`,
  which left the session no way to spawn a subagent) and the brief says to
  answer directly in a single pass.
