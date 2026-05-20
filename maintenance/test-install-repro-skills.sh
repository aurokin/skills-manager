#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_SCRIPT="$REPO_DIR/install-repro-skills.sh"
GLOBAL_SPECS_FILE="$REPO_DIR/catalog/global-specs.txt"
MANIFEST_TEMPLATE="$REPO_DIR/upstream-coverage.json"
ORIGINAL_PATH="$PATH"
TESTS_RUN=0

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

assert_contains() {
    local file="$1"
    local needle="$2"
    if ! grep -Fq -- "$needle" "$file"; then
        echo "--- $file ---" >&2
        cat "$file" >&2
        echo "------------" >&2
        fail "expected to find: $needle"
    fi
}

assert_not_contains() {
    local file="$1"
    local needle="$2"
    if grep -Fq -- "$needle" "$file"; then
        echo "--- $file ---" >&2
        cat "$file" >&2
        echo "------------" >&2
        fail "expected not to find: $needle"
    fi
}

assert_line_order() {
    local file="$1"
    local first="$2"
    local second="$3"
    local first_line second_line

    first_line="$(grep -Fn -- "$first" "$file" | head -n 1 | cut -d: -f1 || true)"
    second_line="$(grep -Fn -- "$second" "$file" | head -n 1 | cut -d: -f1 || true)"

    if [ -z "$first_line" ] || [ -z "$second_line" ] || [ "$first_line" -ge "$second_line" ]; then
        echo "--- $file ---" >&2
        cat "$file" >&2
        echo "------------" >&2
        fail "expected '$first' to appear before '$second'"
    fi
}

assert_not_exists() {
    local path="$1"
    if [ -e "$path" ] || [ -L "$path" ]; then
        fail "expected path to be absent: $path"
    fi
}

assert_log_contains() {
    assert_contains "$LOG_FILE" "$1"
}

assert_log_not_contains() {
    assert_not_contains "$LOG_FILE" "$1"
}

assert_log_count() {
    local expected="$1"
    local pattern="$2"
    local count
    count="$(grep -Fc "$pattern" "$LOG_FILE" || true)"
    if [ "$count" -ne "$expected" ]; then
        echo "--- $LOG_FILE ---" >&2
        cat "$LOG_FILE" >&2
        echo "---------------" >&2
        fail "expected $expected log entries matching '$pattern', got $count"
    fi
}

list_spec_names() {
    python3 - "$GLOBAL_SPECS_FILE" "$MOCK_REPOS" <<'PY'
from pathlib import Path
import sys

specs_path = Path(sys.argv[1])
mock_repos_root = Path(sys.argv[2])

for line in specs_path.read_text().splitlines():
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    if "@" in line:
        print(line.rsplit("@", 1)[1])
        continue

    repo_root = mock_repos_root / line / "skills"
    for skill_file in sorted(repo_root.glob("*/SKILL.md")):
        skill_name = skill_file.parent.name
        in_frontmatter = False
        for raw_line in skill_file.read_text().splitlines():
            if raw_line == "---":
                if not in_frontmatter:
                    in_frontmatter = True
                    continue
                break
            if in_frontmatter and raw_line.startswith("name:"):
                skill_name = raw_line.split(":", 1)[1].strip().strip("\"'")
                break
        print(skill_name)
PY
}

count_spec_repos() {
    python3 - "$GLOBAL_SPECS_FILE" <<'PY'
from pathlib import Path
import sys

repos = set()
for line in Path(sys.argv[1]).read_text().splitlines():
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    repos.add(line.rsplit("@", 1)[0])

print(len(repos))
PY
}

create_mock_skill_file() {
    local repo_root="$1"
    local skill_name="$2"
    local skill_dir="$repo_root/skills/$skill_name"

    mkdir -p "$skill_dir"
    cat > "$skill_dir/SKILL.md" <<EOF
---
name: $skill_name
description: Mock skill for $skill_name
---
EOF
}

seed_default_mock_repos() {
    local agent_browser_root="$MOCK_REPOS/vercel-labs/agent-browser"
    local anthropics_skills_root="$MOCK_REPOS/anthropics/skills"
    local openai_skills_root="$MOCK_REPOS/openai/skills"
    local clawdis_root="$MOCK_REPOS/steipete/clawdis"
    local openclaw_root="$MOCK_REPOS/openclaw/openclaw"
    local agent_skills_root="$MOCK_REPOS/vercel-labs/agent-skills"
    local vercel_skills_root="$MOCK_REPOS/vercel-labs/skills"
    local raindrop_root="$MOCK_REPOS/dedene/raindrop-cli"
    local matt_root="$MOCK_REPOS/mattpocock/skills"
    local humanizer_root="$MOCK_REPOS/blader/humanizer"

    mkdir -p \
        "$agent_browser_root" \
        "$anthropics_skills_root" \
        "$openai_skills_root" \
        "$clawdis_root" \
        "$openclaw_root" \
        "$agent_skills_root" \
        "$vercel_skills_root" \
        "$raindrop_root" \
        "$matt_root" \
        "$humanizer_root"

    create_mock_skill_file "$anthropics_skills_root" "frontend-design"
    create_mock_skill_file "$anthropics_skills_root" "webapp-testing"

    create_mock_skill_file "$openai_skills_root" "openai-docs"
    create_mock_skill_file "$openai_skills_root" "pdf"
    create_mock_skill_file "$openai_skills_root" "screenshot"
    create_mock_skill_file "$openai_skills_root" "security-best-practices"
    create_mock_skill_file "$openai_skills_root" "skill-creator"
    create_mock_skill_file "$openai_skills_root" "spreadsheet"

    create_mock_skill_file "$clawdis_root" "github"
    create_mock_skill_file "$openclaw_root" "tmux"

    create_mock_skill_file "$agent_browser_root" "agent-browser"
    create_mock_skill_file "$agent_browser_root" "agentcore"
    create_mock_skill_file "$agent_browser_root" "dogfood"
    create_mock_skill_file "$agent_browser_root" "electron"
    create_mock_skill_file "$agent_browser_root" "slack"
    create_mock_skill_file "$agent_browser_root" "vercel-sandbox"

    create_mock_skill_file "$agent_skills_root" "vercel-composition-patterns"
    create_mock_skill_file "$agent_skills_root" "vercel-react-best-practices"
    create_mock_skill_file "$agent_skills_root" "vercel-react-native-skills"
    create_mock_skill_file "$agent_skills_root" "web-design-guidelines"

    create_mock_skill_file "$vercel_skills_root" "find-skills"
    create_mock_skill_file "$raindrop_root" "raindrop-cli"
    create_mock_skill_file "$matt_root" "grill-me"
    create_mock_skill_file "$humanizer_root" "humanizer"
}

