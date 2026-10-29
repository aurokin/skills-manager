# Backlog

Open work for skm that is not yet scheduled. Track new work here and in
GitHub issues. Former tracker keys are kept in parentheses as history.

## `skm upstream sync` removes placements skm owns (bug) (AUR-683)

`skm upstream sync` shells out to the `skills` CLI, whose stale-removal
phase deletes any agent-dir entry whose name matches a skill it considers
stale. That includes skm-owned placements whose names used to be upstream
skills (seen with `thermos`, `thermo-nuclear-review`,
`thermo-nuclear-code-quality-review`, `to-issues`, and on some hosts
`agents-md`, `fleet`, `split-to-prs`). During a July 2026 fleet rollout one
host lost 12 skm placements on every sync; on another the same removal
failed harmlessly ("No matching skills found"), so the outcome depends on
the `skills` lock state. This is not a port regression: the bash script
produced the same argv (parity goldens).

Workaround: always run `skm apply` after `skm upstream sync`; it recreates
the swept placements.

Proposed fix: add the names of skm-owned placements to the preserve set
that `preserveGlobalSkillNames` already feeds (`cli/src/upstream/verb.ts`
builds `preservedNames` only from `.skills.local.json` today, and
`buildSyncPlan` in `cli/src/upstream/sync.ts` keeps preserved names out of
the removals). Note the boundary in ADR 0014: the sync verb currently never
reads skm's `state.json`, so the fix must either read owned names
read-only or take them from the desired state. Alternatives: end the sync
with an internal reconcile pass, or at least warn loudly when owned
placements go missing after sync.

Acceptance: running `skm upstream sync` alone leaves `skm status` drift at
zero for skm-owned placements; a test covers a skm-owned name that is also
a formerly-upstream name.

## Support browse.sh as a skill source (idea) (AUR-353)

browse.sh is an npm CLI (`npm install -g browse`) with a catalog of 500+
web-automation skills that return JSON, `llms.txt` / `llms-full.txt`
indexes, local browser primitives, and optional Browserbase sessions. Its
skills are not `SKILL.md` prompt files, so this needs a design decision
before any code.

Open questions: distribution (a `skm` verb vs a documented prerequisite);
scope (vendor a few skills vs treat the catalog as a source); which agents
can actually drive a browser; how its JSON skills map onto the `SKILL.md`
model; and how to pin a version or catalog snapshot so syncs stay
declarative. The original issue was written against the retired bash
scripts (`install-repro-skills.sh`, `link-skills.sh`, `lib/agents.sh`);
restate it against `skm upstream sync`, `skm plan` / `skm apply`, and the
agent registry before starting.

Acceptance: a documented decision (install flow, scope, target agents);
the chosen mechanism implemented and tested; README covers usage; existing
upstream and local skill syncing does not regress.
