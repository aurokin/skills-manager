#!/usr/bin/env bash

audit_warn() {
    echo "WARN: $*" >&2
}

declare -gA UPSTREAM_SKILL_NAME_CACHE=()
declare -gA UPSTREAM_SKILL_CACHE_STATUS=()

load_upstream_coverage_manifest() {
    local manifest_file="$1"

    jq -er '
        .repos
        | if type != "array" then error("expected .repos to be an array") else . end
        | .[]
        | [
            (.repo | if type == "string" and length > 0 then . else error("repo must be a non-empty string") end),
            ((.ignored // [])
                | if type == "array" then . else error("ignored must be an array") end
                | join(" "))
          ]
        | @tsv
    ' "$manifest_file"
}

load_coverage_manifest_into_maps() {
    local manifest_file="$1"
    local repos_name="$2"
    local ignored_name="$3"
    local manifest_output
    local coverage_repo ignored_list
    local -n repos_ref="$repos_name"
    local -n ignored_ref="$ignored_name"

    repos_ref=()
    ignored_ref=()

    manifest_output="$(load_upstream_coverage_manifest "$manifest_file")" || return 1
    while IFS=$'\t' read -r coverage_repo ignored_list; do
        [ -z "$coverage_repo" ] && continue
        repos_ref+=("$coverage_repo")
        ignored_ref["$coverage_repo"]="$ignored_list"
    done <<< "$manifest_output"
}

collect_upstream_skill_names() {
    local repo="$1"
    local tmp_dir repo_dir skill_file skill_name frontmatter_name
    local skill_file_count=0
    local has_root_skill=0

    tmp_dir="$(mktemp -d)"
    repo_dir="$tmp_dir/repo"

    if ! git clone --depth 1 "https://github.com/${repo}.git" "$repo_dir" >/dev/null 2>&1; then
        rm -rf "$tmp_dir"
        return 1
    fi

    # The skills CLI treats a root SKILL.md as the canonical single-skill
    # layout (see `skills add --full-depth`). When present, it is the only
    # skill the CLI installs by default, so we mirror that here.
    if [ -f "$repo_dir/SKILL.md" ]; then
        has_root_skill=1
    fi

    # Otherwise enumerate every SKILL.md anywhere in the working tree so we
    # cover both `skills/<name>/SKILL.md` and agent-scoped layouts like
    # `.claude/skills/<name>/SKILL.md` (used by dedene/raindrop-cli).
    while IFS= read -r -d '' skill_file; do
        if [ "$has_root_skill" -eq 1 ] && [ "$skill_file" != "$repo_dir/SKILL.md" ]; then
            continue
        fi
        skill_file_count=$((skill_file_count + 1))
        skill_name="$(basename "$(dirname "$skill_file")")"
        if [ "$skill_file" = "$repo_dir/SKILL.md" ]; then
            skill_name="$(basename "$repo")"
        fi
        frontmatter_name="$(extract_skill_frontmatter_name "$skill_file")"
        if [ -n "$frontmatter_name" ]; then
            skill_name="$frontmatter_name"
        fi
        printf '%s\n' "$skill_name"
    done < <(find "$repo_dir" -type d -name .git -prune -o -type f -name SKILL.md -print0 2>/dev/null)

    if [ "$skill_file_count" -eq 0 ]; then
        audit_warn "No SKILL.md files found in $repo; repo layout may have changed"
        rm -rf "$tmp_dir"
        return 1
    fi

    rm -rf "$tmp_dir"
}

extract_skill_frontmatter_name() {
    local skill_file="$1"

    awk '
        BEGIN { in_yaml = 0 }
        /^---$/ {
            if (in_yaml == 0) {
                in_yaml = 1
                next
            }
            exit
        }
        in_yaml && /^name:[[:space:]]*/ {
            sub(/^name:[[:space:]]*/, "")
            gsub(/^["'"'"']|["'"'"']$/, "")
            print
            exit
        }
    ' "$skill_file"
}

collect_upstream_skill_names_cached() {
    local repo="$1"
    local target_name="${2:-}"
    local cached_output

    if [[ -n "${UPSTREAM_SKILL_CACHE_STATUS[$repo]:-}" ]]; then
        if [ "${UPSTREAM_SKILL_CACHE_STATUS[$repo]}" -eq 0 ]; then
            cached_output="${UPSTREAM_SKILL_NAME_CACHE[$repo]}"
            if [ -n "$target_name" ]; then
                local -n target_ref="$target_name"
                target_ref="$cached_output"
            elif [ -n "$cached_output" ]; then
                printf '%s\n' "$cached_output"
            fi
            return 0
        fi
        return 1
    fi

    if ! cached_output="$(collect_upstream_skill_names "$repo" | sort -u)"; then
        UPSTREAM_SKILL_CACHE_STATUS["$repo"]=1
        return 1
    fi

    UPSTREAM_SKILL_NAME_CACHE["$repo"]="$cached_output"
    UPSTREAM_SKILL_CACHE_STATUS["$repo"]=0

    if [ -n "$target_name" ]; then
        local -n target_ref="$target_name"
        target_ref="$cached_output"
    elif [ -n "$cached_output" ]; then
        printf '%s\n' "$cached_output"
    fi
}

append_skill_to_repo_map() {
    local repo="$1"
    local skill_name="$2"
    local target_name="$3"
    local -n target_ref="$target_name"

    if [ -z "$skill_name" ]; then
        return 0
    fi

    if [[ -z "${target_ref[$repo]:-}" ]]; then
        target_ref["$repo"]="$skill_name"
    else
        target_ref["$repo"]+=$'\n'"$skill_name"
    fi
}

build_resolved_repo_skill_summary_data() {
    local specs_name="$1"
    local repo_order_name="$2"
    local skills_by_repo_name="$3"
    local full_coverage_name="$4"
    local -n specs_ref="$specs_name"
    local -n repo_order_ref="$repo_order_name"
    local -n skills_by_repo_ref="$skills_by_repo_name"
    local -n full_coverage_ref="$full_coverage_name"
    local spec repo skill_name upstream_output sorted_skills joined_skills
    local -A raw_skills_by_repo=()
    local -A repos_seen=()

    repo_order_ref=()
    skills_by_repo_ref=()
    full_coverage_ref=()

    for spec in "${specs_ref[@]}"; do
        repo="$(spec_repo "$spec")"
        repos_seen["$repo"]=1

        if spec_has_explicit_skill "$spec"; then
            append_skill_to_repo_map "$repo" "$(spec_skill "$spec")" raw_skills_by_repo
            continue
        fi

        if ! command -v git >/dev/null 2>&1; then
            echo "Cannot resolve repo summary for repo-wide skill spec without git: $repo" >&2
            return 1
        fi

        if ! collect_upstream_skill_names_cached "$repo" upstream_output; then
            echo "Failed to resolve repo summary for repo-wide skill spec: $repo" >&2
            return 1
        fi

        while IFS= read -r skill_name; do
            [ -z "$skill_name" ] && continue
            append_skill_to_repo_map "$repo" "$skill_name" raw_skills_by_repo
        done <<< "$upstream_output"
    done

    while IFS= read -r repo; do
        [ -z "$repo" ] && continue

        sorted_skills="$(
            printf '%s\n' "${raw_skills_by_repo[$repo]:-}" |
                awk 'NF' |
                sort -u
        )"
        [ -z "$sorted_skills" ] && continue

        joined_skills="$(paste -sd ' ' - <<< "$sorted_skills")"
        repo_order_ref+=("$repo")
        skills_by_repo_ref["$repo"]="$joined_skills"

        if [[ -z "${UPSTREAM_SKILL_CACHE_STATUS[$repo]:-}" ]]; then
            if ! command -v git >/dev/null 2>&1; then
                echo "Cannot resolve full-coverage marker without git: $repo" >&2
                return 1
            fi

            if ! collect_upstream_skill_names_cached "$repo" upstream_output; then
                echo "Failed to resolve full-coverage marker for repo: $repo" >&2
                return 1
            fi
        fi

        if [[ "${UPSTREAM_SKILL_CACHE_STATUS[$repo]:-}" == "0" ]] &&
            [[ "$sorted_skills" == "${UPSTREAM_SKILL_NAME_CACHE[$repo]}" ]]; then
            full_coverage_ref["$repo"]=1
        fi
    done < <(printf '%s\n' "${!repos_seen[@]}" | sort)
}

