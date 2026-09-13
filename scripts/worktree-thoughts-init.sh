#!/usr/bin/env bash
# Forwarder (CTL-2306): the thoughts layout creator lives in the dev plugin, beside
# create-worktree.sh, so it ships with the plugin and the create-worktree skill.
# setup-catalyst.sh and setup-workspace.sh still call this path.
# This file only forwards: a copy of it on its own (e.g. into a plugin cache) cannot work.
self="${BASH_SOURCE[0]}"
while [ -L "$self" ]; do
	link="$(readlink "$self")"
	case "$link" in /*) self="$link" ;; *) self="$(dirname "$self")/$link" ;; esac
done
target="$(cd "$(dirname "$self")" && pwd)/../plugins/dev/scripts/worktree-thoughts-init.sh"
if [ ! -f "$target" ]; then
	echo "worktree-thoughts-init: forwarder target missing: $target" >&2
	echo "worktree-thoughts-init: this file only forwards; copy the canonical plugins/dev/scripts/worktree-thoughts-init.sh instead" >&2
	exit 1
fi
exec bash "$target" "$@"
