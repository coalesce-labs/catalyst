#!/usr/bin/env bash
# catalyst-agent-path.sh — CAT-29. The single derivation of the Catalyst agent PATH.
# Every entry is existence-tested. Homebrew is found from absolute candidates because
# `brew` itself may be unresolvable on the broken PATH this leaf is repairing.

[[ -n "${_CATALYST_AGENT_PATH_SOURCED:-}" ]] && return 0
_CATALYST_AGENT_PATH_SOURCED=1

catalyst_agent_path_candidates() {
	printf '%s\n' \
		"${HOME}/.catalyst/bin" \
		"${HOME}/.local/node/bin" \
		"${HOME}/.local/bin" \
		"${HOME}/.bun/bin" \
		"/opt/homebrew/bin" \
		"/opt/homebrew/sbin" \
		"/usr/local/bin" \
		"/usr/bin" \
		"/bin" \
		"/usr/sbin" \
		"/sbin"
}

# catalyst_agent_path [extra:...] — print existing directories, de-duplicated in
# canonical order, followed by real entries from the optional inherited PATH.
catalyst_agent_path() {
	local extra="${1:-}" dir out="" seen=":" rest
	while IFS= read -r dir; do
		[[ -n "$dir" && -d "$dir" ]] || continue
		case "$seen" in *":${dir}:"*) continue ;; esac
		seen="${seen}${dir}:"
		out="${out:+${out}:}${dir}"
	done < <(catalyst_agent_path_candidates)

	rest="$extra"
	while [[ -n "$rest" ]]; do
		dir="${rest%%:*}"
		if [[ -n "$dir" && -d "$dir" ]]; then
			case "$seen" in
				*":${dir}:"*) ;;
				*) seen="${seen}${dir}:"; out="${out:+${out}:}${dir}" ;;
			esac
		fi
		[[ "$rest" == *:* ]] || break
		rest="${rest#*:}"
	done
	printf '%s\n' "$out"
}
