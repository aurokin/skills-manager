#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_SCRIPT="$REPO_DIR/deploy-project-skills.sh"
FAMILY_MANIFEST_TEMPLATE="$REPO_DIR/catalog/family-coverage.json"
ORIGINAL_PATH="$PATH"
SYSTEM_GIT="$(command -v git)"
SYSTEM_BASH="$(command -v bash)"
SYSTEM_DIRNAME="$(command -v dirname)"
SYSTEM_AWK="$(command -v awk)"
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

assert_log_contains() {
    assert_contains "$LOG_FILE" "$1"
}

assert_log_not_contains() {
    assert_not_contains "$LOG_FILE" "$1"
}

assert_git_log_not_contains() {
    assert_not_contains "$GIT_LOG_FILE" "$1"
}

write_fake_skills_cli() {
    cat > "$TEST_ROOT/bin/skills" <<'EOF'
#!/usr/bin/env bash

set -euo pipefail

log_file="${FAKE_SKILLS_LOG_FILE:?}"
cmd="${1:-}"
shift || true

join_by_space() {
    local first=1
    local item
    for item in "$@"; do
        if [ "$first" -eq 1 ]; then
            printf '%s' "$item"
            first=0
        else
            printf ' %s' "$item"
        fi
    done
}

case "$cmd" in
    add)
        repo="${1:-}"
        shift || true
        agents=()
        skills=()
        copy_mode=0
        yes_mode=0
        while [ "$#" -gt 0 ]; do
            case "$1" in
                --copy)
                    copy_mode=1
                    shift
                    ;;
                -y|--yes)
                    yes_mode=1
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

        printf 'pwd|%s\n' "$PWD" >> "$log_file"
        if [ "${#skills[@]}" -eq 0 ]; then
            skills=("<all>")
        fi

        printf 'add|%s|agents=%s|skills=%s|copy=%s|yes=%s\n' \
            "$repo" \
            "$(join_by_space "${agents[@]}")" \
            "$(join_by_space "${skills[@]}")" \
            "$copy_mode" \
            "$yes_mode" >> "$log_file"
        ;;
    *)
        echo "unsupported fake skills command: $cmd" >&2
        exit 1
        ;;
esac
EOF

    chmod +x "$TEST_ROOT/bin/skills"
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
    local expo_root="$MOCK_REPOS/expo/skills"
    local convex_root="$MOCK_REPOS/waynesutton/convexskills"
    local mattpocock_root="$MOCK_REPOS/mattpocock/skills"
    local mobile_root="$MOCK_REPOS/acme/mobile-skills"
    local vercel_root="$MOCK_REPOS/vercel-labs/agent-skills"
    local copilot_root="$MOCK_REPOS/github/awesome-copilot"
    local openai_root="$MOCK_REPOS/openai/skills"

    mkdir -p "$expo_root" "$convex_root" "$mattpocock_root" "$mobile_root" \
        "$vercel_root" "$copilot_root" "$openai_root"

    create_mock_skill_file "$expo_root" "building-native-ui"
    create_mock_skill_file "$expo_root" "expo-api-routes"
    create_mock_skill_file "$expo_root" "expo-cicd-workflows"
    create_mock_skill_file "$expo_root" "expo-deployment"
    create_mock_skill_file "$expo_root" "expo-dev-client"
    create_mock_skill_file "$expo_root" "expo-tailwind-setup"
    create_mock_skill_file "$expo_root" "native-data-fetching"
    create_mock_skill_file "$expo_root" "upgrading-expo"
    create_mock_skill_file "$expo_root" "use-dom"

    create_mock_skill_file "$convex_root" "avoid-feature-creep"
    create_mock_skill_file "$convex_root" "convex"
    create_mock_skill_file "$convex_root" "convex-agents"
    create_mock_skill_file "$convex_root" "convex-best-practices"
    create_mock_skill_file "$convex_root" "convex-component-authoring"
    create_mock_skill_file "$convex_root" "convex-cron-jobs"
    create_mock_skill_file "$convex_root" "convex-file-storage"
    create_mock_skill_file "$convex_root" "convex-functions"
    create_mock_skill_file "$convex_root" "convex-http-actions"
    create_mock_skill_file "$convex_root" "convex-migrations"
    create_mock_skill_file "$convex_root" "convex-realtime"
    create_mock_skill_file "$convex_root" "convex-schema-validator"
    create_mock_skill_file "$convex_root" "convex-security-audit"
    create_mock_skill_file "$convex_root" "convex-security-check"

    create_mock_skill_file "$mattpocock_root" "teach"
    create_mock_skill_file "$mattpocock_root" "scaffold-exercises"

    create_mock_skill_file "$vercel_root" "vercel-composition-patterns"
    create_mock_skill_file "$vercel_root" "vercel-react-best-practices"
    create_mock_skill_file "$vercel_root" "vercel-react-native-skills"

    create_mock_skill_file "$copilot_root" "github-actions-hardening"

    create_mock_skill_file "$openai_root" "security-best-practices"

    create_mock_skill_file "$mobile_root" "expo-internals"
    create_mock_skill_file "$mobile_root" "release-ops"
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
    TEST_ROOT="$(
        cd "$TEST_ROOT"
        pwd -P
    )"
    TEST_HOME="$TEST_ROOT/home"
    PROJECT_ROOT="$TEST_ROOT/project"
    NESTED_TARGET="$PROJECT_ROOT/apps/mobile"
    PLAIN_TARGET="$TEST_ROOT/plain-project"
    QUOTED_TILDE_TARGET="$TEST_HOME/quoted-target"
    INTERACTIVE_TILDE_TARGET="$TEST_HOME/interactive-target"
    MOCK_REPOS="$TEST_ROOT/mock-repos"
    LOG_FILE="$TEST_ROOT/skills.log"
    GIT_LOG_FILE="$TEST_ROOT/git.log"
    OUTPUT_FILE="$TEST_ROOT/output.txt"
    FAMILY_MANIFEST_FILE="$TEST_ROOT/family-coverage.json"

    export PATH="$TEST_ROOT/bin:$ORIGINAL_PATH"
    export FAKE_SKILLS_LOG_FILE="$LOG_FILE"
    export FAKE_GIT_LOG_FILE="$GIT_LOG_FILE"
    export FAKE_GIT_ROOT="$MOCK_REPOS"
    export FAKE_GIT_FAIL_REPOS=""
    export LOCAL_SKILLS_CONFIG_FILE="$TEST_ROOT/absent.skills.local.json"

    mkdir -p \
        "$TEST_ROOT/bin" \
        "$TEST_HOME" \
        "$NESTED_TARGET" \
        "$PLAIN_TARGET" \
        "$QUOTED_TILDE_TARGET" \
        "$INTERACTIVE_TILDE_TARGET" \
        "$MOCK_REPOS"
    : > "$LOG_FILE"
    : > "$GIT_LOG_FILE"
    cp "$FAMILY_MANIFEST_TEMPLATE" "$FAMILY_MANIFEST_FILE"
    write_fake_skills_cli
    write_fake_git_cli
    seed_default_mock_repos

    "$SYSTEM_GIT" init -q "$PROJECT_ROOT"
}

