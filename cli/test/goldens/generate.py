#!/usr/bin/env python3
"""Regenerate agent-definition golden files from the custom_agents oracle.

Goldens are the byte-exact output of the shared_agents *pure* render functions
(no file writes, no HOME access, no sync). They pin the target the TypeScript
dialect + emitter pipeline must reproduce (ADR 0009).

Deterministic and re-runnable: it reads the committed fixtures under
`fixtures/<name>/` (agent.yaml + instructions.md) and overwrites
`agent-defs/<name>/<harness>.golden`.

Usage: python3 cli/test/goldens/generate.py
"""

from __future__ import annotations

import sys
from pathlib import Path

# The oracle lives in the sibling custom_agents repo; import its pure builders
# directly instead of shelling out to any sync/CLI entry point.
CUSTOM_AGENTS_SRC = Path("/Users/auro/code/custom_agents/src")
sys.path.insert(0, str(CUSTOM_AGENTS_SRC))

from shared_agents.schema import load_agent_definition  # noqa: E402
from shared_agents.generators.claude import render_claude_agent  # noqa: E402
from shared_agents.generators.codex import render_codex_agent  # noqa: E402
from shared_agents.generators.copilot import render_copilot_agent  # noqa: E402
from shared_agents.generators.cursor import render_cursor_agent  # noqa: E402
from shared_agents.generators.opencode import render_opencode_agent  # noqa: E402
from shared_agents.generators.gemini import render_gemini_agent  # noqa: E402
from shared_agents.generators.skills import render_skill  # noqa: E402

HERE = Path(__file__).resolve().parent
FIXTURES_DIR = HERE / "fixtures"
GOLDENS_DIR = HERE / "agent-defs"

# harness keyword -> pure renderer (AgentDefinition -> str). Keys match
# shared_agents.harnesses.HARNESS_KEYWORDS.
AGENT_HARNESSES = {
    "claude": render_claude_agent,
    "codex": render_codex_agent,
    "copilot": render_copilot_agent,
    "cursor": render_cursor_agent,
    "opencode": render_opencode_agent,
    "gemini": render_gemini_agent,
}

# render_skill only branches on hermes metadata; claude-skills and agent-skills
# are byte-identical in the oracle today.
SKILL_HARNESSES = {
    "agent-skills": lambda agent: render_skill(agent),
    "claude-skills": lambda agent: render_skill(agent),
    "hermes-skills": lambda agent: render_skill(agent, include_hermes_metadata=True),
}

AGENT_FIXTURES = [
    "codexrabbit-code-reviewer",
    "plan-reviewer",
    "retrorabbit-code-reviewer",
    "kitchen-sink-pinned",
    "kitchen-sink-floating",
    "formatting-traps",
]

SKILL_FIXTURES = [
    "skill-export-demo",
]


def _write_golden(fixture: str, harness: str, content: str) -> None:
    out_dir = GOLDENS_DIR / fixture
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{harness}.golden").write_text(content, encoding="utf-8")


def main() -> None:
    written = 0
    for fixture, harnesses in (
        [(f, AGENT_HARNESSES) for f in AGENT_FIXTURES]
        + [(f, SKILL_HARNESSES) for f in SKILL_FIXTURES]
    ):
        agent = load_agent_definition(FIXTURES_DIR / fixture)
        for harness, render in harnesses.items():
            _write_golden(fixture, harness, render(agent))
            written += 1
    print(f"wrote {written} golden files under {GOLDENS_DIR}")


if __name__ == "__main__":
    main()
