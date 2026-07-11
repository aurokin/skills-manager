---
name: grok
cli: grok
models:
  grok-4.5: { default: true }
  grok-composer-2.5-fast: {}
verified: "grok 0.2.93, koopa, 2026-07-11"
---

# grok (grok-4.5)

Headless writes by default; the provider API is the data-egress path. Pass the
prompt via `--prompt-file`; use `--no-subagents` to hold anti-recursion.

Anti-recursion: a child must never spawn {{provider_clis}}.
