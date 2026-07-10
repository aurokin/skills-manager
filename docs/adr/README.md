# Architecture Decision Records

Decisions for the skills-manager redesign (see
[../skills-manager-design.md](../skills-manager-design.md) for the integrated
design and the research behind these).

| # | Decision | Status |
|---|---|---|
| [0001](0001-overlay-repo-architecture.md) | Public repo is the engine; private repos are registered overlays | accepted |
| [0002](0002-typescript-engine.md) | Rewrite the sync engine in TypeScript | accepted |
| [0003](0003-agent-capability-registry.md) | Agent capability registry drives placement; scoped skills bypass `~/.agents/skills` | accepted |
| [0004](0004-first-party-frontmatter-rendering.md) | First-party agents (Claude, Codex, Copilot) get rendered per-agent frontmatter; shared dir leans Codex | accepted |
| [0005](0005-machine-registry-in-xdg-config.md) | Machine-local registry in `~/.config`; no per-host layering in v1 | accepted |
| [0006](0006-plan-apply-ownership-state.md) | Plan/apply verbs with an ownership-tagged state file | accepted |
| [0007](0007-agent-definitions-artifact-type.md) | Agent definitions become a second artifact type; custom_agents absorbed | accepted |
| [0008](0008-tprompt-export.md) | tprompt export as a generic prompt-export channel for agents and skills | accepted |
| [0009](0009-dialect-document-emitter-rendering.md) | Rendering is dialect → document AST → emitter; byte quirks live only in emitters | accepted |

Convention: new ADRs take the next number, one decision per file, statuses
`proposed → accepted → superseded by NNNN`.
