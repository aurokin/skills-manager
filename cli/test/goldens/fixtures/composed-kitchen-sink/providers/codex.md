---
name: codex
cli: codex
models:
  gpt-5.5: { default: true }
verified: "codex 0.144.1, koopa, 2026-07-11"
---

# codex (GPT-5.5)

Drive the Codex CLI for bounded implementation and computer-use verification.
Run implementation in a worktree; state boundaries in the prompt for
computer-use runs.

Anti-recursion: a child must never spawn {{provider_clis}}.