write_fake_skills_cli() {
    cat > "$TEST_ROOT/bin/skills" <<'EOF'
#!/usr/bin/env bash

set -euo pipefail

state_file="${FAKE_SKILLS_STATE_FILE:?}"
log_file="${FAKE_SKILLS_LOG_FILE:?}"

touch "$state_file" "$log_file"

dedupe_state() {
    sort -u "$state_file" -o "$state_file"
}

cmd="${1:-}"
shift || true

case "$cmd" in
    list|ls)
        global=0
        json=0
        while [ "$#" -gt 0 ]; do
            case "$1" in
                -g|--global)
                    global=1
                    ;;
                --json)
                    json=1
                    ;;
            esac
            shift
        done
        if [ "$global" -ne 1 ] || [ "$json" -ne 1 ]; then
            echo "unsupported skills list invocation" >&2
            exit 1
        fi
        python3 - "$state_file" "$HOME" <<'PY'
import json
import sys
from pathlib import Path

state_path = Path(sys.argv[1])
home = sys.argv[2]
names = [line.strip() for line in state_path.read_text().splitlines() if line.strip()]
payload = [
    {
        "name": name,
        "path": f"{home}/.agents/skills/{name}",
        "scope": "global",
        "agents": ["Codex"],
    }
    for name in names
]
print(json.dumps(payload))
PY
        ;;
    update)
        echo "mock update"
        ;;
    remove)
        name=""
        agents=()
        while [ "$#" -gt 0 ]; do
            case "$1" in
                -g|--global|-y|--yes)
                    shift
                    ;;
                -a|--agent)
                    shift
                    while [ "$#" -gt 0 ] && [[ "$1" != -* ]]; do
                        agents+=("$1")
                        shift
                    done
                    ;;
                *)
                    name="$1"
                    shift
                    ;;
            esac
        done
        if [ -z "$name" ]; then
            echo "missing skill name for remove" >&2
            exit 1
        fi
        printf 'remove|%s|agents=%s\n' "$name" "${agents[*]}" >> "$log_file"
        grep -Fvx "$name" "$state_file" > "$state_file.tmp" || true
        mv "$state_file.tmp" "$state_file"
        ;;
    add)
        repo="${1:-}"
        shift || true
        if [ -z "$repo" ]; then
            echo "missing repo for add" >&2
            exit 1
        fi
        skills=()
        agents=()
        while [ "$#" -gt 0 ]; do
            case "$1" in
                -g|--global|-y|--yes)
                    shift
                    ;;
                -a|--agent)
                    shift
                    while [ "$#" -gt 0 ] && [[ "$1" != -* ]]; do
                        agents+=("$1")
                        shift
                    done
                    ;;
                -s|--skill)
                    shift
                    while [ "$#" -gt 0 ] && [[ "$1" != -* ]]; do
                        skills+=("$1")
                        shift
                    done
                    ;;
                *)
                    shift
                    ;;
            esac
        done
        if [ "${#skills[@]}" -eq 0 ]; then
            echo "missing skill list for add" >&2
            exit 1
        fi
        printf 'add|%s|%s|agents=%s\n' "$repo" "${skills[*]}" "${agents[*]}" >> "$log_file"
        for skill in "${skills[@]}"; do
            printf '%s\n' "$skill" >> "$state_file"
        done
        dedupe_state
        ;;
    *)
        echo "unsupported fake skills command: $cmd" >&2
        exit 1
        ;;
esac
EOF

    chmod +x "$TEST_ROOT/bin/skills"
}

write_fake_git_cli() {
    cat > "$TEST_ROOT/bin/git" <<'EOF'
#!/usr/bin/env bash

set -euo pipefail

log_file="${FAKE_GIT_LOG_FILE:?}"
mock_root="${FAKE_GIT_ROOT:?}"
fail_repos=" ${FAKE_GIT_FAIL_REPOS:-} "

printf 'git|%s\n' "$*" >> "$log_file"

if [ "${1:-}" != "clone" ]; then
    echo "unsupported fake git command" >&2
    exit 1
fi

shift
while [ "$#" -gt 0 ] && [[ "$1" == -* ]]; do
    if [ "$1" = "--depth" ]; then
        shift 2
    else
        shift
    fi
done

url="${1:-}"
dest="${2:-}"
if [ -z "$url" ] || [ -z "$dest" ]; then
    echo "unsupported fake git clone invocation" >&2
    exit 1
fi

repo="${url#https://github.com/}"
repo="${repo%.git}"

if [[ "$fail_repos" == *" $repo "* ]]; then
    exit 1
fi

src="$mock_root/$repo"
if [ ! -d "$src" ]; then
    echo "missing fake git repo: $repo" >&2
    exit 1
fi

mkdir -p "$dest"
cp -R "$src"/. "$dest"/
EOF

    chmod +x "$TEST_ROOT/bin/git"
}