cleanup_test_env() {
    unset FAKE_GIT_FAIL_REPOS
    rm -rf "$TEST_ROOT"
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

test_list_families() {
    (
        cd "$REPO_DIR"
        SKILLS_BIN="$TEST_ROOT/bin/does-not-exist" \
        "$DEPLOY_SCRIPT" --list-families
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" $'expo\tExpo and React Native workflow skills'
    assert_contains "$OUTPUT_FILE" $'convex\tConvex platform and data layer skills'
    assert_contains "$OUTPUT_FILE" $'mattpocock-teaching\tMatt Pocock teaching and exercise-authoring skills'
}

test_list_families_skips_missing_spec_files() {
    local bad_catalog="$TEST_ROOT/bad-catalog"
    mkdir -p "$bad_catalog/families"
    cat > "$bad_catalog/families.tsv" <<'EOF'
expo	Expo and React Native workflow skills
ghost	Ghost family
EOF
    cat > "$bad_catalog/families/expo.txt" <<'EOF'
expo/skills@building-native-ui
EOF

    (
        cd "$REPO_DIR"
        SKILL_CATALOG_DIR="$bad_catalog" \
        SKILLS_BIN="$TEST_ROOT/bin/does-not-exist" \
        "$DEPLOY_SCRIPT" --list-families
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" $'expo\tExpo and React Native workflow skills'
    assert_not_contains "$OUTPUT_FILE" "ghost"
}

test_list_families_skips_malformed_spec_files() {
    local bad_catalog="$TEST_ROOT/bad-catalog"
    mkdir -p "$bad_catalog/families"
    cat > "$bad_catalog/families.tsv" <<'EOF'
expo	Expo and React Native workflow skills
broken	Broken family
EOF
    cat > "$bad_catalog/families/expo.txt" <<'EOF'
expo/skills@building-native-ui
EOF
    cat > "$bad_catalog/families/broken.txt" <<'EOF'
bad spec
EOF

    (
        cd "$REPO_DIR"
        SKILL_CATALOG_DIR="$bad_catalog" \
        SKILLS_BIN="$TEST_ROOT/bin/does-not-exist" \
        "$DEPLOY_SCRIPT" --list-families
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" $'expo\tExpo and React Native workflow skills'
    assert_not_contains "$OUTPUT_FILE" "broken"
}

test_help_without_dependencies() {
    (
        cd "$REPO_DIR"
        SKILLS_BIN="$TEST_ROOT/bin/does-not-exist" \
        "$DEPLOY_SCRIPT" --help
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" "Usage: ./deploy-project-skills.sh [options]"
    assert_contains "$OUTPUT_FILE" "--list-families"
    assert_contains "$OUTPUT_FILE" '`git` for upstream enumeration used by resolved summaries, full-coverage markers, repo-wide family expansion, and coverage audit'
}

test_missing_flag_values_fail_fast() {
    if (
        cd "$REPO_DIR"
        "$DEPLOY_SCRIPT" --target --yes
    ) > "$OUTPUT_FILE" 2>&1; then
        fail "expected --target without a value to fail"
    fi
    assert_contains "$OUTPUT_FILE" "Missing value for --target"

    if (
        cd "$REPO_DIR"
        "$DEPLOY_SCRIPT" --family --yes
    ) > "$OUTPUT_FILE" 2>&1; then
        fail "expected --family without a value to fail"
    fi
    assert_contains "$OUTPUT_FILE" "Missing value for --family"

    if (
        cd "$REPO_DIR"
        "$DEPLOY_SCRIPT" --agents --yes
    ) > "$OUTPUT_FILE" 2>&1; then
        fail "expected --agents without a value to fail"
    fi
    assert_contains "$OUTPUT_FILE" "Missing value for --agents"
}

test_noninteractive_deploy() {
    (
        cd "$REPO_DIR"
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        SKILLS_AUDIT_REPO_COVERAGE=0 \
        "$DEPLOY_SCRIPT" \
            --target "$NESTED_TARGET" \
            --family expo \
            --family convex \
            --agents "codex claude-code" \
            --yes
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" "Deploying skills to target directory: $NESTED_TARGET"
    assert_contains "$OUTPUT_FILE" "Families: expo convex"
    assert_log_contains "pwd|$NESTED_TARGET"
    assert_log_contains "add|expo/skills|agents=codex claude-code|skills=building-native-ui expo-api-routes expo-cicd-workflows expo-deployment expo-dev-client expo-tailwind-setup native-data-fetching upgrading-expo use-dom|copy=1|yes=1"
    assert_log_contains "add|waynesutton/convexskills|agents=codex claude-code|skills=convex convex-agents convex-best-practices convex-component-authoring convex-cron-jobs convex-file-storage convex-functions convex-http-actions convex-migrations convex-realtime convex-schema-validator convex-security-audit convex-security-check|copy=1|yes=1"
}

test_noninteractive_deploy_non_git_target() {
    (
        cd "$REPO_DIR"
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        SKILLS_AUDIT_REPO_COVERAGE=0 \
        "$DEPLOY_SCRIPT" \
            --target "$PLAIN_TARGET" \
            --family expo \
            --yes
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" "Deploying skills to target directory: $PLAIN_TARGET"
    assert_contains "$OUTPUT_FILE" "Families: expo"
    assert_log_contains "pwd|$PLAIN_TARGET"
    assert_log_contains "add|expo/skills|agents=codex opencode gemini-cli github-copilot claude-code|skills=building-native-ui expo-api-routes expo-cicd-workflows expo-deployment expo-dev-client expo-tailwind-setup native-data-fetching upgrading-expo use-dom|copy=1|yes=1"
    assert_log_not_contains "add|waynesutton/convexskills|"
}

test_noninteractive_deploy_expands_quoted_tilde_target() {
    (
        cd "$REPO_DIR"
        HOME="$TEST_HOME" \
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        SKILLS_AUDIT_REPO_COVERAGE=0 \
        "$DEPLOY_SCRIPT" \
            --target '~/quoted-target' \
            --family expo \
            --yes
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" "Deploying skills to target directory: $QUOTED_TILDE_TARGET"
    assert_log_contains "pwd|$QUOTED_TILDE_TARGET"
    assert_log_contains "add|expo/skills|agents=codex opencode gemini-cli github-copilot claude-code|skills=building-native-ui expo-api-routes expo-cicd-workflows expo-deployment expo-dev-client expo-tailwind-setup native-data-fetching upgrading-expo use-dom|copy=1|yes=1"
}

test_quoted_tilde_target_without_home_fails_cleanly() {
    if (
        cd "$REPO_DIR"
        env -u HOME "$DEPLOY_SCRIPT" \
            --target '~/quoted-target' \
            --family expo \
            --dry-run
    ) > "$OUTPUT_FILE" 2>&1; then
        fail "expected quoted tilde target without HOME to fail"
    fi

    assert_contains "$OUTPUT_FILE" "Cannot expand ~ in target path because HOME is not set; pass an absolute path or export HOME."
    assert_not_contains "$OUTPUT_FILE" "unbound variable"
}

test_interactive_deploy() {
    (
        cd "$REPO_DIR"
        printf '%s\n\nexpo\ny\n' "$PROJECT_ROOT" | \
            SKILLS_BIN="$TEST_ROOT/bin/skills" \
            SKILLS_AUDIT_REPO_COVERAGE=0 \
            "$DEPLOY_SCRIPT" --interactive
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" "Families: expo"
    assert_log_contains "add|expo/skills|agents=codex opencode gemini-cli github-copilot claude-code|skills=building-native-ui expo-api-routes expo-cicd-workflows expo-deployment expo-dev-client expo-tailwind-setup native-data-fetching upgrading-expo use-dom|copy=1|yes=1"
    assert_log_not_contains "add|waynesutton/convexskills|"
}

test_interactive_deploy_expands_tilde_target() {
    (
        cd "$REPO_DIR"
        printf '%s\n\nexpo\ny\n' '~/interactive-target' | \
            HOME="$TEST_HOME" \
            SKILLS_BIN="$TEST_ROOT/bin/skills" \
            SKILLS_AUDIT_REPO_COVERAGE=0 \
            "$DEPLOY_SCRIPT" --interactive
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" "Deploying skills to target directory: $INTERACTIVE_TILDE_TARGET"
    assert_contains "$OUTPUT_FILE" "Families: expo"
    assert_log_contains "pwd|$INTERACTIVE_TILDE_TARGET"
    assert_log_contains "add|expo/skills|agents=codex opencode gemini-cli github-copilot claude-code|skills=building-native-ui expo-api-routes expo-cicd-workflows expo-deployment expo-dev-client expo-tailwind-setup native-data-fetching upgrading-expo use-dom|copy=1|yes=1"
}

test_interactive_deploy_aborts_on_invalid_local_config() {
    local local_config_file="$TEST_ROOT/.skills.local.json"
    cat > "$local_config_file" <<'EOF'
{
  "customFamilies": []
}
EOF

    if (
        cd "$REPO_DIR"
        printf '%s\n\n' "$PROJECT_ROOT" | \
            LOCAL_SKILLS_CONFIG_FILE="$local_config_file" \
            SKILLS_BIN="$TEST_ROOT/bin/skills" \
            SKILLS_AUDIT_REPO_COVERAGE=0 \
            "$DEPLOY_SCRIPT" --interactive
    ) > "$OUTPUT_FILE" 2>&1; then
        fail "expected interactive deploy to abort on invalid local config"
    fi

    assert_contains "$OUTPUT_FILE" "Invalid local skills config in $local_config_file"
    assert_not_contains "$OUTPUT_FILE" "Select at least one family with --family or --all-families"
    assert_log_not_contains "add|"
}

test_noninteractive_custom_family_reports_invalid_local_config() {
    local local_config_file="$TEST_ROOT/.skills.local.json"
    cat > "$local_config_file" <<'EOF'
{
  "customFamilies": []
}
EOF

    if (
        cd "$REPO_DIR"
        LOCAL_SKILLS_CONFIG_FILE="$local_config_file" \
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        SKILLS_AUDIT_REPO_COVERAGE=0 \
        "$DEPLOY_SCRIPT" \
            --target "$PLAIN_TARGET" \
            --family acme-mobile \
            --yes
    ) > "$OUTPUT_FILE" 2>&1; then
        fail "expected non-interactive deploy to abort on invalid local config"
    fi

    assert_contains "$OUTPUT_FILE" "Invalid local skills config in $local_config_file"
    assert_not_contains "$OUTPUT_FILE" "Unknown family: acme-mobile"
    assert_log_not_contains "add|"
}

test_interactive_family_selection_reports_invalid_local_config() {
    local local_config_file="$TEST_ROOT/.skills.local.json"
    cat > "$local_config_file" <<'EOF'
{
  "customFamilies": []
}
EOF

    if (
        cd "$REPO_DIR"
        printf '%s\n\nacme-mobile\n' "$PROJECT_ROOT" | \
            LOCAL_SKILLS_CONFIG_FILE="$local_config_file" \
            SKILLS_BIN="$TEST_ROOT/bin/skills" \
            SKILLS_AUDIT_REPO_COVERAGE=0 \
            "$DEPLOY_SCRIPT" --interactive
    ) > "$OUTPUT_FILE" 2>&1; then
        fail "expected interactive family selection to abort on invalid local config"
    fi

    assert_contains "$OUTPUT_FILE" "Invalid local skills config in $local_config_file"
    assert_not_contains "$OUTPUT_FILE" "Unknown family: acme-mobile"
    assert_log_not_contains "add|"
}

test_all_families_deploy() {
    (
        cd "$REPO_DIR"
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        SKILLS_AUDIT_REPO_COVERAGE=0 \
        "$DEPLOY_SCRIPT" \
            --target "$PLAIN_TARGET" \
            --all-families \
            --yes
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" "Families: expo convex mattpocock-teaching"
    assert_log_contains "add|expo/skills|"
    assert_log_contains "add|waynesutton/convexskills|"
    assert_log_contains "add|mattpocock/skills|agents=codex opencode gemini-cli github-copilot claude-code|skills=teach scaffold-exercises|copy=1|yes=1"
}

test_repo_wide_family_spec_installs_all_skills() {
    local wide_catalog="$TEST_ROOT/wide-catalog"
    local shared_repo_root="$MOCK_REPOS/acme/shared-skills"
    mkdir -p "$wide_catalog/families" "$shared_repo_root"
    create_mock_skill_file "$shared_repo_root" "alpha"
    create_mock_skill_file "$shared_repo_root" "beta"
    create_mock_skill_file "$shared_repo_root" "gamma"

    cat > "$wide_catalog/families.tsv" <<'EOF'
wide	Wide family
EOF
    cat > "$wide_catalog/families/wide.txt" <<'EOF'
acme/shared-skills
EOF

    (
        cd "$REPO_DIR"
        SKILL_CATALOG_DIR="$wide_catalog" \
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        SKILLS_AUDIT_REPO_COVERAGE=0 \
        "$DEPLOY_SCRIPT" \
            --target "$PLAIN_TARGET" \
            --family wide \
            --yes
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" "Families: wide"
    assert_contains "$OUTPUT_FILE" "Planned installs:"
    assert_contains "$OUTPUT_FILE" "  acme/shared-skills^: alpha beta gamma"
    assert_contains "$OUTPUT_FILE" "  ^ full upstream coverage for this repo"
    assert_log_contains "add|acme/shared-skills|agents=codex opencode gemini-cli github-copilot claude-code|skills=<all>|copy=1|yes=1"
}

test_repo_wide_local_family_spec_installs_all_skills_without_exclusions() {
    local local_config_file="$TEST_ROOT/.skills.local.json"
    local shared_repo_root="$MOCK_REPOS/acme/shared-skills"

    mkdir -p "$shared_repo_root"
    create_mock_skill_file "$shared_repo_root" "alpha"
    create_mock_skill_file "$shared_repo_root" "beta"
    create_mock_skill_file "$shared_repo_root" "gamma"

    cat > "$local_config_file" <<'EOF'
{
  "familySpecs": {
    "expo": [
      "acme/shared-skills"
    ]
  }
}
EOF

    (
        cd "$REPO_DIR"
        LOCAL_SKILLS_CONFIG_FILE="$local_config_file" \
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        SKILLS_AUDIT_REPO_COVERAGE=0 \
        "$DEPLOY_SCRIPT" \
            --target "$PLAIN_TARGET" \
            --family expo \
            --yes
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" "Families: expo"
    assert_contains "$OUTPUT_FILE" "Planned installs:"
    assert_contains "$OUTPUT_FILE" "  acme/shared-skills^: alpha beta gamma"
    assert_contains "$OUTPUT_FILE" "  ^ full upstream coverage for this repo"
    assert_log_contains "add|acme/shared-skills|agents=codex opencode gemini-cli github-copilot claude-code|skills=<all>|copy=1|yes=1"
}

test_explicit_family_summary_marks_full_coverage() {
    local explicit_catalog="$TEST_ROOT/explicit-catalog"
    local shared_repo_root="$MOCK_REPOS/acme/shared-skills"

    mkdir -p "$explicit_catalog/families" "$shared_repo_root"
    create_mock_skill_file "$shared_repo_root" "alpha"
    create_mock_skill_file "$shared_repo_root" "beta"
    create_mock_skill_file "$shared_repo_root" "gamma"

    cat > "$explicit_catalog/families.tsv" <<'EOF'
explicit	Explicit family
EOF
    cat > "$explicit_catalog/families/explicit.txt" <<'EOF'
acme/shared-skills@alpha
acme/shared-skills@beta
acme/shared-skills@gamma
EOF

    (
        cd "$REPO_DIR"
        SKILL_CATALOG_DIR="$explicit_catalog" \
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        SKILLS_AUDIT_REPO_COVERAGE=0 \
        "$DEPLOY_SCRIPT" \
            --target "$PLAIN_TARGET" \
            --family explicit \
            --yes
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" "Families: explicit"
    assert_contains "$OUTPUT_FILE" "Planned installs:"
    assert_contains "$OUTPUT_FILE" "  acme/shared-skills^: alpha beta gamma"
    assert_contains "$OUTPUT_FILE" "  ^ full upstream coverage for this repo"
    assert_log_contains "add|acme/shared-skills|agents=codex opencode gemini-cli github-copilot claude-code|skills=alpha beta gamma|copy=1|yes=1"
}

test_repo_wide_family_dry_run_requires_git_for_exact_summary() {
    local wide_catalog="$TEST_ROOT/wide-catalog"
    local no_git_bin="$TEST_ROOT/no-git-bin"

    mkdir -p "$wide_catalog/families" "$no_git_bin"
    ln -s "$SYSTEM_DIRNAME" "$no_git_bin/dirname"
    ln -s "$SYSTEM_AWK" "$no_git_bin/awk"
    cat > "$wide_catalog/families.tsv" <<'EOF'
wide	Wide family
EOF
    cat > "$wide_catalog/families/wide.txt" <<'EOF'
acme/shared-skills
EOF

    if (
        cd "$REPO_DIR"
        PATH="$no_git_bin" \
        SKILL_CATALOG_DIR="$wide_catalog" \
        "$SYSTEM_BASH" "$DEPLOY_SCRIPT" \
            --target "$PLAIN_TARGET" \
            --family wide \
            --dry-run
    ) > "$OUTPUT_FILE" 2>&1; then
        fail "expected repo-wide dry run to require git for exact summary output"
    fi

    assert_contains "$OUTPUT_FILE" "Cannot resolve repo summary for repo-wide skill spec without git: acme/shared-skills"
    assert_git_log_not_contains "git|clone"
}

test_invalid_exclude_family_specs_schema_fails_fast() {
    local local_config_file="$TEST_ROOT/.skills.local.json"
    cat > "$local_config_file" <<'EOF'
{
  "excludeFamilySpecs": []
}
EOF

    if (
        cd "$REPO_DIR"
        LOCAL_SKILLS_CONFIG_FILE="$local_config_file" \
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        SKILLS_AUDIT_REPO_COVERAGE=0 \
        "$DEPLOY_SCRIPT" \
            --target "$PLAIN_TARGET" \
            --family expo \
            --yes
    ) > "$OUTPUT_FILE" 2>&1; then
        fail "expected deploy script to reject invalid excludeFamilySpecs schema"
    fi

    assert_contains "$OUTPUT_FILE" "Invalid local skills config in $local_config_file"
    assert_log_not_contains "add|"
}

test_unknown_exclude_family_key_fails_fast() {
    local local_config_file="$TEST_ROOT/.skills.local.json"
    cat > "$local_config_file" <<'EOF'
{
  "excludeFamilySpecs": {
    "ghost": [
      "expo/skills@expo-cicd-workflows"
    ]
  }
}
EOF

    if (
        cd "$REPO_DIR"
        LOCAL_SKILLS_CONFIG_FILE="$local_config_file" \
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        SKILLS_AUDIT_REPO_COVERAGE=0 \
        "$DEPLOY_SCRIPT" \
            --target "$PLAIN_TARGET" \
            --family expo \
            --yes
    ) > "$OUTPUT_FILE" 2>&1; then
        fail "expected unknown excludeFamilySpecs family to fail validation"
    fi

    assert_contains "$OUTPUT_FILE" "Unknown curated family in $local_config_file:excludeFamilySpecs.ghost"
    assert_log_not_contains "add|"
}

test_exclude_family_specs_require_explicit_skills() {
    local local_config_file="$TEST_ROOT/.skills.local.json"
    cat > "$local_config_file" <<'EOF'
{
  "excludeFamilySpecs": {
    "expo": [
      "expo/skills"
    ]
  }
}
EOF

    if (
        cd "$REPO_DIR"
        LOCAL_SKILLS_CONFIG_FILE="$local_config_file" \
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        SKILLS_AUDIT_REPO_COVERAGE=0 \
        "$DEPLOY_SCRIPT" \
            --target "$PLAIN_TARGET" \
            --family expo \
            --yes
    ) > "$OUTPUT_FILE" 2>&1; then
        fail "expected repo-wide excludeFamilySpecs entry to fail validation"
    fi

    assert_contains "$OUTPUT_FILE" "Explicit skill spec required in $local_config_file:excludeFamilySpecs[expo][0]: expo/skills"
    assert_log_not_contains "add|"
}

test_local_family_specs_extend_curated_family() {
    local local_config_file="$TEST_ROOT/.skills.local.json"
    cat > "$local_config_file" <<'EOF'
{
  "familySpecs": {
    "expo": [
      "acme/mobile-skills@expo-internals"
    ]
  }
}
EOF

    (
        cd "$REPO_DIR"
        LOCAL_SKILLS_CONFIG_FILE="$local_config_file" \
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        SKILLS_AUDIT_REPO_COVERAGE=0 \
        "$DEPLOY_SCRIPT" \
            --target "$PLAIN_TARGET" \
            --family expo \
            --yes
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" "Families: expo"
    assert_log_contains "add|expo/skills|agents=codex opencode gemini-cli github-copilot claude-code|skills=building-native-ui expo-api-routes expo-cicd-workflows expo-deployment expo-dev-client expo-tailwind-setup native-data-fetching upgrading-expo use-dom|copy=1|yes=1"
    assert_log_contains "add|acme/mobile-skills|agents=codex opencode gemini-cli github-copilot claude-code|skills=expo-internals|copy=1|yes=1"
}

test_family_exclusion_removes_curated_skill() {
    local local_config_file="$TEST_ROOT/.skills.local.json"
    cat > "$local_config_file" <<'EOF'
{
  "excludeFamilySpecs": {
    "expo": [
      "expo/skills@expo-cicd-workflows"
    ]
  }
}
EOF

    (
        cd "$REPO_DIR"
        LOCAL_SKILLS_CONFIG_FILE="$local_config_file" \
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        SKILLS_AUDIT_REPO_COVERAGE=0 \
        "$DEPLOY_SCRIPT" \
            --target "$PLAIN_TARGET" \
            --family expo \
            --yes
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" "Families: expo"
    assert_log_contains "add|expo/skills|agents=codex opencode gemini-cli github-copilot claude-code|skills=building-native-ui expo-api-routes expo-deployment expo-dev-client expo-tailwind-setup native-data-fetching upgrading-expo use-dom|copy=1|yes=1"
    assert_log_not_contains "expo-cicd-workflows"
}

test_family_exclusion_removes_locally_added_spec() {
    local local_config_file="$TEST_ROOT/.skills.local.json"
    cat > "$local_config_file" <<'EOF'
{
  "familySpecs": {
    "expo": [
      "acme/mobile-skills@expo-internals"
    ]
  },
  "excludeFamilySpecs": {
    "expo": [
      "acme/mobile-skills@expo-internals"
    ]
  }
}
EOF

    (
        cd "$REPO_DIR"
        LOCAL_SKILLS_CONFIG_FILE="$local_config_file" \
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        SKILLS_AUDIT_REPO_COVERAGE=0 \
        "$DEPLOY_SCRIPT" \
            --target "$PLAIN_TARGET" \
            --family expo \
            --yes
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" "Families: expo"
    assert_log_contains "add|expo/skills|agents=codex opencode gemini-cli github-copilot claude-code|skills=building-native-ui expo-api-routes expo-cicd-workflows expo-deployment expo-dev-client expo-tailwind-setup native-data-fetching upgrading-expo use-dom|copy=1|yes=1"
    assert_log_not_contains "add|acme/mobile-skills|"
}

test_family_exclusion_is_scoped_per_family() {
    local overlap_catalog="$TEST_ROOT/overlap-catalog"
    local local_config_file="$TEST_ROOT/.skills.local.json"
    local shared_repo_root="$MOCK_REPOS/acme/shared-skills"

    mkdir -p "$overlap_catalog/families" "$shared_repo_root"
    create_mock_skill_file "$shared_repo_root" "shared-workflow"
    create_mock_skill_file "$shared_repo_root" "alpha-only"
    create_mock_skill_file "$shared_repo_root" "beta-only"
    cat > "$overlap_catalog/families.tsv" <<'EOF'
alpha	Alpha family
beta	Beta family
EOF
    cat > "$overlap_catalog/families/alpha.txt" <<'EOF'
acme/shared-skills@shared-workflow
acme/shared-skills@alpha-only
EOF
    cat > "$overlap_catalog/families/beta.txt" <<'EOF'
acme/shared-skills@shared-workflow
acme/shared-skills@beta-only
EOF
    cat > "$local_config_file" <<'EOF'
{
  "excludeFamilySpecs": {
    "alpha": [
      "acme/shared-skills@shared-workflow"
    ]
  }
}
EOF

    (
        cd "$REPO_DIR"
        SKILL_CATALOG_DIR="$overlap_catalog" \
        LOCAL_SKILLS_CONFIG_FILE="$local_config_file" \
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        SKILLS_AUDIT_REPO_COVERAGE=0 \
        "$DEPLOY_SCRIPT" \
            --target "$PLAIN_TARGET" \
            --family alpha \
            --family beta \
            --yes
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" "Families: alpha beta"
    assert_log_contains "add|acme/shared-skills|agents=codex opencode gemini-cli github-copilot claude-code|skills=alpha-only shared-workflow beta-only|copy=1|yes=1"
}

test_repo_wide_family_exclusion_normalizes_before_filtering() {
    local wide_catalog="$TEST_ROOT/wide-exclusion-catalog"
    local local_config_file="$TEST_ROOT/.skills.local.json"
    local shared_repo_root="$MOCK_REPOS/acme/shared-skills"

    mkdir -p "$wide_catalog/families" "$shared_repo_root"
    create_mock_skill_file "$shared_repo_root" "alpha"
    create_mock_skill_file "$shared_repo_root" "beta"
    create_mock_skill_file "$shared_repo_root" "gamma"

    cat > "$wide_catalog/families.tsv" <<'EOF'
wide	Wide family
EOF
    cat > "$wide_catalog/families/wide.txt" <<'EOF'
acme/shared-skills
EOF
    cat > "$local_config_file" <<'EOF'
{
  "excludeFamilySpecs": {
    "wide": [
      "acme/shared-skills@beta"
    ]
  }
}
EOF

    (
        cd "$REPO_DIR"
        SKILL_CATALOG_DIR="$wide_catalog" \
        LOCAL_SKILLS_CONFIG_FILE="$local_config_file" \
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        SKILLS_AUDIT_REPO_COVERAGE=0 \
        "$DEPLOY_SCRIPT" \
            --target "$PLAIN_TARGET" \
            --family wide \
            --yes
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" "Families: wide"
    assert_contains "$OUTPUT_FILE" "acme/shared-skills: alpha gamma"
    assert_log_contains "add|acme/shared-skills|agents=codex opencode gemini-cli github-copilot claude-code|skills=alpha gamma|copy=1|yes=1"
    assert_log_not_contains "skills=<all>"
    assert_log_not_contains "skills=alpha beta gamma"
}

test_family_exclusion_preserves_unaffected_repo_wide_specs() {
    local mixed_catalog="$TEST_ROOT/mixed-wide-exclusion-catalog"
    local local_config_file="$TEST_ROOT/.skills.local.json"
    local shared_repo_root="$MOCK_REPOS/acme/shared-skills"
    local toolbox_repo_root="$MOCK_REPOS/acme/toolbox-skills"

    mkdir -p "$mixed_catalog/families" "$shared_repo_root" "$toolbox_repo_root"
    create_mock_skill_file "$shared_repo_root" "alpha"
    create_mock_skill_file "$shared_repo_root" "beta"
    create_mock_skill_file "$shared_repo_root" "gamma"
    create_mock_skill_file "$toolbox_repo_root" "delta"
    create_mock_skill_file "$toolbox_repo_root" "epsilon"

    cat > "$mixed_catalog/families.tsv" <<'EOF'
wide-mixed	Wide mixed family
EOF
    cat > "$mixed_catalog/families/wide-mixed.txt" <<'EOF'
acme/shared-skills
acme/toolbox-skills
EOF
    cat > "$local_config_file" <<'EOF'
{
  "excludeFamilySpecs": {
    "wide-mixed": [
      "acme/shared-skills@beta"
    ]
  }
}
EOF

    (
        cd "$REPO_DIR"
        SKILL_CATALOG_DIR="$mixed_catalog" \
        LOCAL_SKILLS_CONFIG_FILE="$local_config_file" \
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        SKILLS_AUDIT_REPO_COVERAGE=0 \
        "$DEPLOY_SCRIPT" \
            --target "$PLAIN_TARGET" \
            --family wide-mixed \
            --yes
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" "Families: wide-mixed"
    assert_contains "$OUTPUT_FILE" "Planned installs:"
    assert_contains "$OUTPUT_FILE" "  acme/shared-skills: alpha gamma"
    assert_contains "$OUTPUT_FILE" "  acme/toolbox-skills^: delta epsilon"
    assert_contains "$OUTPUT_FILE" "  ^ full upstream coverage for this repo"
    assert_line_order \
        "$OUTPUT_FILE" \
        "  acme/shared-skills: alpha gamma" \
        "  acme/toolbox-skills^: delta epsilon"
    assert_log_contains "add|acme/shared-skills|agents=codex opencode gemini-cli github-copilot claude-code|skills=alpha gamma|copy=1|yes=1"
    assert_log_contains "add|acme/toolbox-skills|agents=codex opencode gemini-cli github-copilot claude-code|skills=<all>|copy=1|yes=1"
}

test_explicit_family_resolution_is_deterministic_across_runs() {
    local overlap_catalog="$TEST_ROOT/deterministic-overlap-catalog"
    local local_config_file="$TEST_ROOT/.skills.local.json"
    local expected_line="add|acme/shared-skills|agents=codex opencode gemini-cli github-copilot claude-code|skills=alpha-only shared-workflow beta-only|copy=1|yes=1"
    local shared_repo_root="$MOCK_REPOS/acme/shared-skills"

    mkdir -p "$overlap_catalog/families" "$shared_repo_root"
    create_mock_skill_file "$shared_repo_root" "shared-workflow"
    create_mock_skill_file "$shared_repo_root" "alpha-only"
    create_mock_skill_file "$shared_repo_root" "beta-only"
    cat > "$overlap_catalog/families.tsv" <<'EOF'
alpha	Alpha family
beta	Beta family
EOF
    cat > "$overlap_catalog/families/alpha.txt" <<'EOF'
acme/shared-skills@shared-workflow
acme/shared-skills@alpha-only
EOF
    cat > "$overlap_catalog/families/beta.txt" <<'EOF'
acme/shared-skills@shared-workflow
acme/shared-skills@beta-only
EOF
    cat > "$local_config_file" <<'EOF'
{
  "excludeFamilySpecs": {
    "alpha": [
      "acme/shared-skills@shared-workflow"
    ]
  }
}
EOF

    (
        cd "$REPO_DIR"
        SKILL_CATALOG_DIR="$overlap_catalog" \
        LOCAL_SKILLS_CONFIG_FILE="$local_config_file" \
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        SKILLS_AUDIT_REPO_COVERAGE=0 \
        "$DEPLOY_SCRIPT" \
            --target "$PLAIN_TARGET" \
            --family alpha \
            --family beta \
            --yes
    ) > "$OUTPUT_FILE" 2>&1

    (
        cd "$REPO_DIR"
        SKILL_CATALOG_DIR="$overlap_catalog" \
        LOCAL_SKILLS_CONFIG_FILE="$local_config_file" \
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        SKILLS_AUDIT_REPO_COVERAGE=0 \
        "$DEPLOY_SCRIPT" \
            --target "$PLAIN_TARGET" \
            --family alpha \
            --family beta \
            --yes
    ) >> "$OUTPUT_FILE" 2>&1

    if [ "$(grep -Fxc "$expected_line" "$LOG_FILE")" -ne 2 ]; then
        echo "--- $LOG_FILE ---" >&2
        cat "$LOG_FILE" >&2
        echo "------------" >&2
        fail "expected repeated runs to emit identical explicit install arguments"
    fi
}

test_empty_result_after_family_exclusions_is_valid() {
    local empty_catalog="$TEST_ROOT/empty-catalog"
    local local_config_file="$TEST_ROOT/.skills.local.json"

    mkdir -p "$empty_catalog/families"
    cat > "$empty_catalog/families.tsv" <<'EOF'
solo	Solo family
EOF
    cat > "$empty_catalog/families/solo.txt" <<'EOF'
acme/shared-skills@solo-skill
EOF
    cat > "$local_config_file" <<'EOF'
{
  "excludeFamilySpecs": {
    "solo": [
      "acme/shared-skills@solo-skill"
    ]
  }
}
EOF

    (
        cd "$REPO_DIR"
        SKILL_CATALOG_DIR="$empty_catalog" \
        LOCAL_SKILLS_CONFIG_FILE="$local_config_file" \
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        SKILLS_AUDIT_REPO_COVERAGE=0 \
        "$DEPLOY_SCRIPT" \
            --target "$PLAIN_TARGET" \
            --family solo \
            --yes
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" "Families: solo"
    assert_contains "$OUTPUT_FILE" "Planned installs:"
    assert_contains "$OUTPUT_FILE" "  (none)"
    assert_contains "$OUTPUT_FILE" "  ^ full upstream coverage for this repo"
    assert_contains "$OUTPUT_FILE" "Done."
    assert_log_not_contains "add|"
}

test_fully_excluded_repo_still_participates_in_coverage_audit() {
    local empty_catalog="$TEST_ROOT/empty-audit-catalog"
    local local_config_file="$TEST_ROOT/.skills.local.json"
    local coverage_manifest="$TEST_ROOT/empty-audit-coverage.json"
    local shared_repo_root="$MOCK_REPOS/acme/shared-skills"

    mkdir -p "$empty_catalog/families" "$shared_repo_root"
    cat > "$empty_catalog/families.tsv" <<'EOF'
solo	Solo family
EOF
    cat > "$empty_catalog/families/solo.txt" <<'EOF'
acme/shared-skills@solo-skill
EOF
    cat > "$local_config_file" <<'EOF'
{
  "excludeFamilySpecs": {
    "solo": [
      "acme/shared-skills@solo-skill"
    ]
  }
}
EOF
    cat > "$coverage_manifest" <<'EOF'
{
  "repos": [
    {
      "repo": "acme/shared-skills",
      "ignored": []
    }
  ]
}
EOF
    create_mock_skill_file "$shared_repo_root" "solo-skill"
    create_mock_skill_file "$shared_repo_root" "newly-added-skill"

    (
        cd "$REPO_DIR"
        PATH="$TEST_ROOT/bin:$ORIGINAL_PATH" \
        SKILL_CATALOG_DIR="$empty_catalog" \
        LOCAL_SKILLS_CONFIG_FILE="$local_config_file" \
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        FAMILY_UPSTREAM_COVERAGE_FILE="$coverage_manifest" \
        "$DEPLOY_SCRIPT" \
            --target "$PLAIN_TARGET" \
            --family solo \
            --yes
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" "Auditing curated family repos..."
    assert_contains "$OUTPUT_FILE" "WARN: Undeclared upstream skill(s) in acme/shared-skills: newly-added-skill"
    assert_not_contains "$OUTPUT_FILE" "No family coverage drift found."
    assert_contains "$OUTPUT_FILE" "Done."
    assert_log_not_contains "add|"
}

test_custom_local_family_lists_and_deploys() {
    local local_config_file="$TEST_ROOT/.skills.local.json"
    cat > "$local_config_file" <<'EOF'
{
  "customFamilies": {
    "acme-mobile": {
      "description": "Acme mobile workflow skills",
      "specs": [
        "acme/mobile-skills@expo-internals",
        "acme/mobile-skills@release-ops"
      ]
    }
  }
}
EOF

    (
        cd "$REPO_DIR"
        LOCAL_SKILLS_CONFIG_FILE="$local_config_file" \
        SKILLS_BIN="$TEST_ROOT/bin/does-not-exist" \
        "$DEPLOY_SCRIPT" --list-families
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" $'acme-mobile\tAcme mobile workflow skills'

    (
        cd "$REPO_DIR"
        LOCAL_SKILLS_CONFIG_FILE="$local_config_file" \
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        SKILLS_AUDIT_REPO_COVERAGE=0 \
        "$DEPLOY_SCRIPT" \
            --target "$PLAIN_TARGET" \
            --family acme-mobile \
            --yes
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" "Families: acme-mobile"
    assert_log_contains "add|acme/mobile-skills|agents=codex opencode gemini-cli github-copilot claude-code|skills=expo-internals release-ops|copy=1|yes=1"
}

test_custom_local_family_rejects_empty_specs() {
    local local_config_file="$TEST_ROOT/.skills.local.json"
    cat > "$local_config_file" <<'EOF'
{
  "customFamilies": {
    "acme-mobile": {
      "description": "Acme mobile workflow skills",
      "specs": []
    }
  }
}
EOF

    if (
        cd "$REPO_DIR"
        LOCAL_SKILLS_CONFIG_FILE="$local_config_file" \
        SKILLS_BIN="$TEST_ROOT/bin/does-not-exist" \
        "$DEPLOY_SCRIPT" --list-families
    ) > "$OUTPUT_FILE" 2>&1; then
        fail "expected empty custom family specs to fail validation"
    fi

    assert_contains "$OUTPUT_FILE" "Custom family must define at least one spec in $local_config_file:customFamilies.acme-mobile.specs"
    assert_not_contains "$OUTPUT_FILE" $'acme-mobile\tAcme mobile workflow skills'
}

test_custom_local_family_rejects_multiline_description() {
    local local_config_file="$TEST_ROOT/.skills.local.json"
    cat > "$local_config_file" <<'EOF'
{
  "customFamilies": {
    "acme-mobile": {
      "description": "Line 1\nLine 2",
      "specs": [
        "acme/mobile-skills@expo-internals"
      ]
    }
  }
}
EOF

    if (
        cd "$REPO_DIR"
        LOCAL_SKILLS_CONFIG_FILE="$local_config_file" \
        SKILLS_BIN="$TEST_ROOT/bin/does-not-exist" \
        "$DEPLOY_SCRIPT" --list-families
    ) > "$OUTPUT_FILE" 2>&1; then
        fail "expected multiline custom family description to fail validation"
    fi

    assert_contains "$OUTPUT_FILE" "Invalid family description in $local_config_file:customFamilies.acme-mobile.description"
    assert_not_contains "$OUTPUT_FILE" $'acme-mobile\t'
}

test_family_audit_warning_nonfatal() {
    create_mock_skill_file "$MOCK_REPOS/expo/skills" "newly-added-skill"

    (
        cd "$REPO_DIR"
        PATH="$TEST_ROOT/bin:$ORIGINAL_PATH" \
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        FAMILY_UPSTREAM_COVERAGE_FILE="$FAMILY_MANIFEST_FILE" \
        "$DEPLOY_SCRIPT" \
            --target "$PLAIN_TARGET" \
            --family expo \
            --yes
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" "Auditing curated family repos..."
    assert_contains "$OUTPUT_FILE" "WARN: Undeclared upstream skill(s) in expo/skills: newly-added-skill"
    assert_contains "$OUTPUT_FILE" "Done."
    assert_log_contains "add|expo/skills|"
}

test_family_exclusion_is_ignored_in_repo_coverage_audit() {
    local local_config_file="$TEST_ROOT/.skills.local.json"

    cat > "$local_config_file" <<'EOF'
{
  "excludeFamilySpecs": {
    "expo": [
      "expo/skills@expo-cicd-workflows"
    ]
  }
}
EOF

    (
        cd "$REPO_DIR"
        PATH="$TEST_ROOT/bin:$ORIGINAL_PATH" \
        LOCAL_SKILLS_CONFIG_FILE="$local_config_file" \
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        FAMILY_UPSTREAM_COVERAGE_FILE="$FAMILY_MANIFEST_FILE" \
        "$DEPLOY_SCRIPT" \
            --target "$PLAIN_TARGET" \
            --family expo \
            --yes
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" "Auditing curated family repos..."
    assert_not_contains "$OUTPUT_FILE" "WARN: Undeclared upstream skill(s) in expo/skills:"
    assert_contains "$OUTPUT_FILE" "Done."
    assert_log_contains "add|expo/skills|agents=codex opencode gemini-cli github-copilot claude-code|skills=building-native-ui expo-api-routes expo-deployment expo-dev-client expo-tailwind-setup native-data-fetching upgrading-expo use-dom|copy=1|yes=1"
}

test_dry_run_skips_audit_and_install_but_keeps_exact_summary_enumeration() {
    create_mock_skill_file "$MOCK_REPOS/expo/skills" "newly-added-skill"

    (
        cd "$REPO_DIR"
        SKILLS_BIN="$TEST_ROOT/bin/does-not-exist" \
        FAMILY_UPSTREAM_COVERAGE_FILE="$FAMILY_MANIFEST_FILE" \
        "$DEPLOY_SCRIPT" \
            --target "$PLAIN_TARGET" \
            --family expo \
            --dry-run
    ) > "$OUTPUT_FILE" 2>&1

    assert_contains "$OUTPUT_FILE" "Deploying skills to target directory: $PLAIN_TARGET"
    assert_contains "$OUTPUT_FILE" "Planned installs:"
    assert_not_contains "$OUTPUT_FILE" "Auditing curated family repos..."
    assert_not_contains "$OUTPUT_FILE" "WARN: Undeclared upstream skill(s)"
    assert_log_not_contains "add|"
    assert_contains "$GIT_LOG_FILE" "git|clone --depth 1 https://github.com/expo/skills.git"
}

test_invalid_catalog_spec_fails_fast() {
    local bad_catalog="$TEST_ROOT/bad-catalog"
    mkdir -p "$bad_catalog/families"
    cat > "$bad_catalog/families.tsv" <<'EOF'
broken	Broken family
EOF
    cat > "$bad_catalog/families/broken.txt" <<'EOF'
bad spec
EOF

    if (
        cd "$REPO_DIR"
        SKILLS_BIN="$TEST_ROOT/bin/skills" \
        SKILL_CATALOG_DIR="$bad_catalog" \
        SKILLS_AUDIT_REPO_COVERAGE=0 \
        "$DEPLOY_SCRIPT" \
            --target "$PLAIN_TARGET" \
            --family broken \
            --yes
    ) > "$OUTPUT_FILE" 2>&1; then
        fail "expected deploy script to reject malformed catalog specs"
    fi

    assert_contains "$OUTPUT_FILE" "Unknown family: broken"
    assert_log_not_contains "add|"
}

run_test "list families" test_list_families
run_test "list families skips missing spec files" test_list_families_skips_missing_spec_files
run_test "list families skips malformed spec files" test_list_families_skips_malformed_spec_files
run_test "help without dependencies" test_help_without_dependencies
run_test "missing flag values fail fast" test_missing_flag_values_fail_fast
run_test "non-interactive deploy" test_noninteractive_deploy
run_test "non-interactive deploy to non-git target" test_noninteractive_deploy_non_git_target
run_test "non-interactive deploy expands quoted tilde target" test_noninteractive_deploy_expands_quoted_tilde_target
run_test "quoted tilde target without HOME fails cleanly" test_quoted_tilde_target_without_home_fails_cleanly
run_test "interactive deploy" test_interactive_deploy
run_test "interactive deploy expands tilde target" test_interactive_deploy_expands_tilde_target
run_test "interactive deploy aborts on invalid local config" test_interactive_deploy_aborts_on_invalid_local_config
run_test "non-interactive custom family reports invalid local config" test_noninteractive_custom_family_reports_invalid_local_config
run_test "interactive family selection reports invalid local config" test_interactive_family_selection_reports_invalid_local_config
run_test "all families deploy" test_all_families_deploy
run_test "repo-wide family spec installs all skills" test_repo_wide_family_spec_installs_all_skills
run_test "repo-wide local family spec installs all skills without exclusions" test_repo_wide_local_family_spec_installs_all_skills_without_exclusions
run_test "explicit family summary marks full coverage" test_explicit_family_summary_marks_full_coverage
run_test "repo-wide family dry run requires git for exact summary" test_repo_wide_family_dry_run_requires_git_for_exact_summary
run_test "invalid excludeFamilySpecs schema fails fast" test_invalid_exclude_family_specs_schema_fails_fast
run_test "unknown excludeFamilySpecs family fails fast" test_unknown_exclude_family_key_fails_fast
run_test "excludeFamilySpecs entries must be explicit skills" test_exclude_family_specs_require_explicit_skills
run_test "local family specs extend curated family" test_local_family_specs_extend_curated_family
run_test "family exclusion removes curated skill" test_family_exclusion_removes_curated_skill
run_test "family exclusion removes locally added spec" test_family_exclusion_removes_locally_added_spec
run_test "family exclusion is scoped per family" test_family_exclusion_is_scoped_per_family
run_test "repo-wide family exclusion normalizes before filtering" test_repo_wide_family_exclusion_normalizes_before_filtering
run_test "family exclusion preserves unaffected repo-wide specs" test_family_exclusion_preserves_unaffected_repo_wide_specs
run_test "explicit family resolution is deterministic across runs" test_explicit_family_resolution_is_deterministic_across_runs
run_test "empty result after family exclusions is valid" test_empty_result_after_family_exclusions_is_valid
run_test "fully excluded repo still participates in coverage audit" test_fully_excluded_repo_still_participates_in_coverage_audit
run_test "custom local family lists and deploys" test_custom_local_family_lists_and_deploys
run_test "custom local family rejects empty specs" test_custom_local_family_rejects_empty_specs
run_test "custom local family rejects multiline description" test_custom_local_family_rejects_multiline_description
run_test "family audit warning is non-fatal" test_family_audit_warning_nonfatal
run_test "family exclusion is ignored in repo coverage audit" test_family_exclusion_is_ignored_in_repo_coverage_audit
run_test "dry run skips audit and install but keeps exact summary enumeration" test_dry_run_skips_audit_and_install_but_keeps_exact_summary_enumeration
run_test "invalid catalog spec fails fast" test_invalid_catalog_spec_fails_fast

echo "PASSED: $TESTS_RUN test(s)"
