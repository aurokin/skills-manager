---
name: to-issues
description: Break a plan, spec, or PRD into independently-grabbable issues using tracer-bullet vertical slices, created blockers-first in the connected tracker. User-invoked - run when the user asks to break work down into issues.
disable-model-invocation: true
---

# To Issues

Break a plan into independently-grabbable issues using vertical slices (tracer bullets). Work from whatever is already in the conversation context; if the user passes a document, use it as the baseline.

## Draft vertical slices

Break the plan into **tracer bullet** issues. Each issue is a thin vertical slice that cuts through ALL integration layers end-to-end, NOT a horizontal slice of one layer.

Slices may be 'HITL' or 'AFK'. HITL slices require human interaction, such as an architectural decision or a design review. AFK slices can be implemented and merged without human interaction. Prefer AFK over HITL where possible.

<vertical-slice-rules>
- Each slice delivers a narrow but COMPLETE path through every layer (schema, API, UI, tests)
- A completed slice is demoable or verifiable on its own
- Prefer many thin slices over few thick ones
</vertical-slice-rules>

## Quiz the user

Present the proposed breakdown as a numbered list. For each slice, show its title, type (HITL/AFK), what it is blocked by, and which user stories it covers (if the source material has them).

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the dependency relationships correct?
- Should any slices be merged or split further?
- Are the correct slices marked as HITL and AFK?

Iterate until the user approves the breakdown.

## Create the issues

Create the approved issues in dependency order (blockers first) directly in the user's connected tracker (e.g. the Linear MCP), using the tracker's native blocking and parent relations so later issues reference real identifiers. If no tracker is connected, write numbered markdown files (`<n>_<title>.md`) to a directory the user names.

Each issue carries: **What to build** — a concise description of the end-to-end behavior, not layer-by-layer implementation; an acceptance-criteria checklist; and its blockers, or "None - can start immediately".

Upload expectations:

- The source plan/PRD becomes the milestone or project description.
- Strip relationship markup from issue bodies once relations are modeled natively in the tracker.
- Each issue must be self-sufficient: an agent reading the issue, its milestone, and its linked issues can plan the work without extra context.
