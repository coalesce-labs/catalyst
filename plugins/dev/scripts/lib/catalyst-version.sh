# catalyst-version.sh — shared version helper for catalyst-* CLIs (CTL-390).
#
# Sourced from each CLI's --version branch. Exposes a single function:
#
#   catalyst_print_version <cli-name> [script-path]
#
# Resolves the caller's plugin tree and prints three lines to stdout:
#
#   catalyst-<cli-name> <version>
#   commit: <embedded-sha> | local:<sha> (worktree: <branch>) | unknown
#   source: <plugin-root | script-dir>
#
# Priority for the commit hash:
#   1. If a .git ancestor exists  → local:<sha>, source is the script's dir.
#   2. Else if plugins/dev/commit.txt is non-empty → embedded sha.
#   3. Else                                       → "unknown".
#
# Tests live at plugins/dev/scripts/__tests__/catalyst-version.test.sh.

# Trim leading/trailing whitespace from a file's contents. Echoes empty when
# the file is missing or empty. Avoids depending on GNU-only flags.
_cv_read_trim() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  # tr strips spaces/tabs/newlines anywhere; for single-line files that's the
  # right behavior (the file should contain one token).
  tr -d '[:space:]' < "$file"
}

# Resolve the real (symlink-followed) path of $1. Uses readlink -f when
# available, falls back to a portable loop.
_cv_real_path() {
  local path="$1"
  if [[ -z "$path" ]]; then return 0; fi
  # readlink -f works on Linux + macOS GNU coreutils; macOS BSD readlink does
  # not. Try GNU first, then fall back.
  local resolved
  resolved=$(readlink -f "$path" 2>/dev/null) && [[ -n "$resolved" ]] && {
    printf '%s' "$resolved"; return 0;
  }
  # Portable fallback — walk symlinks manually.
  local p="$path" dir
  while [[ -L "$p" ]]; do
    dir=$(cd -P "$(dirname "$p")" 2>/dev/null && pwd) || break
    p=$(readlink "$p" 2>/dev/null) || break
    case "$p" in
      /*) ;;
      *) p="$dir/$p" ;;
    esac
  done
  if [[ -e "$p" ]]; then
    dir=$(cd -P "$(dirname "$p")" 2>/dev/null && pwd) || { printf '%s' "$path"; return 0; }
    printf '%s/%s' "$dir" "$(basename "$p")"
  else
    printf '%s' "$path"
  fi
}

catalyst_print_version() {
  local cli_name="${1:-catalyst}"
  # When called from a script's --version branch BASH_SOURCE[1] is the script
  # itself; tests pass an explicit path as $2.
  local script_path="${2:-${BASH_SOURCE[1]:-${BASH_SOURCE[0]}}}"

  local resolved script_dir
  resolved=$(_cv_real_path "$script_path")
  script_dir=$(cd -P "$(dirname "$resolved")" 2>/dev/null && pwd) || script_dir="$(dirname "$resolved")"

  # Walk ancestors looking for:
  #   plugin_root = first dir containing version.txt AND .claude-plugin/plugin.json
  #   git_root    = first dir containing .git (dir or worktree file)
  local search="$script_dir" plugin_root="" git_root=""
  while [[ -n "$search" && "$search" != "/" ]]; do
    if [[ -z "$plugin_root" && -f "$search/version.txt" && -f "$search/.claude-plugin/plugin.json" ]]; then
      plugin_root="$search"
    fi
    if [[ -z "$git_root" && ( -d "$search/.git" || -f "$search/.git" ) ]]; then
      git_root="$search"
    fi
    [[ -n "$plugin_root" && -n "$git_root" ]] && break
    search=$(dirname "$search")
  done

  local version="unknown"
  if [[ -n "$plugin_root" ]]; then
    local v
    v=$(_cv_read_trim "$plugin_root/version.txt")
    [[ -n "$v" ]] && version="$v"
  fi

  local commit="unknown" worktree_note="" source_path
  source_path="${plugin_root:-$script_dir}"

  if [[ -n "$git_root" ]] && command -v git >/dev/null 2>&1; then
    local sha branch
    sha=$(git -C "$git_root" rev-parse HEAD 2>/dev/null || true)
    branch=$(git -C "$git_root" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
    if [[ -n "$sha" ]]; then
      commit="local:${sha}"
      if [[ -n "$branch" && "$branch" != "HEAD" ]]; then
        worktree_note=" (worktree: ${branch})"
      fi
      source_path="$script_dir"
    fi
  fi

  if [[ "$commit" == "unknown" && -n "$plugin_root" ]]; then
    local embedded
    embedded=$(_cv_read_trim "$plugin_root/commit.txt")
    [[ -n "$embedded" ]] && commit="$embedded"
  fi

  printf '%s %s\n' "$cli_name" "$version"
  printf 'commit: %s%s\n' "$commit" "$worktree_note"
  printf 'source: %s\n' "$source_path"
}
