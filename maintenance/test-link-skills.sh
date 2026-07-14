#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LINK_SCRIPT="$REPO_DIR/link-skills.sh"
AGENTS_LIB="$REPO_DIR/lib/agents.sh"
TESTS_RUN=0

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

assert_not_exists() {
    local path="$1"
    if [ -e "$path" ] || [ -L "$path" ]; then
        fail "expected path to be absent: $path"
    fi
}

assert_symlink_target() {
    local path="$1"
    local expected="$2"
    if [ ! -L "$path" ]; then
        fail "expected symlink: $path"
    fi

    local actual
    actual="$(readlink "$path")"
    if [ "$actual" != "$expected" ]; then
        fail "expected $path -> $expected, got $actual"
    fi
}

assert_contains() {
    local file="$1"
    local needle="$2"
    if ! grep -Fq "$needle" "$file"; then
        echo "--- $file ---" >&2
        cat "$file" >&2
        echo "------------" >&2
        fail "expected to find: $needle"
    fi
}

setup_test_env() {
    TEST_ROOT="$(mktemp -d)"
    HOME="$TEST_ROOT/home"
    FIXTURE_REPO="$TEST_ROOT/repo"
    OUTPUT_FILE="$TEST_ROOT/output.txt"

    export HOME
    unset SKILLS_AGENTS

    mkdir -p "$HOME" "$FIXTURE_REPO/skills" "$FIXTURE_REPO/lib"
    cp "$LINK_SCRIPT" "$FIXTURE_REPO/link-skills.sh"
    cp "$AGENTS_LIB" "$FIXTURE_REPO/lib/agents.sh"
    chmod +x "$FIXTURE_REPO/link-skills.sh"
}

cleanup_test_env() {
    rm -rf "$TEST_ROOT"
}

create_skill_dir() {
    mkdir -p "$FIXTURE_REPO/skills/$1"
}

create_gated_skill_dir() {
    mkdir -p "$FIXTURE_REPO/skills/$1"
    cat > "$FIXTURE_REPO/skills/$1/SKILL.md" <<EOF
---
name: $1
description: Gated fixture skill.
disable-model-invocation:  true  # YAML-equivalent spacing + comment must still gate
---

Body content; a stray
disable-model-invocation: true
outside frontmatter must not matter elsewhere.
EOF
}

run_link() {
    (
        cd "$FIXTURE_REPO"
        ./link-skills.sh
    ) > "$OUTPUT_FILE" 2>&1
}

run_link_with_env() {
    (
        cd "$FIXTURE_REPO"
        env "$@" ./link-skills.sh
    ) > "$OUTPUT_FILE" 2>&1
}

run_test() {
    local test_name="$1"
    shift

    echo "TEST: $test_name"
    setup_test_env
    if ! "$@"; then
        cleanup_test_env
        fail "$test_name"
    fi
    cleanup_test_env
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "PASS: $test_name"
}

test_removes_stale_local_symlinks() {
    local target
    create_skill_dir "agents-md"
    mkdir -p "$HOME/.agents/skills" "$HOME/.claude/skills" "$TEST_ROOT/external"

    ln -s "$FIXTURE_REPO/skills/plan-reviewer/" "$HOME/.agents/skills/plan-reviewer"
    ln -s "$FIXTURE_REPO/skills/plan-reviewer/" "$HOME/.claude/skills/plan-reviewer"
    ln -s "$TEST_ROOT/external" "$HOME/.agents/skills/external-skill"

    run_link

    for target in "$HOME/.agents/skills/agents-md" "$HOME/.claude/skills/agents-md"; do
        assert_symlink_target "$target" "$FIXTURE_REPO/skills/agents-md/"
    done
    assert_not_exists "$HOME/.agents/skills/plan-reviewer"
    assert_not_exists "$HOME/.claude/skills/plan-reviewer"
    assert_symlink_target "$HOME/.agents/skills/external-skill" "$TEST_ROOT/external"
    assert_contains "$OUTPUT_FILE" "Removing stale local link: plan-reviewer from $HOME/.agents/skills"
    assert_contains "$OUTPUT_FILE" "Removing stale local link: plan-reviewer from $HOME/.claude/skills"
}

test_empty_skills_dir_cleans_without_creating_bogus_links() {
    mkdir -p "$HOME/.agents/skills" "$HOME/.claude/skills"
    ln -s "$FIXTURE_REPO/skills/plan-reviewer/" "$HOME/.agents/skills/plan-reviewer"
    ln -s "$FIXTURE_REPO/skills/plan-reviewer/" "$HOME/.claude/skills/plan-reviewer"

    run_link

    assert_not_exists "$HOME/.agents/skills/plan-reviewer"
    assert_not_exists "$HOME/.claude/skills/plan-reviewer"
}

