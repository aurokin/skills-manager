# ADR 0001: Public repo is the engine; private repos are registered overlays

- Status: accepted
- Date: 2026-07-10

## Context

Two feature requests forced an architecture decision:

1. **Agent-scoped skills.** Some skills must be visible to specific agents only
   (e.g. a "drive Codex" skill installed for Claude Code but never visible to
   Codex). The vercel-labs `skills` CLI canonicalizes installs into
   `~/.agents/skills`, which Codex and Droid read directly, so the shared
   directory cannot carry scoped skills.
2. **Private skills.** Non-public skills (fleet-of-machines details, private
   utilities) must live in a separate private repo while syncing through the
   same workflow as the public catalog.

Five architecture families were evaluated:

- **A. Nested private checkout** — private repo cloned inside this repo
  (gitignored). Smallest diff, but nested git repos are hazardous for agent
  operators and bootstrap is brittle.
- **B. Overlay repos** — this repo stays the engine; private repos are dumb
  data repos mirroring the layout, registered via machine-local config.
- **C. Standalone orchestrator over the `skills` CLI** — a thin second tool
  owning scoping/private placement. Structural split-brain: two installers
  own overlapping directories, and a stray `skills update` can undo scoping.
- **D. Greenfield store/lockfile tool** — nix-lite channels → resolver →
  lockfile → materializer. Cleanest model, but we take over upstream-fetch
  semantics the `skills` CLI currently maintains, and it is weeks of work.
- **E. GitOps private control-plane** — the private repo becomes the fleet
  control plane; public repo pinned as a source. Strongest privacy, but the
  public repo stops being self-sufficient for other users.

## Decision

Adopt **B: overlay repos**.

- This public repo remains the single engine and the public catalog.
- Private repos are data-only overlays mirroring the public artifact layout
  (`skills/`, `agents/`, `composed/`, plus an overlay manifest). The originally
  sketched overlay-level upstream specs remain parsed but unconsumed; ADR 0014
  keeps upstream sync/deploy inputs in the public catalog plus
  `.skills.local.json`.
- A machine-local registry outside any repo (see ADR 0005) lists registered
  overlay paths and their visibility (`public` / `private`).
- The engine composes all registered roots into one desired state and syncs
  in a single entrypoint.

Ideas deliberately borrowed from the rejected options:

- From E: overlays may pin the public repo revision they were tested against
  (`requiresPublic`), and machine state files may optionally be mirrored into
  the private repo for a git-native fleet audit trail.
- From D: config formats are designed as inputs to a resolver that emits an
  explicit plan, so a later graduation to a store/lockfile model does not
  require a config migration.

## Consequences

- One sync entrypoint covers public + private skills; a machine without the
  private checkout still syncs public skills (the engine must hard-abort on a
  registered-but-missing root rather than treating its links as stale).
- Stale-removal must become ownership-aware across multiple roots
  (see ADR 0006).
- The public repo stays useful to other people as-is; nothing private ever
  enters it.
- Overlay manifest schema becomes a public contract and needs versioning.
