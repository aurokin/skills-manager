---
name: handoff
description: Write the current session's state to a Markdown file so another session or agent can pick up the work. User-invoked.
disable-model-invocation: true
---

Write a handoff so a fresh session, possibly a different agent, can continue this work without this conversation.

## Where

Write to `${TMPDIR:-/tmp}/handoffs/<repo-or-topic>-<YYYYMMDD-HHMM>.md` unless the user gave a path. Never write inside the checkout.

## What

Include only what the next session can't cheaply rediscover:

- **Goal**: what the user wants, plus constraints and preferences they stated.
- **State**: done, in progress, left. Repo, branch, uncommitted work, key files (absolute paths).
- **Decisions**: what was chosen, why, and what was ruled out.
- **Open questions**: unresolved items and blockers.
- **Next step**: the first concrete action.

Mark what was verified vs. assumed. Point to docs, diffs, or commits instead of copying them. Follow any extra instructions the user gave with the command.

## Then

Reply with the absolute path in a code block, and nothing else.
