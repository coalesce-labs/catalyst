#!/usr/bin/env bash
# linear-team-keys — read-only loader for the cached Linear team-key allowlist.
# CTL-633. Network-free, fail-open: an empty / missing / malformed / unreadable
# cache means "no filtering" so the helper continues to behave like today on
# fresh installs.
#
# Cache location: ${XDG_CONFIG_HOME:-$HOME/.config}/catalyst/linear-team-keys.json
# Cache shape:    {"keys": ["ADV", "CTL", "ENG", ...], "fetched_at": "ISO-8601"}
# Refresh (manual, run by the operator — see plugins/dev/skills/linearis/SKILL.md):
#   mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/catalyst"
#   linearis teams list --json |
#     jq '{keys:[.nodes[].key]|sort, fetched_at:(now|todate)}' \
#     > "${XDG_CONFIG_HOME:-$HOME/.config}/catalyst/linear-team-keys.json"

linear_team_keys_cache_path() {
	printf '%s/catalyst/linear-team-keys.json' \
		"${XDG_CONFIG_HOME:-$HOME/.config}"
}

# Print the cached allowlist, one key per line, sorted+deduped. Empty output
# means "no allowlist available — fail open".
# NB: the local is named cache_path, NOT path. Under zsh `path` is a special
# array tied to $PATH; `local path; path=<file>` would clobber PATH to the
# cache-file path for the rest of the function, making `sort`/`jq` resolve to
# "command not found" so the loader always failed open under zsh (CTL-633
# phase-review finding #1, zsh-runtime class). Bash treats `path` as ordinary,
# which is why the bash test suites never caught this.
linear_team_keys_load() {
	local cache_path
	cache_path="$(linear_team_keys_cache_path)"
	[[ -r "$cache_path" ]] || return 0
	jq -r '.keys[]? // empty' "$cache_path" 2>/dev/null | sort -u
}

# Filter stdin tokens (TEAM-NNN, one per line) through the allowlist. Empty
# allowlist ⇒ passthrough. Otherwise drops tokens whose TEAM prefix is not in
# the allowlist (exact case-sensitive UPPER-case match on the prefix).
linear_team_keys_filter() {
	local allowlist
	allowlist="$(linear_team_keys_load)"
	if [[ -z "$allowlist" ]]; then
		cat
		return 0
	fi
	# Use a comma-joined keylist for awk -v so we don't depend on BSD/GNU awk
	# accepting embedded newlines in command-line string literals (BSD does not).
	local keys_csv
	keys_csv="$(printf '%s' "$allowlist" | tr '\n' ',')"
	awk -v keys="$keys_csv" '
		BEGIN { n = split(keys, k, ","); for (i=1;i<=n;i++) if (k[i] != "") a[k[i]] = 1 }
		{
			p = $0; sub(/-[0-9]+$/, "", p)
			if (p in a) print
		}
	'
}
