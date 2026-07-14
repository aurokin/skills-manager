#!/usr/bin/env bash

set -euo pipefail
shopt -s nullglob

# Link all skills from this repository to the shared agents skills dir

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="$SCRIPT_DIR/skills"

# shellcheck source=lib/agents.sh
source "$SCRIPT_DIR/lib/agents.sh"

skills_agents=()
compute_skills_agents skills_agents

SKILL_TARGET_DIRS=(
    "$HOME/.agents/skills"
    "$HOME/.claude/skills"
)
if agents_include_hermes skills_agents; then
    SKILL_TARGET_DIRS+=("$HOME/.hermes/skills")
fi
SKILL_PATHS=("$SKILLS_DIR"/*/)

# Gated skills (disable-model-invocation: true in frontmatter) are never
# placed in shared roots; skm renders them per-agent (ADR 0011).
skill_is_gated() {
    local skill_md="$1/SKILL.md"
    [ -f "$skill_md" ] || return 1
    # Tolerate YAML-equivalent forms skm's parser also accepts: extra
    # whitespace and trailing comments.
    awk '/^---[[:space:]]*$/ { fence++; next } fence == 1 && /^disable-model-invocation:[[:space:]]+true[[:space:]]*(#.*)?$/ { found = 1 } fence >= 2 { exit } END { exit !found }' "$skill_md"
}

LINKABLE_SKILL_PATHS=()
for skill in "${SKILL_PATHS[@]}"; do
    if skill_is_gated "$skill"; then
        echo "Skipping gated skill (skm-placed): $(basename "$skill")"
    else
        LINKABLE_SKILL_PATHS+=("$skill")
    fi
done

declare -A LOCAL_SKILL_NAMES=()
for skill in "${LINKABLE_SKILL_PATHS[@]}"; do
    LOCAL_SKILL_NAMES["$(basename "$skill")"]=1
done

# Create skill directories if they don't exist
for target_dir in "${SKILL_TARGET_DIRS[@]}"; do
    mkdir -p "$target_dir"
done

# Remove stale symlinks previously created for repo-local skills that no longer exist.
for target_dir in "${SKILL_TARGET_DIRS[@]}"; do
    while IFS= read -r -d '' target; do
        skill_name="$(basename "$target")"
        link_dest="$(readlink "$target" || true)"

        if [[ "$link_dest" == "$SKILLS_DIR/"* ]] && [[ -z "${LOCAL_SKILL_NAMES[$skill_name]:-}" ]]; then
            echo "Removing stale local link: $skill_name from $target_dir"
            rm "$target"
        fi
    done < <(find "$target_dir" -maxdepth 1 -mindepth 1 -type l -print0)
done

# Link each skill
for skill in "${LINKABLE_SKILL_PATHS[@]}"; do
    skill_name="$(basename "$skill")"

    for target_dir in "${SKILL_TARGET_DIRS[@]}"; do
        target="$target_dir/$skill_name"

        if [ -L "$target" ]; then
            echo "Updating link: $skill_name -> $target_dir"
            rm "$target"
        elif [ -e "$target" ]; then
            echo "Skipping $skill_name in $target_dir: already exists and is not a symlink"
            continue
        else
            echo "Linking: $skill_name -> $target_dir"
        fi

        ln -s "$skill" "$target"
    done
done

echo "Done!"
