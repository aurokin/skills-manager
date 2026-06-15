#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_BIN="${SKILLS_BIN:-skills}"
SKILLS_AUDIT_REPO_COVERAGE="${SKILLS_AUDIT_REPO_COVERAGE:-1}"
UPSTREAM_COVERAGE_FILE="${UPSTREAM_COVERAGE_FILE:-$SCRIPT_DIR/upstream-coverage.json}"

# shellcheck source=lib/agents.sh
source "$SCRIPT_DIR/lib/agents.sh"
# shellcheck source=lib/catalog.sh
source "$SCRIPT_DIR/lib/catalog.sh"
# shellcheck source=lib/upstream-audit.sh
source "$SCRIPT_DIR/lib/upstream-audit.sh"

require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "Missing required command: $1" >&2
        exit 1
    fi
}

warn() {
    audit_warn "$@"
}

expand_full_repo_specs() {
    local -n specs_ref="$1"
    local -n expanded_specs_ref="$2"
    local spec repo skill_name
    local upstream_skill_names

    expanded_specs_ref=()
    for spec in "${specs_ref[@]}"; do
        if spec_has_explicit_skill "$spec"; then
            expanded_specs_ref+=("$spec")
            continue
        fi

        repo="$(spec_repo "$spec")"
        if ! command -v git >/dev/null 2>&1; then
            echo "Cannot expand repo-wide skill spec without git: $repo" >&2
            exit 1
        fi

        if ! collect_upstream_skill_names_cached "$repo" upstream_skill_names; then
            echo "Failed to expand repo-wide skill spec: $repo" >&2
            exit 1
        fi

        while IFS= read -r skill_name; do
            [ -z "$skill_name" ] && continue
            expanded_specs_ref+=("$repo@$skill_name")
        done <<< "$upstream_skill_names"
    done
}

filter_excluded_specs() {
    local specs_name="$1"
    local excludes_name="$2"
    local target_name="$3"
    local -n specs_ref="$specs_name"
    local -n excludes_ref="$excludes_name"
    local -n target_ref="$target_name"
    local spec
    local -A excluded_lookup=()

    target_ref=()
    for spec in "${excludes_ref[@]}"; do
        excluded_lookup["$spec"]=1
    done

    for spec in "${specs_ref[@]}"; do
        if [[ -n "${excluded_lookup[$spec]:-}" ]]; then
            continue
        fi
        target_ref+=("$spec")
    done
}

resolve_excluded_specs() {
    local excludes_name="$1"
    local available_name="$2"
    local target_name="$3"
    local -n excludes_ref="$excludes_name"
    local -n available_ref="$available_name"
    local -n target_ref="$target_name"
    local spec repo available_spec
    local -A available_by_repo=()

    target_ref=()
    for spec in "${available_ref[@]}"; do
        repo="$(spec_repo "$spec")"
        if [[ -z "${available_by_repo[$repo]:-}" ]]; then
            available_by_repo["$repo"]="$spec"
        else
            available_by_repo["$repo"]+=$'\n'"$spec"
        fi
    done

    for spec in "${excludes_ref[@]}"; do
        if spec_has_explicit_skill "$spec"; then
            target_ref+=("$spec")
            continue
        fi

        repo="$(spec_repo "$spec")"
        if [[ -z "${available_by_repo[$repo]:-}" ]]; then
            continue
        fi

        while IFS= read -r available_spec; do
            [ -z "$available_spec" ] && continue
            target_ref+=("$available_spec")
        done <<< "${available_by_repo[$repo]}"
    done

    dedupe_array "$target_name"
}

append_specs_to_repo_skill_map() {
    local specs_name="$1"
    local target_name="$2"
    local -n specs_ref="$specs_name"
    local -n target_ref="$target_name"
    local spec
    local repo
    local name

    for spec in "${specs_ref[@]}"; do
        repo="$(spec_repo "$spec")"
        name="$(spec_skill "$spec")"
        if [[ -z "${target_ref[$repo]:-}" ]]; then
            target_ref["$repo"]="$name"
        else
            target_ref["$repo"]+=" $name"
        fi
    done
}

