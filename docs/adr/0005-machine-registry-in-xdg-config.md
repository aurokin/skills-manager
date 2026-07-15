# ADR 0005: Machine-local registry lives in ~/.config; no per-host layering in v1

- Status: accepted
- Date: 2026-07-10

## Context

The engine needs a machine-local registry that lists which overlay repos are
plugged in on this machine (and where they are checked out). Candidate
locations: an extended gitignored `.skills.local.json` inside this repo, or
an XDG config path outside any repo.

Separately: the owner runs a fleet of machines, which raises the question of
whether the scheme should natively model per-host configuration (machine
profiles, host-keyed skill sets).

The owner's dotfiles already handle host variance with simple per-host files
(`zsh/.zshrc.d/hosts/<hostname>.zsh`), and their position is that tools
should stay host-agnostic and let the user juggle the host layer.

## Decision

1. The machine-local registry lives at
   `~/.config/skills-manager/config.json` (XDG base dir honored via
   `XDG_CONFIG_HOME`). It does not live inside this repo: it is per-machine
   state about where repos are checked out, not catalog content, and keeping
   it outside the repo makes it dotfiles-manageable and robust to repo moves.
2. **No per-host layering in v1.** The engine has no hostname awareness, no
   machine profiles, no host-keyed includes. Host variance is expressed by
   what each machine's `~/.config/skills-manager/config.json` contains —
   which the user may or may not manage through dotfiles, per host, exactly
   as they do today for zsh.
3. The gitignored `.skills.local.json` quick-tweak file remains separate from
   machine config. ADR 0014 fixed its current role: it supplies validated
   upstream-sync and project-family overrides when present; it is not a root or
   agent-selection layer and is not scheduled to fold into XDG config.

Single-machine correctness must be fully proven before any multi-host
layering (profiles, fleet state mirroring) is considered; those ideas are
recorded in the design doc as explicitly deferred.

## Consequences

- Bootstrap on a new machine: clone repo(s), write one small config file (or
  let dotfiles place it), run sync.
- Different machines can register different overlays with zero engine
  support for hosts.
- If per-host needs outgrow this, the escape hatch is additive (a `machines`
  block in overlay manifests was sketched in the design exploration) and can
  ship later without breaking the v1 config shape.