setup_test_env() {
    TEST_ROOT="$(mktemp -d)"
    HOME="$TEST_ROOT/home"
    LOG_FILE="$TEST_ROOT/skills.log"
    GIT_LOG_FILE="$TEST_ROOT/git.log"
    STATE_FILE="$TEST_ROOT/skills-state.txt"
    OUTPUT_FILE="$TEST_ROOT/output.txt"
    MOCK_REPOS="$TEST_ROOT/mock-repos"

    export HOME
    export PATH="$TEST_ROOT/bin:$ORIGINAL_PATH"
    export FAKE_SKILLS_STATE_FILE="$STATE_FILE"
    export FAKE_SKILLS_LOG_FILE="$LOG_FILE"
    export FAKE_GIT_LOG_FILE="$GIT_LOG_FILE"
    export FAKE_GIT_ROOT="$MOCK_REPOS"
    export FAKE_GIT_FAIL_REPOS=""

    mkdir -p "$HOME" "$TEST_ROOT/bin" "$MOCK_REPOS"
    : > "$STATE_FILE"
    : > "$LOG_FILE"
    : > "$GIT_LOG_FILE"

    cp "$MANIFEST_TEMPLATE" "$TEST_ROOT/upstream-coverage.json"
    write_fake_skills_cli
    write_fake_git_cli
    seed_default_mock_repos
}

cleanup_test_env() {
    unset FAKE_GIT_FAIL_REPOS
    rm -rf "$TEST_ROOT"
}

run_sync() {
    (
        cd "$REPO_DIR"
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        UPSTREAM_COVERAGE_FILE="$TEST_ROOT/upstream-coverage.json" \
        "$INSTALL_SCRIPT"
    ) > "$OUTPUT_FILE" 2>&1
}