test_default_does_not_create_hermes_target() {
    create_skill_dir "agents-md"
    mkdir -p "$HOME/.agents/skills" "$HOME/.claude/skills"

    run_link

    if [ -e "$HOME/.hermes/skills/agents-md" ] || [ -L "$HOME/.hermes/skills/agents-md" ]; then
        fail "expected ~/.hermes/skills/agents-md to be absent without hermes-agent opt-in"
    fi
}

test_hermes_opt_in_links_local_skills_into_hermes_dir() {
    create_skill_dir "agents-md"
    mkdir -p "$HOME/.agents/skills" "$HOME/.claude/skills" "$HOME/.hermes/skills"

    run_link_with_env SKILLS_AGENTS="codex opencode gemini-cli github-copilot claude-code hermes-agent"

    assert_symlink_target "$HOME/.hermes/skills/agents-md" "$FIXTURE_REPO/skills/agents-md/"
}

test_hermes_opt_in_removes_stale_local_symlink_from_hermes() {
    create_skill_dir "agents-md"
    mkdir -p "$HOME/.agents/skills" "$HOME/.claude/skills" "$HOME/.hermes/skills"
    ln -s "$FIXTURE_REPO/skills/old-skill/" "$HOME/.hermes/skills/old-skill"

    run_link_with_env SKILLS_AGENTS="codex opencode gemini-cli github-copilot claude-code hermes-agent"

    assert_not_exists "$HOME/.hermes/skills/old-skill"
    assert_contains "$OUTPUT_FILE" "Removing stale local link: old-skill from $HOME/.hermes/skills"
}

test_hermes_opt_in_leaves_hand_authored_real_dirs() {
    create_skill_dir "agents-md"
    mkdir -p "$HOME/.hermes/skills/hand-authored"
    echo "hello" > "$HOME/.hermes/skills/hand-authored/data.txt"

    run_link_with_env SKILLS_AGENTS="codex opencode gemini-cli github-copilot claude-code hermes-agent"

    if [ ! -f "$HOME/.hermes/skills/hand-authored/data.txt" ]; then
        fail "expected hand-authored real dir in ~/.hermes/skills to survive"
    fi
}

test_hermes_opt_in_leaves_foreign_target_symlinks() {
    create_skill_dir "agents-md"
    mkdir -p "$HOME/.hermes/skills" "$TEST_ROOT/external/foreign-skill"
    ln -s "$TEST_ROOT/external/foreign-skill" "$HOME/.hermes/skills/foreign-skill"

    run_link_with_env SKILLS_AGENTS="codex opencode gemini-cli github-copilot claude-code hermes-agent"

    assert_symlink_target "$HOME/.hermes/skills/foreign-skill" "$TEST_ROOT/external/foreign-skill"
}

test_gated_skill_not_linked_and_existing_link_removed() {
    create_skill_dir "agents-md"
    create_gated_skill_dir "gated-skill"
    mkdir -p "$HOME/.agents/skills" "$HOME/.claude/skills"
    ln -s "$FIXTURE_REPO/skills/gated-skill/" "$HOME/.agents/skills/gated-skill"
    ln -s "$FIXTURE_REPO/skills/gated-skill/" "$HOME/.claude/skills/gated-skill"

    run_link

    assert_symlink_target "$HOME/.agents/skills/agents-md" "$FIXTURE_REPO/skills/agents-md/"
    assert_not_exists "$HOME/.agents/skills/gated-skill"
    assert_not_exists "$HOME/.claude/skills/gated-skill"
    assert_contains "$OUTPUT_FILE" "Skipping gated skill (skm-placed): gated-skill"
    assert_contains "$OUTPUT_FILE" "Removing stale local link: gated-skill from $HOME/.agents/skills"
}

run_test "removes stale local symlinks" test_removes_stale_local_symlinks
run_test "gated skill is not linked and stale links are removed" test_gated_skill_not_linked_and_existing_link_removed
run_test "empty skills dir cleans without bogus links" test_empty_skills_dir_cleans_without_creating_bogus_links
run_test "default does not create ~/.hermes/skills target" test_default_does_not_create_hermes_target
run_test "hermes opt-in links local skills into ~/.hermes/skills" test_hermes_opt_in_links_local_skills_into_hermes_dir
run_test "hermes opt-in removes stale local symlink from ~/.hermes/skills" test_hermes_opt_in_removes_stale_local_symlink_from_hermes
run_test "hermes opt-in leaves hand-authored real dirs" test_hermes_opt_in_leaves_hand_authored_real_dirs
run_test "hermes opt-in leaves foreign-target symlinks" test_hermes_opt_in_leaves_foreign_target_symlinks

echo "PASSED: $TESTS_RUN test(s)"
