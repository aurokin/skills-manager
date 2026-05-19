#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILL_FILE="${1:-$REPO_DIR/skills/agents-md/SKILL.md}"
ERRORS=0

fail() {
    echo "FAIL: $1" >&2
    ERRORS=$((ERRORS + 1))
}

if [ ! -f "$SKILL_FILE" ]; then
    echo "FAIL: file not found: $SKILL_FILE" >&2
    exit 1
fi

if grep -Fqi "Commit Attribution" "$SKILL_FILE"; then
    fail "'Commit Attribution' still present"
fi

if grep -Fqi "Co-Authored-By" "$SKILL_FILE"; then
    fail "'Co-Authored-By' still present"
fi

LINE_COUNT="$(wc -l < "$SKILL_FILE" | tr -d ' ')"
if [ "$LINE_COUNT" -lt 80 ]; then
    fail "file too short ($LINE_COUNT lines); patch may have over-trimmed"
fi

for section in \
    "# Maintaining AGENTS.md" \
    "## Workflow" \
    "## File Setup" \
    "## Default Sections" \
    "## Package Manager" \
    "## Key Conventions" \
    "## Writing Rules" \
    "## External Reference Rules" \
    "## Anti-Patterns"
do
    if ! grep -Fq "$section" "$SKILL_FILE"; then
        fail "expected section missing: $section"
    fi
done

if ! head -n 1 "$SKILL_FILE" | grep -q '^---$'; then
    fail "YAML frontmatter opening delimiter missing"
fi

FRONTMATTER_DELIMS="$(grep -c '^---$' "$SKILL_FILE" || true)"
if [ "$FRONTMATTER_DELIMS" -lt 2 ]; then
    fail "YAML frontmatter delimiters missing or incomplete"
fi

FENCE_COUNT="$(grep -c '^```' "$SKILL_FILE" || true)"
if [ $((FENCE_COUNT % 2)) -ne 0 ]; then
    fail "unbalanced fenced code blocks ($FENCE_COUNT fences)"
fi

if [ "$ERRORS" -gt 0 ]; then
    echo "" >&2
    echo "FAILED: $ERRORS check(s) failed" >&2
    exit 1
fi

echo "PASSED: All checks passed ($LINE_COUNT lines)"