seed_state_with_all_specs() {
    list_spec_names | sort -u > "$STATE_FILE"
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

test_clean_noop() {
    seed_state_with_all_specs
    run_sync

    assert_contains "$OUTPUT_FILE" "No stale skills to remove."
    assert_contains "$OUTPUT_FILE" "WARN: Skipping upstream repo coverage audit because no coverage repos are configured"
    assert_contains "$OUTPUT_FILE" "No skills to add."
}

test_stale_removal_and_broken_symlinks() {
    seed_state_with_all_specs
    printf '%s\n' "rogue-skill" >> "$STATE_FILE"
    mkdir -p "$HOME/.agents/skills" "$HOME/.claude/skills"
    ln -s "$TEST_ROOT/does-not-exist" "$HOME/.agents/skills/broken-link"
    ln -s "$TEST_ROOT/does-not-exist" "$HOME/.claude/skills/broken-link"

    run_sync

    assert_contains "$OUTPUT_FILE" "Removing: rogue-skill"
    assert_log_contains "remove|rogue-skill"
    assert_not_exists "$HOME/.agents/skills/broken-link"
    assert_not_exists "$HOME/.claude/skills/broken-link"
}

test_drift_warning_nonfatal() {
    seed_state_with_all_specs
    cat > "$TEST_ROOT/upstream-coverage.json" <<'EOF'
{
  "repos": [
    {
      "repo": "vercel-labs/agent-skills",
      "ignored": []
    }
  ]
}
EOF
    create_mock_skill_file "$MOCK_REPOS/vercel-labs/agent-skills" "newly-added-skill"

    run_sync

    assert_contains "$OUTPUT_FILE" "WARN: Undeclared upstream skill(s) in vercel-labs/agent-skills: newly-added-skill"
    assert_contains "$OUTPUT_FILE" "Adding skills..."
    assert_contains "$OUTPUT_FILE" "No skills to add."
    assert_contains "$OUTPUT_FILE" "Done."
}

test_audit_clone_failure_nonfatal() {
    seed_state_with_all_specs
    cat > "$TEST_ROOT/upstream-coverage.json" <<'EOF'
{
  "repos": [
    {
      "repo": "acme/audit-only",
      "ignored": []
    }
  ]
}
EOF
    export FAKE_GIT_FAIL_REPOS="acme/audit-only"

    run_sync

    assert_contains "$OUTPUT_FILE" "WARN: Skipping upstream repo coverage audit for acme/audit-only"
    assert_contains "$OUTPUT_FILE" "Done."
}

test_layout_drift_warning_nonfatal() {
    seed_state_with_all_specs
    cat > "$TEST_ROOT/upstream-coverage.json" <<'EOF'
{
  "repos": [
    {
      "repo": "acme/audit-only",
      "ignored": []
    }
  ]
}
EOF
    create_mock_skill_file "$MOCK_REPOS/acme/audit-only" "example-skill"
    rm -rf "$MOCK_REPOS/acme/audit-only/skills"

    run_sync

    assert_contains "$OUTPUT_FILE" "WARN: No SKILL.md files found in acme/audit-only; repo layout may have changed"
    assert_contains "$OUTPUT_FILE" "WARN: Skipping upstream repo coverage audit for acme/audit-only"
    assert_contains "$OUTPUT_FILE" "Done."
}

test_batched_adds() {
    run_sync

    assert_log_count "$(count_spec_repos)" "add|"
    assert_log_count 1 "add|vercel-labs/agent-browser|"
    assert_log_contains "add|vercel-labs/agent-browser|agent-browser"
    assert_log_contains "add|openai/skills|openai-docs pdf screenshot security-best-practices skill-creator"
    assert_log_not_contains "add|expo/skills|"
    assert_log_not_contains "add|waynesutton/convexskills|"
}

test_invalid_global_spec_fails_fast() {
    local bad_specs_file="$TEST_ROOT/bad-global-specs.txt"
    cat > "$bad_specs_file" <<'EOF'
openai
EOF

    if (
        cd "$REPO_DIR"
        GLOBAL_SPECS_FILE="$bad_specs_file" \
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        UPSTREAM_COVERAGE_FILE="$TEST_ROOT/upstream-coverage.json" \
        "$INSTALL_SCRIPT"
    ) > "$OUTPUT_FILE" 2>&1; then
        fail "expected install script to reject malformed global specs"
    fi

    assert_contains "$OUTPUT_FILE" "Invalid skill spec in $bad_specs_file:1: openai"
    assert_log_not_contains "add|"
    assert_log_not_contains "remove|"
}

test_repo_wide_global_spec_expands_to_all_skills() {
    local wide_specs_file="$TEST_ROOT/wide-global-specs.txt"
    cat > "$wide_specs_file" <<'EOF'
vercel-labs/agent-browser
EOF

    run_sync_with_env GLOBAL_SPECS_FILE="$wide_specs_file"

    assert_contains "$OUTPUT_FILE" "No stale skills to remove."
    assert_log_count 1 "add|vercel-labs/agent-browser|"
    assert_log_contains "add|vercel-labs/agent-browser|agent-browser agentcore dogfood electron slack vercel-sandbox"
}

test_local_global_specs_are_preserved() {
    local local_config_file="$TEST_ROOT/.skills.local.json"
    cat > "$local_config_file" <<'EOF'
{
  "globalSpecs": [
    "expo/skills@building-native-ui"
  ]
}
EOF

    seed_state_with_all_specs
    printf '%s\n' "building-native-ui" >> "$STATE_FILE"

    run_sync_with_env LOCAL_SKILLS_CONFIG_FILE="$local_config_file"

    assert_not_contains "$OUTPUT_FILE" "Removing: building-native-ui"
    assert_log_not_contains "remove|building-native-ui"
    assert_log_not_contains "add|expo/skills|"
}

test_invalid_exclude_global_specs_schema_fails_fast() {
    local local_config_file="$TEST_ROOT/.skills.local.json"
    cat > "$local_config_file" <<'EOF'
{
  "excludeGlobalSpecs": {}
}
EOF

    if run_sync_with_env LOCAL_SKILLS_CONFIG_FILE="$local_config_file"; then
        fail "expected install script to reject invalid excludeGlobalSpecs schema"
    fi

    assert_contains "$OUTPUT_FILE" "Invalid local skills config in $local_config_file"
    assert_log_not_contains "add|"
    assert_log_not_contains "remove|"
}

test_preserved_global_skill_name_is_not_removed() {
    local local_config_file="$TEST_ROOT/.skills.local.json"
    cat > "$local_config_file" <<'EOF'
{
  "preserveGlobalSkillNames": [
    "handmade-playbook"
  ]
}
EOF

    seed_state_with_all_specs
    printf '%s\n' "handmade-playbook" >> "$STATE_FILE"

    run_sync_with_env LOCAL_SKILLS_CONFIG_FILE="$local_config_file"

    assert_contains "$OUTPUT_FILE" "Preserving manual skill: handmade-playbook"
    assert_log_not_contains "remove|handmade-playbook"
    assert_contains "$STATE_FILE" "handmade-playbook"
}

test_preserved_missing_global_skill_name_is_not_added() {
    local local_config_file="$TEST_ROOT/.skills.local.json"
    cat > "$local_config_file" <<'EOF'
{
  "preserveGlobalSkillNames": [
    "handmade-playbook"
  ]
}
EOF

    seed_state_with_all_specs

    run_sync_with_env LOCAL_SKILLS_CONFIG_FILE="$local_config_file"

    assert_not_contains "$OUTPUT_FILE" "Preserving manual skill: handmade-playbook"
    assert_log_not_contains "add|"
    assert_log_not_contains "remove|handmade-playbook"
    assert_not_contains "$STATE_FILE" "handmade-playbook"
}

test_preserve_global_skill_names_schema_fails_fast() {
    local local_config_file="$TEST_ROOT/.skills.local.json"
    cat > "$local_config_file" <<'EOF'
{
  "preserveGlobalSkillNames": {}
}
EOF

    if run_sync_with_env LOCAL_SKILLS_CONFIG_FILE="$local_config_file"; then
        fail "expected install script to reject invalid preserveGlobalSkillNames schema"
    fi

    assert_contains "$OUTPUT_FILE" "Invalid local skills config in $local_config_file"
    assert_log_not_contains "add|"
    assert_log_not_contains "remove|"
}

test_preserve_global_skill_names_entry_validation_fails_fast() {
    local local_config_file="$TEST_ROOT/.skills.local.json"
    cat > "$local_config_file" <<'EOF'
{
  "preserveGlobalSkillNames": [
    "owner/repo@not-a-name"
  ]
}
EOF

    if run_sync_with_env LOCAL_SKILLS_CONFIG_FILE="$local_config_file"; then
        fail "expected install script to reject invalid preserveGlobalSkillNames entry"
    fi

    assert_contains "$OUTPUT_FILE" "Invalid skill name in $local_config_file:preserveGlobalSkillNames[0]: owner/repo@not-a-name"
    assert_log_not_contains "add|"
    assert_log_not_contains "remove|"
}

test_preserve_global_skill_names_entries_must_be_strings() {
    local local_config_file="$TEST_ROOT/.skills.local.json"
    cat > "$local_config_file" <<'EOF'
{
  "preserveGlobalSkillNames": [
    123
  ]
}
EOF

    if run_sync_with_env LOCAL_SKILLS_CONFIG_FILE="$local_config_file"; then
        fail "expected install script to reject non-string preserveGlobalSkillNames entry"
    fi

    assert_contains "$OUTPUT_FILE" "Invalid local skills config in $local_config_file"
    assert_log_not_contains "add|"
    assert_log_not_contains "remove|"
}

test_repo_wide_global_include_supports_targeted_explicit_exclude() {
    local local_config_file="$TEST_ROOT/.skills.local.json"
    local wide_specs_file="$TEST_ROOT/wide-global-specs.txt"

    cat > "$wide_specs_file" <<'EOF'
vercel-labs/agent-browser
EOF

    cat > "$local_config_file" <<'EOF'
{
  "excludeGlobalSpecs": [
    "vercel-labs/agent-browser@slack"
  ]
}
EOF

    run_sync_with_env \
        GLOBAL_SPECS_FILE="$wide_specs_file" \
        LOCAL_SKILLS_CONFIG_FILE="$local_config_file" \
        SKILLS_AUDIT_REPO_COVERAGE=0

    assert_contains "$OUTPUT_FILE" "No stale skills to remove."
    assert_log_count 1 "add|vercel-labs/agent-browser|"
    assert_log_contains "add|vercel-labs/agent-browser|agent-browser agentcore dogfood electron vercel-sandbox"
    assert_log_not_contains "add|vercel-labs/agent-browser|agent-browser agentcore dogfood electron slack vercel-sandbox"
}

test_repo_wide_global_exclusion_removes_entire_repo() {
    local local_config_file="$TEST_ROOT/.skills.local.json"
    local wide_specs_file="$TEST_ROOT/wide-global-specs.txt"

    cat > "$wide_specs_file" <<'EOF'
vercel-labs/agent-browser
EOF

    cat > "$local_config_file" <<'EOF'
{
  "excludeGlobalSpecs": [
    "vercel-labs/agent-browser"
  ]
}
EOF

    printf '%s\n' \
        "agent-browser" \
        "agentcore" \
        "dogfood" \
        "electron" \
        "slack" \
        "vercel-sandbox" > "$STATE_FILE"

    run_sync_with_env \
        GLOBAL_SPECS_FILE="$wide_specs_file" \
        LOCAL_SKILLS_CONFIG_FILE="$local_config_file" \
        SKILLS_AUDIT_REPO_COVERAGE=0

    assert_contains "$OUTPUT_FILE" "Removing: agent-browser"
    assert_contains "$OUTPUT_FILE" "Removing: agentcore"
    assert_contains "$OUTPUT_FILE" "Removing: dogfood"
    assert_contains "$OUTPUT_FILE" "Removing: electron"
    assert_contains "$OUTPUT_FILE" "Removing: slack"
    assert_contains "$OUTPUT_FILE" "Removing: vercel-sandbox"
    assert_contains "$OUTPUT_FILE" "No skills to add."
    assert_contains "$OUTPUT_FILE" "Done."
    assert_log_contains "remove|agent-browser"
    assert_log_contains "remove|agentcore"
    assert_log_contains "remove|dogfood"
    assert_log_contains "remove|electron"
    assert_log_contains "remove|slack"
    assert_log_contains "remove|vercel-sandbox"
    assert_log_not_contains "add|"
}

test_repo_wide_global_exclusion_over_explicit_specs_skips_enumeration() {
    local narrow_specs_file="$TEST_ROOT/narrow-global-specs.txt"
    local local_config_file="$TEST_ROOT/.skills.local.json"

    cat > "$narrow_specs_file" <<'EOF'
openai/skills@pdf
openai/skills@screenshot
EOF

    cat > "$local_config_file" <<'EOF'
{
  "excludeGlobalSpecs": [
    "openai/skills"
  ]
}
EOF

    printf '%s\n' "pdf" "screenshot" > "$STATE_FILE"
    export FAKE_GIT_FAIL_REPOS="openai/skills"

    run_sync_with_env \
        GLOBAL_SPECS_FILE="$narrow_specs_file" \
        LOCAL_SKILLS_CONFIG_FILE="$local_config_file" \
        SKILLS_AUDIT_REPO_COVERAGE=0

    assert_contains "$OUTPUT_FILE" "Removing: pdf"
    assert_contains "$OUTPUT_FILE" "Removing: screenshot"
    assert_contains "$OUTPUT_FILE" "No skills to add."
    assert_contains "$OUTPUT_FILE" "Done."
    assert_log_contains "remove|pdf"
    assert_log_contains "remove|screenshot"
    assert_log_not_contains "add|"
    if [ -s "$GIT_LOG_FILE" ]; then
        echo "--- $GIT_LOG_FILE ---" >&2
        cat "$GIT_LOG_FILE" >&2
        echo "--------------------" >&2
        fail "expected repo-wide exclusion over explicit specs to skip git enumeration"
    fi
}

test_stale_repo_wide_global_exclusion_is_noop() {
    local narrow_specs_file="$TEST_ROOT/narrow-global-specs.txt"
    local local_config_file="$TEST_ROOT/.skills.local.json"
    local openai_skills_root="$MOCK_REPOS/openai/skills"

    mkdir -p "$openai_skills_root"
    create_mock_skill_file "$openai_skills_root" "pdf"

    cat > "$narrow_specs_file" <<'EOF'
openai/skills@pdf
EOF

    cat > "$local_config_file" <<'EOF'
{
  "excludeGlobalSpecs": [
    "typo/repo"
  ]
}
EOF

    printf '%s\n' "pdf" > "$STATE_FILE"

    run_sync_with_env \
        GLOBAL_SPECS_FILE="$narrow_specs_file" \
        LOCAL_SKILLS_CONFIG_FILE="$local_config_file" \
        SKILLS_AUDIT_REPO_COVERAGE=0

    assert_contains "$OUTPUT_FILE" "No stale skills to remove."
    assert_contains "$OUTPUT_FILE" "No skills to add."
    assert_contains "$OUTPUT_FILE" "Done."
    assert_log_not_contains "add|"
    assert_log_not_contains "remove|"
    if [ "$(grep -Fc "git|clone --depth 1 https://github.com/openai/skills.git" "$GIT_LOG_FILE")" -ne 1 ]; then
        echo "--- $GIT_LOG_FILE ---" >&2
        cat "$GIT_LOG_FILE" >&2
        echo "--------------------" >&2
        fail "expected exact summary to enumerate openai/skills once"
    fi
}

test_repo_wide_global_expansion_reuses_upstream_enumeration() {
    local wide_specs_file="$TEST_ROOT/wide-global-specs.txt"

    cat > "$wide_specs_file" <<'EOF'
vercel-labs/agent-browser
EOF

    cat > "$TEST_ROOT/upstream-coverage.json" <<'EOF'
{
  "repos": [
    {
      "repo": "vercel-labs/agent-browser",
      "ignored": []
    }
  ]
}
EOF

    run_sync_with_env GLOBAL_SPECS_FILE="$wide_specs_file"

    if [ "$(grep -Fc "git|clone --depth 1 https://github.com/vercel-labs/agent-browser.git" "$GIT_LOG_FILE")" -ne 1 ]; then
        echo "--- $GIT_LOG_FILE ---" >&2
        cat "$GIT_LOG_FILE" >&2
        echo "--------------------" >&2
        fail "expected repo-wide normalization and coverage audit to reuse one upstream clone"
    fi
}

test_resolved_global_summary_is_sorted_and_marks_full_coverage() {
    local summary_specs_file="$TEST_ROOT/summary-global-specs.txt"
    local openai_skills_root="$MOCK_REPOS/openai/skills"

    mkdir -p "$openai_skills_root"
    create_mock_skill_file "$openai_skills_root" "pdf"

    cat > "$summary_specs_file" <<'EOF'
vercel-labs/agent-browser
openai/skills@pdf
EOF

    run_sync_with_env \
        GLOBAL_SPECS_FILE="$summary_specs_file" \
        SKILLS_AUDIT_REPO_COVERAGE=0

    assert_contains "$OUTPUT_FILE" "Resolved global skill summary:"
    assert_contains "$OUTPUT_FILE" "  openai/skills: pdf"
    assert_contains "$OUTPUT_FILE" "  vercel-labs/agent-browser^: agent-browser agentcore dogfood electron slack vercel-sandbox"
    assert_contains "$OUTPUT_FILE" "  ^ full upstream coverage for this repo"
    assert_line_order \
        "$OUTPUT_FILE" \
        "  openai/skills: pdf" \
        "  vercel-labs/agent-browser^: agent-browser agentcore dogfood electron slack vercel-sandbox"
}

test_explicit_global_summary_marks_full_coverage() {
    local summary_specs_file="$TEST_ROOT/explicit-summary-global-specs.txt"
    local explicit_repo_root="$MOCK_REPOS/acme/pdf-tools"

    mkdir -p "$explicit_repo_root"
    create_mock_skill_file "$explicit_repo_root" "pdf"

    cat > "$summary_specs_file" <<'EOF'
acme/pdf-tools@pdf
EOF

    run_sync_with_env \
        GLOBAL_SPECS_FILE="$summary_specs_file" \
        SKILLS_AUDIT_REPO_COVERAGE=0

    assert_contains "$OUTPUT_FILE" "Resolved global skill summary:"
    assert_contains "$OUTPUT_FILE" "  acme/pdf-tools^: pdf"
    assert_contains "$OUTPUT_FILE" "  ^ full upstream coverage for this repo"
}

test_summary_failure_happens_before_mutation() {
    local summary_specs_file="$TEST_ROOT/failing-summary-global-specs.txt"

    cat > "$summary_specs_file" <<'EOF'
acme/pdf-tools@pdf
EOF

    printf '%s\n' "rogue-skill" > "$STATE_FILE"
    export FAKE_GIT_FAIL_REPOS="acme/pdf-tools"

    if run_sync_with_env \
        GLOBAL_SPECS_FILE="$summary_specs_file" \
        SKILLS_AUDIT_REPO_COVERAGE=0; then
        fail "expected explicit-only summary failure to abort sync"
    fi

    assert_contains "$OUTPUT_FILE" "Failed to resolve full-coverage marker for repo: acme/pdf-tools"
    assert_not_contains "$OUTPUT_FILE" "Checking for stale skills..."
    assert_not_contains "$OUTPUT_FILE" "Updating existing skills..."
    assert_contains "$STATE_FILE" "rogue-skill"
    assert_log_not_contains "remove|"
    assert_log_not_contains "add|"
}

test_global_exclusion_removes_curated_skill_as_stale() {
    local local_config_file="$TEST_ROOT/.skills.local.json"
    cat > "$local_config_file" <<'EOF'
{
  "excludeGlobalSpecs": [
    "openai/skills@pdf"
  ]
}
EOF

    seed_state_with_all_specs

    run_sync_with_env LOCAL_SKILLS_CONFIG_FILE="$local_config_file"

    assert_contains "$OUTPUT_FILE" "Removing: pdf"
    assert_log_contains "remove|pdf"
    assert_log_not_contains "add|openai/skills|"
}

test_global_exclusion_removes_locally_added_spec() {
    local local_config_file="$TEST_ROOT/.skills.local.json"
    cat > "$local_config_file" <<'EOF'
{
  "globalSpecs": [
    "expo/skills@building-native-ui"
  ],
  "excludeGlobalSpecs": [
    "expo/skills@building-native-ui"
  ]
}
EOF

    seed_state_with_all_specs
    printf '%s\n' "building-native-ui" >> "$STATE_FILE"

    run_sync_with_env LOCAL_SKILLS_CONFIG_FILE="$local_config_file"

    assert_contains "$OUTPUT_FILE" "Removing: building-native-ui"
    assert_log_contains "remove|building-native-ui"
    assert_log_not_contains "add|expo/skills|"
}

test_unknown_global_exclusion_is_noop() {
    local local_config_file="$TEST_ROOT/.skills.local.json"
    cat > "$local_config_file" <<'EOF'
{
  "excludeGlobalSpecs": [
    "openai/skills@does-not-exist"
  ]
}
EOF

    seed_state_with_all_specs

    run_sync_with_env LOCAL_SKILLS_CONFIG_FILE="$local_config_file"

    assert_contains "$OUTPUT_FILE" "No stale skills to remove."
    assert_log_not_contains "remove|"
    assert_log_not_contains "add|"
}

test_excluded_skill_is_ignored_in_repo_coverage_audit() {
    local local_config_file="$TEST_ROOT/.skills.local.json"
    cat > "$local_config_file" <<'EOF'
{
  "globalSpecs": [
    "vercel-labs/agent-browser"
  ],
  "excludeGlobalSpecs": [
    "vercel-labs/agent-browser@slack"
  ]
}
EOF

    cat > "$TEST_ROOT/upstream-coverage.json" <<'EOF'
{
  "repos": [
    {
      "repo": "vercel-labs/agent-browser",
      "ignored": []
    }
  ]
}
EOF

    seed_state_with_all_specs
    printf '%s\n' "slack" >> "$STATE_FILE"

    run_sync_with_env LOCAL_SKILLS_CONFIG_FILE="$local_config_file"

    assert_contains "$OUTPUT_FILE" "Auditing full-coverage upstream repos..."
    assert_contains "$OUTPUT_FILE" "Removing: slack"
    assert_log_contains "remove|slack"
    assert_not_contains "$OUTPUT_FILE" "WARN: Undeclared upstream skill(s) in vercel-labs/agent-browser:"
    assert_not_contains "$OUTPUT_FILE" "WARN: Skipping upstream repo coverage audit because no coverage repos are configured"
}

test_excluded_missing_skill_is_ignored_in_repo_coverage_audit() {
    local local_config_file="$TEST_ROOT/.skills.local.json"
    cat > "$local_config_file" <<'EOF'
{
  "globalSpecs": [
    "vercel-labs/agent-browser"
  ],
  "excludeGlobalSpecs": [
    "vercel-labs/agent-browser@slack"
  ]
}
EOF

    cat > "$TEST_ROOT/upstream-coverage.json" <<'EOF'
{
  "repos": [
    {
      "repo": "vercel-labs/agent-browser",
      "ignored": []
    }
  ]
}
EOF

    seed_state_with_all_specs
    printf '%s\n' "slack" >> "$STATE_FILE"
    rm -rf "$MOCK_REPOS/vercel-labs/agent-browser/skills/slack"

    run_sync_with_env LOCAL_SKILLS_CONFIG_FILE="$local_config_file"

    assert_contains "$OUTPUT_FILE" "Auditing full-coverage upstream repos..."
    assert_contains "$OUTPUT_FILE" "Removing: slack"
    assert_log_contains "remove|slack"
    assert_not_contains "$OUTPUT_FILE" "WARN: Declared skill(s) no longer found in vercel-labs/agent-browser:"
    assert_not_contains "$OUTPUT_FILE" "WARN: Undeclared upstream skill(s) in vercel-labs/agent-browser:"
    assert_not_contains "$OUTPUT_FILE" "WARN: Skipping upstream repo coverage audit because no coverage repos are configured"
}

test_empty_result_sync_is_valid() {
    local narrow_specs_file="$TEST_ROOT/narrow-global-specs.txt"
    local local_config_file="$TEST_ROOT/.skills.local.json"

    cat > "$narrow_specs_file" <<'EOF'
openai/skills@pdf
EOF

    cat > "$local_config_file" <<'EOF'
{
  "excludeGlobalSpecs": [
    "openai/skills@pdf"
  ]
}
EOF

    printf '%s\n' "pdf" > "$STATE_FILE"

    run_sync_with_env \
        GLOBAL_SPECS_FILE="$narrow_specs_file" \
        LOCAL_SKILLS_CONFIG_FILE="$local_config_file" \
        SKILLS_AUDIT_REPO_COVERAGE=0

    assert_contains "$OUTPUT_FILE" "Removing: pdf"
    assert_contains "$OUTPUT_FILE" "Resolved global skill summary:"
    assert_contains "$OUTPUT_FILE" "  (none)"
    assert_contains "$OUTPUT_FILE" "  ^ full upstream coverage for this repo"
    assert_contains "$OUTPUT_FILE" "No skills to add."
    assert_contains "$OUTPUT_FILE" "Done."
    assert_log_contains "remove|pdf"
    assert_log_not_contains "add|"
}

run_sync_with_env() {
    (
        cd "$REPO_DIR"
        env \
            SKILLS_BIN="$TEST_ROOT/bin/skills" \
            UPSTREAM_COVERAGE_FILE="$TEST_ROOT/upstream-coverage.json" \
            "$@" \
            "$INSTALL_SCRIPT"
    ) > "$OUTPUT_FILE" 2>&1
}

test_default_agents_passed_on_add() {
    run_sync

    assert_log_contains "agents=codex opencode gemini-cli github-copilot claude-code"
    assert_log_not_contains "hermes-agent"
}

test_default_does_not_touch_hermes_dir() {
    mkdir -p "$HOME/.hermes/skills"
    ln -s "$TEST_ROOT/does-not-exist" "$HOME/.hermes/skills/broken-ours-style"

    run_sync

    if [ ! -L "$HOME/.hermes/skills/broken-ours-style" ]; then
        fail "expected ~/.hermes/skills to be untouched without hermes-agent opt-in"
    fi
}

test_hermes_opt_in_includes_agent_on_add() {
    run_sync_with_env SKILLS_AGENTS="codex opencode gemini-cli github-copilot claude-code hermes-agent"

    assert_log_contains "agents=codex opencode gemini-cli github-copilot claude-code hermes-agent"
}

test_hermes_opt_in_scopes_remove_to_non_hermes() {
    seed_state_with_all_specs
    printf '%s\n' "rogue-skill" >> "$STATE_FILE"

    run_sync_with_env SKILLS_AGENTS="codex opencode gemini-cli github-copilot claude-code hermes-agent"

    assert_log_contains "remove|rogue-skill|agents=codex opencode gemini-cli github-copilot claude-code"
    assert_log_not_contains "remove|rogue-skill|agents=codex opencode gemini-cli github-copilot claude-code hermes-agent"
}

test_hermes_opt_in_sweeps_ours_broken_symlinks() {
    mkdir -p "$HOME/.hermes/skills"
    local hermes_dir="$HOME/.hermes/skills"
    local repo_skill_path="$REPO_DIR/skills/does-not-exist-local"
    local agents_skill_path="$HOME/.agents/skills/does-not-exist-agents"
    local external_target="$TEST_ROOT/external"
    local real_dir="$hermes_dir/hermes-owned-real-dir"

    ln -s "$repo_skill_path" "$hermes_dir/dangling-local"
    ln -s "$agents_skill_path" "$hermes_dir/dangling-agents-abs"
    ln -s "../../.agents/skills/does-not-exist-rel" "$hermes_dir/dangling-agents-rel"
    ln -s "$external_target" "$hermes_dir/dangling-foreign"
    mkdir -p "$real_dir"

    run_sync_with_env SKILLS_AGENTS="codex opencode gemini-cli github-copilot claude-code hermes-agent"

    assert_not_exists "$hermes_dir/dangling-local"
    assert_not_exists "$hermes_dir/dangling-agents-abs"
    assert_not_exists "$hermes_dir/dangling-agents-rel"
    if [ ! -L "$hermes_dir/dangling-foreign" ]; then
        fail "expected foreign-target dangling symlink to survive Hermes ours-sweep"
    fi
    if [ ! -d "$real_dir" ]; then
        fail "expected hand-authored real dir to survive Hermes ours-sweep"
    fi
}

test_hermes_only_mode_skips_stale_removal() {
    seed_state_with_all_specs
    printf '%s\n' "rogue-skill" >> "$STATE_FILE"

    run_sync_with_env SKILLS_AGENTS="hermes-agent"

    assert_contains "$OUTPUT_FILE" "Skipping stale-skill removal (Hermes-only mode"
    assert_log_not_contains "remove|"
}

test_hermes_only_mode_still_cleans_owned_broken_symlinks() {
    seed_state_with_all_specs
    mkdir -p "$HOME/.agents/skills" "$HOME/.claude/skills"
    ln -s "$TEST_ROOT/does-not-exist" "$HOME/.agents/skills/broken-link"
    ln -s "$TEST_ROOT/does-not-exist" "$HOME/.claude/skills/broken-link"

    run_sync_with_env SKILLS_AGENTS="hermes-agent"

    assert_not_exists "$HOME/.agents/skills/broken-link"
    assert_not_exists "$HOME/.claude/skills/broken-link"
}

run_test "clean noop" test_clean_noop
run_test "stale removal and broken symlinks" test_stale_removal_and_broken_symlinks
run_test "default passes standard agents on add" test_default_agents_passed_on_add
run_test "default does not touch ~/.hermes/skills" test_default_does_not_touch_hermes_dir
run_test "hermes opt-in includes hermes-agent on add" test_hermes_opt_in_includes_agent_on_add
run_test "hermes opt-in scopes remove to non-hermes" test_hermes_opt_in_scopes_remove_to_non_hermes
run_test "hermes opt-in sweeps ours broken symlinks" test_hermes_opt_in_sweeps_ours_broken_symlinks
run_test "hermes-only mode skips stale removal" test_hermes_only_mode_skips_stale_removal
run_test "hermes-only mode still cleans owned broken symlinks" test_hermes_only_mode_still_cleans_owned_broken_symlinks
run_test "drift warning is non-fatal" test_drift_warning_nonfatal
run_test "audit clone failure is non-fatal" test_audit_clone_failure_nonfatal
run_test "layout drift warning is non-fatal" test_layout_drift_warning_nonfatal
run_test "batched adds by repo" test_batched_adds
run_test "invalid global spec fails fast" test_invalid_global_spec_fails_fast
run_test "repo-wide global spec expands to all skills" test_repo_wide_global_spec_expands_to_all_skills
run_test "local global specs are preserved" test_local_global_specs_are_preserved
run_test "invalid excludeGlobalSpecs schema fails fast" test_invalid_exclude_global_specs_schema_fails_fast
run_test "preserved global skill name is not removed" test_preserved_global_skill_name_is_not_removed
run_test "preserved missing global skill name is not added" test_preserved_missing_global_skill_name_is_not_added
run_test "preserveGlobalSkillNames schema fails fast" test_preserve_global_skill_names_schema_fails_fast
run_test "preserveGlobalSkillNames entry validation fails fast" test_preserve_global_skill_names_entry_validation_fails_fast
run_test "preserveGlobalSkillNames entries must be strings" test_preserve_global_skill_names_entries_must_be_strings
run_test "repo-wide global include supports targeted explicit exclude" test_repo_wide_global_include_supports_targeted_explicit_exclude
run_test "repo-wide global exclusion removes entire repo" test_repo_wide_global_exclusion_removes_entire_repo
run_test "repo-wide global exclusion over explicit specs skips enumeration" test_repo_wide_global_exclusion_over_explicit_specs_skips_enumeration
run_test "stale repo-wide global exclusion is a no-op" test_stale_repo_wide_global_exclusion_is_noop
run_test "repo-wide global expansion reuses upstream enumeration" test_repo_wide_global_expansion_reuses_upstream_enumeration
run_test "resolved global summary is sorted and marks full coverage" test_resolved_global_summary_is_sorted_and_marks_full_coverage
run_test "explicit global summary marks full coverage" test_explicit_global_summary_marks_full_coverage
run_test "summary failure happens before mutation" test_summary_failure_happens_before_mutation
run_test "global exclusion removes curated skill as stale" test_global_exclusion_removes_curated_skill_as_stale
run_test "global exclusion removes locally added spec" test_global_exclusion_removes_locally_added_spec
run_test "unknown global exclusion is a no-op" test_unknown_global_exclusion_is_noop
run_test "excluded skill is ignored in repo coverage audit" test_excluded_skill_is_ignored_in_repo_coverage_audit
run_test "excluded missing skill is ignored in repo coverage audit" test_excluded_missing_skill_is_ignored_in_repo_coverage_audit
run_test "empty-result sync is valid" test_empty_result_sync_is_valid

echo "PASSED: $TESTS_RUN test(s)"