print_resolved_repo_skill_summary() {
    local heading="$1"
    local specs_name="$2"
    local summary_repo_order=()
    local -A summary_skills_by_repo=()
    local -A summary_full_coverage=()
    local repo
    local marker

    build_resolved_repo_skill_summary_data \
        "$specs_name" \
        summary_repo_order \
        summary_skills_by_repo \
        summary_full_coverage || return 1

    echo "$heading"
    if [ "${#summary_repo_order[@]}" -eq 0 ]; then
        echo "  (none)"
    else
        for repo in "${summary_repo_order[@]}"; do
            marker=""
            if [[ -n "${summary_full_coverage[$repo]:-}" ]]; then
                marker="^"
            fi
            echo "  $repo$marker: ${summary_skills_by_repo[$repo]}"
        done
    fi
    echo "  ^ full upstream coverage for this repo"
}

audit_repo_skill_coverage() {
    local repo="$1"
    local declared_list="$2"
    local ignored_list="$3"
    local upstream_output
    local -A declared_names=()
    local -A ignored_names=()
    local -A upstream_names=()
    local -a unexpected_names=()
    local -a missing_names=()
    local name

    for name in $declared_list; do
        declared_names["$name"]=1
    done
    for name in $ignored_list; do
        ignored_names["$name"]=1
    done

    if ! collect_upstream_skill_names_cached "$repo" upstream_output; then
        return 1
    fi

    while IFS= read -r name; do
        [ -z "$name" ] && continue
        upstream_names["$name"]=1
        if [[ -z "${declared_names[$name]:-}" && -z "${ignored_names[$name]:-}" ]]; then
            unexpected_names+=("$name")
        fi
    done <<< "$upstream_output"

    for name in "${!declared_names[@]}"; do
        if [[ -z "${upstream_names[$name]:-}" ]]; then
            missing_names+=("$name")
        fi
    done

    if [ "${#unexpected_names[@]}" -gt 0 ]; then
        audit_warn "Undeclared upstream skill(s) in $repo: ${unexpected_names[*]}"
    fi
    if [ "${#missing_names[@]}" -gt 0 ]; then
        audit_warn "Declared skill(s) no longer found in $repo: ${missing_names[*]}"
    fi

    if [ "${#unexpected_names[@]}" -gt 0 ] || [ "${#missing_names[@]}" -gt 0 ]; then
        return 2
    fi

    return 0
}