main() {
    require_cmd "$SKILLS_BIN"
    require_cmd jq

    local skills_agents=()
    compute_skills_agents skills_agents
    if [ "${#skills_agents[@]}" -eq 0 ]; then
        echo "No SKILLS_AGENTS configured" >&2
        exit 1
    fi

    local non_hermes_skills_agents=()
    agents_excluding_hermes skills_agents non_hermes_skills_agents

    # Source of truth: desired global skill specs.
    # Keep this list fully explicit so stale-skill removal can compare exact
    # names and the curated set does not drift when upstream repos add skills.
    local specs=()
    load_global_specs specs

    local expanded_specs=()
    expand_full_repo_specs specs expanded_specs

    local excluded_specs=()
    load_local_global_exclude_specs excluded_specs || return 1

    local resolved_excluded_specs=()
    resolve_excluded_specs excluded_specs expanded_specs resolved_excluded_specs

    local desired_specs=()
    filter_excluded_specs expanded_specs resolved_excluded_specs desired_specs

    local preserved_global_skill_names=()
    load_preserved_global_skill_names preserved_global_skill_names || return 1

    echo "Syncing global skills for agents: ${skills_agents[*]}"

    # Build set of exact expected skill names from the curated specs.
    local -A desired_names=()
    local -A preserved_names=()
    local -A declared_by_repo=()
    append_specs_to_repo_skill_map desired_specs declared_by_repo
    for spec in "${desired_specs[@]}"; do
        local repo
        local name
        repo="$(spec_repo "$spec")"
        name="$(spec_skill "$spec")"
        desired_names["${spec##*@}"]=1
    done
    for name in "${preserved_global_skill_names[@]}"; do
        preserved_names["$name"]=1
    done

    local -a coverage_repos=()
    local -A ignored_by_repo=()
    if [ "$SKILLS_AUDIT_REPO_COVERAGE" = "1" ]; then
        if [ ! -f "$UPSTREAM_COVERAGE_FILE" ]; then
            warn "Skipping upstream repo coverage audit because manifest is missing: $UPSTREAM_COVERAGE_FILE"
        else
            if ! load_coverage_manifest_into_maps "$UPSTREAM_COVERAGE_FILE" coverage_repos ignored_by_repo; then
                warn "Skipping upstream repo coverage audit because manifest is invalid: $UPSTREAM_COVERAGE_FILE"
            fi
        fi
    fi
    append_specs_to_repo_skill_map resolved_excluded_specs ignored_by_repo

    # Resolve the exact summary before mutating global installs so any
    # enumeration failure happens before stale removals or new installs.
    echo ""
    print_resolved_repo_skill_summary "Resolved global skill summary:" desired_specs

    # Get currently installed global skill names (only ~/.agents/skills/).
    # The skills CLI ignores symlinks, so locally-linked skills from
    # link-skills.sh are naturally excluded.
    local -A installed_names=()
    while IFS= read -r name; do
        [ -z "$name" ] && continue
        installed_names["$name"]=1
    done < <("$SKILLS_BIN" list -g --json | jq -r --arg home "$HOME" \
        '.[] | select(.path | startswith($home + "/.agents/skills/")) | .name')

    # --- Phase 1: Remove stale skills ---
    echo ""
    echo "Checking for stale skills..."
    if [ "${#non_hermes_skills_agents[@]}" -eq 0 ]; then
        echo "  Skipping stale-skill removal (Hermes-only mode; Hermes installs are add-only)."
    else
        local removed=0
        for name in "${!installed_names[@]}"; do
            if [[ -n "${preserved_names[$name]:-}" ]]; then
                echo "  Preserving manual skill: $name"
                continue
            fi
            if [[ -z "${desired_names[$name]:-}" ]]; then
                echo "  Removing: $name"
                "$SKILLS_BIN" remove -g "$name" -a "${non_hermes_skills_agents[@]}" -y || true
                removed=$((removed + 1))
            fi
        done
        if [ "$removed" -eq 0 ]; then
            echo "  No stale skills to remove."
        else
            echo "  Removed $removed skill(s)."
        fi
    fi

    # Clean up broken symlinks in owned skills directories regardless of mode:
    # these dirs are always ours and the cleanup has zero Hermes interaction.
    local skills_target link
    for skills_target in "$HOME/.agents/skills" "$HOME/.claude/skills"; do
        if [ -d "$skills_target" ]; then
            while IFS= read -r -d '' link; do
                echo "  Cleaned broken symlink: $(basename "$link") (in $skills_target)"
                rm -f "$link"
            done < <(find "$skills_target" -maxdepth 1 -type l ! -exec test -e {} \; -print0 2>/dev/null)
        fi
    done

    # Hermes is append-only: only remove broken symlinks that resolve into
    # paths we own. Real directories and foreign-target symlinks are left
    # untouched so Hermes can manage its own skill collection.
    #
    # readlink target prefixes we recognize as ours:
    #   $SCRIPT_DIR/skills/      — local repo skills linked by link-skills.sh
    #                              (absolute path)
    #   $HOME/.agents/skills/    — canonical install path for multi-agent
    #                              installs by the skills CLI (absolute form)
    #   ../../.agents/skills/    — same canonical install path in the relative
    #                              form the skills CLI typically emits
    if agents_include_hermes skills_agents; then
        local hermes_skills_dir="$HOME/.hermes/skills"
        if [ -d "$hermes_skills_dir" ]; then
            local link_dest
            while IFS= read -r -d '' link; do
                link_dest="$(readlink "$link" 2>/dev/null || true)"
                case "$link_dest" in
                    "$SCRIPT_DIR/skills/"*|"$HOME/.agents/skills/"*|"../../.agents/skills/"*)
                        echo "  Cleaned broken symlink: $(basename "$link") (in $hermes_skills_dir)"
                        rm -f "$link"
                        ;;
                esac
            done < <(find "$hermes_skills_dir" -maxdepth 1 -type l ! -exec test -e {} \; -print0 2>/dev/null)
        fi
    fi

    # --- Phase 2: Update existing skills ---
    echo ""
    echo "Updating existing skills..."
    "$SKILLS_BIN" update

    # --- Coverage audit: full-coverage repos should not gain silent skills ---
    if [ "$SKILLS_AUDIT_REPO_COVERAGE" = "1" ]; then
        echo ""
        echo "Auditing full-coverage upstream repos..."
        if [ "${#coverage_repos[@]}" -eq 0 ]; then
            warn "Skipping upstream repo coverage audit because no coverage repos are configured"
        elif ! command -v git >/dev/null 2>&1; then
            warn "Skipping upstream repo coverage audit because git is not installed"
        else
            local coverage_repo
            local audit_warnings=0
            local audit_failures=0
            for coverage_repo in "${coverage_repos[@]}"; do
                if audit_repo_skill_coverage \
                    "$coverage_repo" \
                    "${declared_by_repo[$coverage_repo]:-}" \
                    "${ignored_by_repo[$coverage_repo]:-}"; then
                    :
                else
                    case $? in
                        1)
                            audit_failures=$((audit_failures + 1))
                            warn "Skipping upstream repo coverage audit for $coverage_repo"
                            ;;
                        2)
                            audit_warnings=$((audit_warnings + 1))
                            ;;
                    esac
                fi
            done
            if [ "$audit_warnings" -eq 0 ] && [ "$audit_failures" -eq 0 ]; then
                echo "  No upstream coverage drift found."
            fi
        fi
    fi

    # --- Phase 3: Add missing skills ---
    echo ""
    echo "Adding skills..."
    local -A missing_by_repo=()
    local repo_order=()
    for spec in "${desired_specs[@]}"; do
        local repo
        local name
        repo="$(spec_repo "$spec")"
        name="$(spec_skill "$spec")"
        if [[ -z "${installed_names[$name]:-}" ]]; then
            if [[ -z "${missing_by_repo[$repo]:-}" ]]; then
                repo_order+=("$repo")
                missing_by_repo["$repo"]="$name"
            else
                missing_by_repo["$repo"]+=" $name"
            fi
        fi
    done
    if [ "${#repo_order[@]}" -eq 0 ]; then
        echo "  No skills to add."
    else
        local repo
        for repo in "${repo_order[@]}"; do
            local repo_skills=()
            local add_extra_args=()
            IFS=' ' read -r -a repo_skills <<< "${missing_by_repo[$repo]}"
            echo "  Adding from $repo: ${repo_skills[*]}"
            # OpenClaw hosts unverified community submissions, so the CLI requires
            # an explicit acknowledgement before installing from that repo.
            if [ "$repo" = "openclaw/openclaw" ]; then
                add_extra_args+=(--dangerously-accept-openclaw-risks)
            fi
            # Diffwarden keeps its consumable skill below skills/diffwarden/.
            # Full-depth discovery matches the install command documented there.
            if [ "$repo" = "aurokin/diffwarden" ]; then
                add_extra_args+=(--full-depth)
            fi
            "$SKILLS_BIN" add "$repo" -g -a "${skills_agents[@]}" -s "${repo_skills[@]}" -y "${add_extra_args[@]}"
        done
    fi

    # --- Phase 4: Link local skills ---
    echo ""
    echo "Linking local repo skills..."
    "$SCRIPT_DIR/link-skills.sh"

    echo ""
    echo "Done."
}

main "$@"
