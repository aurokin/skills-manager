# ADR 0015: Machine-local override roots disable an agent definition per host

- Status: accepted (documents shipped behavior)
- Date: 2026-07-14
- Depends on: [ADR 0001](0001-overlay-repo-architecture.md) (registered roots),
  [ADR 0005](0005-machine-registry-in-xdg-config.md) (machine config, no
  in-engine per-host layering),
  [ADR 0007](0007-agent-definitions-artifact-type.md) (agent definitions),
  [ADR 0013](0013-skm-review.md) (review console)

## Context

Agent definitions in `agents/` render for every enabled harness on every
synced machine. Sometimes one host should *not* run a definition the shared
repos ship — a reviewer agent that is noisy on a laptop, a definition whose
harness is misconfigured there. ADR 0005 keeps per-host layering out of the
engine: host variance is expressed by that machine's own registered roots, not
by conditionals inside a definition. So the disable must be a root-level fact,
not a new field on the shared definition.

## Decision

A **machine-local override root** — an ordinary registered root that exists
only on that host (e.g. `~/.config/skills-manager/local-root`, listed **last**
in the machine config) — may redefine an agent definition by name with an
`export: none` stub — a minimal but complete definition (`agents/<name>/agent.yaml` with `name`, `description`, `export: none`, plus a non-empty `instructions.md`; the loader rejects partial stubs).

Resolution is later-root-wins on name collision (ADR 0001). Because the
override root is registered last, its stub becomes the **effective** definition
on that host, and only that host — no shared repo changes, no other machine
affected. `export: none` produces no rendered output, so `apply --prune`
removes the definition's placements from that machine's harness dirs.

The review console (ADR 0013) renders the shadowed unit as **disabled** rather
than as an empty stub. In `cli/src/review/model.ts`, a definition whose
effective `exportMode === "none"` is marked `disabled: true`, carries
`["agent", "disabled"]` badges (rendered `agent · disabled`) and a generated
note (`Disabled on <machine>: root '<root>' overrides with export: none.`), and
the page draws it with a hollow provenance dot and an `OFF` tag. Crucially, the
model keeps the **shadowed definition's real instructions reviewable**: the
last shadowed root supplies the primary `Source (<root>)` variant, and the
override stub is surfaced as a secondary `override (<root>)` variant — so the
disabled-here definition is still fully readable, and the reason it is off is
explicit. This mirrors ADR 0011's principle: one portable intent, rendered
into structure the tools and the console can reason about, never smuggled as
prose.

## Consequences

- Disabling is host-scoped and reversible: drop the override root (or its stub)
  and the definition renders again on the next `apply`.
- No shared artifact carries host conditionals; the fact lives entirely in the
  machine config's root ordering (ADR 0005 stance preserved).
- The review console never shows a disabled unit as merely "missing" — the
  shadowed content stays reviewable and the OFF state is explained, so an empty
  harness dir reads as "disabled here," not "lost."
