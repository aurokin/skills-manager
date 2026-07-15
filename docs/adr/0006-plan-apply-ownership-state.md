# ADR 0006: Plan/apply verbs with an ownership-tagged state file

- Status: accepted
- Date: 2026-07-10

## Context

Most syncs are performed by coding agents, not humans. An agent operating
unattended needs the tool to behave like Terraform, not a shell script:
reviewable plans, no surprise mutations, machine-readable everything.

The current engine derives "what we own" from a readlink-prefix heuristic
(symlinks pointing into this repo's `skills/`), plus a Hermes-specific
add-only carve-out. With multiple overlay repos, per-agent private dirs, and
rendered (non-symlink) first-party artifacts (ADR 0004), the heuristic no
longer identifies ownership.

## Decision

1. **Verbs:** `plan`, `apply`, `status`, `doctor`, and `explain` (later ADRs
   add `review`, `root`, `adopt`, `deploy`, and `upstream sync`).
   `plan` never mutates. `apply` accepts `--plan <file>` so what was
   reviewed is exactly what runs. All verbs support `--json`; TTY gets
   human-pretty output.
2. **Exit codes** follow the Terraform detailed-exitcode convention:
   `0` = clean / no changes, `1` = error, `2` = changes pending or drift.
3. **Ownership state file** at
   `~/.local/state/skills-manager/state.json`, recording every artifact the
   engine placed: skill name, source root, visibility, placement paths,
   kind (symlink / rendered file), and content hash for rendered artifacts.
4. **Managed deletion invariant:** `apply` only deletes artifacts the state
   file says it owns. Anything else on disk is reported as `foreign` by
   `status`/`doctor` and never touched. This generalizes the previous
   Hermes placements remain an explicit add-only policy. ADR 0014 later adds a
   separate, non-state ownership model for upstream global normalization.
5. **Drift model:** `status` computes a three-way diff — desired (catalog +
   overlays + local config) vs state (what we recorded) vs filesystem —
   classifying divergences as `missing`, `stale`, `modified`, `foreign`, or
   `unsafe` (a private skill found in a disallowed location).
6. **Audit log:** append-only JSONL at
   `~/.local/state/skills-manager/audit.jsonl` (timestamp, operator, verb,
   plan hash, change summary).

## Consequences

- Agents can run `plan --json`, branch on exit code, and `apply` the exact
  reviewed plan; humans get readable diffs by default.
- Stale removal is safe across N contributing repos because it is scoped to
  recorded ownership, not path heuristics.
- The state file can drift from disk (manual deletes, crashes); `doctor`
  owns reconciliation, and `apply` re-verifies preconditions before acting.
- A registered-but-missing overlay root aborts the run before any plan is
  produced (never interpret an absent repo as "delete all its skills").
