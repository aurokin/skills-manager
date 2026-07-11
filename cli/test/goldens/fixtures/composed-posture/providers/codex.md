---
name: codex
cli: codex
models:
  gpt-5.5: { default: true }
verified: "codex 0.144.1, koopa, 2026-07-11"
---

# codex (GPT-5.5)

Run implementation in a worktree.
<!-- @posture sandboxed -->
Invoke with `codex exec` under the sandbox tier; confirm before full access.
<!-- @end -->
<!-- @posture yolo -->
Invoke with `codex exec --dangerously-bypass-approvals-and-sandbox`.
<!-- @end -->

Anti-recursion: never spawn {{provider_clis}}.
