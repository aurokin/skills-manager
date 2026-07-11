---
name: grok
cli: grok
models:
  grok-4.5: { default: true }
verified: "grok 0.2.93, koopa, 2026-07-11"
---

# grok (grok-4.5)

Prefer `--prompt-file`; the provider API is the data-egress path.
<!-- @posture sandboxed -->
`--sandbox read-only` is kernel-verified; use it for pure reads.
<!-- @end -->
<!-- @posture yolo -->
`--permission-mode bypassPermissions` for writes; the worktree contains you.
<!-- @end -->

Anti-recursion: never spawn {{provider_clis}}.
