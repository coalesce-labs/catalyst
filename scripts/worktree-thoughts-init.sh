#!/usr/bin/env bash
# Forwarder (CTL-2306): the thoughts layout creator lives in the dev plugin, beside
# create-worktree.sh, so it ships with the plugin and the create-worktree skill.
# setup-catalyst.sh and setup-workspace.sh still call this path.
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../plugins/dev/scripts/worktree-thoughts-init.sh" "$@"
