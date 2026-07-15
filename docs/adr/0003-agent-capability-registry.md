# ADR 0003: Agent capability registry drives placement; scoped skills bypass ~/.agents/skills

- Status: accepted
- Date: 2026-07-10

## Context

Agent-scoped skills (e.g. "drive Codex", visible to Claude Code but never to
Codex) are impossible through `~/.agents/skills`: Codex and Droid read that
shared directory directly, so presence there is visibility to them. Placement
must be computed per agent, which requires knowing, for each of the ~12
agents in use (codex, claude, gemini, antigravity, opencode, copilot,
cursor-cli, pi, grok, hermes, droid, aider): which directories it scans,
in what precedence, in what format, and whether it follows symlinks.

Today that knowledge is implicit (a hardcoded target-dir list plus Hermes
special-casing). The owner's diffwarden project demonstrates the pattern we
want: a typed per-agent capability registry.

## Decision

1. The engine owns a declarative **agent capability registry**
   (`registry/agents.json` in this repo) recording per agent: canonical id,
   global skill dir(s),
   whether it reads the shared `~/.agents/skills`, symlink support,
   frontmatter dialect (see ADR 0004), and skills-support status
   (`supported` / `none` / `unknown`).
2. Registry entries are **evidence-backed**: each entry cites its source
   (upstream source code under `~/code/upstream/<agent>`, official docs, or
   the vercel-labs `skills` CLI's own agent mapping) so entries can be
   re-verified when agents update. The researched matrix lives in the design
   doc and is normative for the initial registry.
3. **Placement rule:** a skill with no agent scoping keeps the cheap path
   (shared dir + existing per-agent symlinks). A skill with any
   allow/deny scoping is never placed in `~/.agents/skills`; it is
   materialized only into the private dirs of each allowed agent.
4. **Missing directories are created to the agent's standard.** If a scoped
   deploy targets an agent whose skill directory does not exist yet (e.g.
   Droid), the engine creates the directory the agent actually reads, per
   the registry's evidence — never an invented path. Agents with
   `skills-support: none` (e.g. aider, pending evidence) are reported as
   unreachable in the plan rather than silently skipped.

## Consequences

- "Hidden from agent X" becomes a checkable guarantee: `doctor` can verify
  no scoped skill resolves into a directory X reads.
- The registry is a maintenance surface — agents move their directories —
  but citations make refresh mechanical, and `doctor` can flag registry
  entries contradicted by observed disk layout.
- Scoped skills cost one placement per allowed agent instead of one shared
  placement; acceptable at this catalog's scale.
