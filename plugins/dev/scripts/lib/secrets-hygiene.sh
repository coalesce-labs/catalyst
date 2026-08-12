#!/usr/bin/env bash
# Secret-hygiene primitives (CTL-1203). Source me; do not execute directly.
# bash-3.2 safe: no mapfile, no associative arrays.

# Portable self-path: BASH_SOURCE under bash, prompt-expansion %x under zsh.
# shellcheck disable=SC2296
__SH_SELF="${BASH_SOURCE[0]:-${(%):-%x}}"
__SH_LIB_DIR="$(cd "$(dirname "$__SH_SELF")" && pwd)"
source "${__SH_LIB_DIR}/portable-stat.sh"

# harden_secrets_dir <dir>
# mkdir -p then chmod 700 the dir. Idempotent; no-op if already 700.
harden_secrets_dir() {
	local dir="$1"
	[[ -n "$dir" ]] || return 1
	mkdir -p "$dir" || return 1
	chmod 700 "$dir"
}

# ensure_secrets_gitignore <dir>
# Ensure <dir>/.gitignore contains "config*.json" and "*.env".
# Creates the file if missing; appends missing lines; never duplicates.
ensure_secrets_gitignore() {
	local dir="$1" gi line
	gi="${dir}/.gitignore"
	mkdir -p "$dir" || return 1
	[[ -f "$gi" ]] || : > "$gi"
	for line in 'config*.json' '*.env'; do
		grep -qxF "$line" "$gi" 2>/dev/null || printf '%s\n' "$line" >> "$gi"
	done
}

# write_secret_file <content> <path>
# Atomic writer: write under umask 077, chmod 600, mv into place.
write_secret_file() {
	# NB: the second local is named dest_path, NOT path. Under zsh, `path` is a
	# special array tied to $PATH; `local path` scopes it locally and resets it
	# to empty, making `mktemp` unresolvable (command not found). Bash treats
	# `path` as ordinary. CTL-1777; see also linear-team-keys.sh:22-27.
	local content="$1" dest_path="$2" tmp
	tmp="$(mktemp)" || return 1
	( umask 077; printf '%s' "$content" > "$tmp" ) || { rm -f "$tmp"; return 1; }
	chmod 600 "$tmp"
	mv "$tmp" "$dest_path"
}
