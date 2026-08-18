#!/usr/bin/env bash
# catalyst-replica-path.sh — CTL-1893. The bash half of the replica-path resolver.
#
# Independently maintained mirror of `lib/replica-path.mjs`, held byte-identical to it by
# `__tests__/replica-path-parity.test.sh` (the one-registry / two-engines / cross-stack
# parity-suite discipline `lib/secret-contract.mjs` and `lib/deployment-mode.mjs` already
# use). Read the JS header for the design; this file carries only what differs in bash.
#
# ⛔ WHY THIS CANNOT JUST `echo` THE PATH.
#
# The resolver is THREE-VALUED: ok-with-a-path, a named failure with NO path, and
# ok-but-the-override-disagrees. A `$(...)` capture flattens all three into a string, and
# an empty capture reads exactly like "no account named" AND like "the command crashed" —
# the failure class this repo has now hit four times in one night. So the result is
# published in GLOBALS and the function is called DIRECTLY, never in a subshell:
#
#   catalyst_replica_path "$account" || { echo "$CATALYST_REPLICA_PATH_REASON" >&2; exit 1; }
#   db="$CATALYST_REPLICA_PATH_VALUE"
#
# Return code: 0 = resolved, 1 = named failure (REASON is always set, VALUE is always
# cleared). A caller that ignores the return code and reads VALUE gets an empty string,
# which cannot be mistaken for a real database path.
#
# shellcheck shell=bash

# The account a host serves when it declares none. MUST match replica-path.mjs's
# DEFAULT_ACCOUNT and cloud-sync.mjs's; the parity suite asserts it rather than trusting it.
CATALYST_REPLICA_DEFAULT_ACCOUNT="tenant-0"

# catalyst_replica_is_account_name <name> — usable as a path segment?
# Mirrors ACCOUNT_RE: alphanumeric first character, then [A-Za-z0-9._-], and no "..".
catalyst_replica_is_account_name() {
  local name="${1-}"
  [ -n "$name" ] || return 1
  case "$name" in
    *..*) return 1 ;;
  esac
  # Bracket expressions inside a `case` pattern are glob character classes, not a regex —
  # this is the portable form (no [[ =~ ]], which bash 3.2 on stock macOS handles but
  # `sh` does not).
  case "$name" in
    [A-Za-z0-9]) return 0 ;;
    [A-Za-z0-9]*)
      case "$name" in
        *[!A-Za-z0-9._-]*) return 1 ;;
        *) return 0 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

# _catalyst_replica_dir — the CATALYST_DIR ladder, identical to the JS catalystDir():
# a non-empty CATALYST_DIR wins, else ${HOME}/catalyst. An EMPTY CATALYST_DIR is not a
# declaration (`:-`, not `-`).
_catalyst_replica_dir() {
  printf '%s' "${CATALYST_DIR:-${HOME:-}/catalyst}"
}

# catalyst_replica_path <account>
#
# Publishes:
#   CATALYST_REPLICA_PATH_VALUE      the path to use ("" on a named failure)
#   CATALYST_REPLICA_PATH_DERIVED    the account-derived path ("" on a named failure)
#   CATALYST_REPLICA_PATH_ACCOUNT    the account as given
#   CATALYST_REPLICA_PATH_SOURCE     override | override-agrees | derived | derived-default
#   CATALYST_REPLICA_PATH_REASON     "" on success; account-absent | account-invalid
#   CATALYST_REPLICA_PATH_DISAGREES  1 when an explicit override != the derived path
catalyst_replica_path() {
  local account="${1-}" dir derived override trimmed

  CATALYST_REPLICA_PATH_VALUE=""
  CATALYST_REPLICA_PATH_DERIVED=""
  CATALYST_REPLICA_PATH_ACCOUNT="$account"
  CATALYST_REPLICA_PATH_SOURCE=""
  CATALYST_REPLICA_PATH_REASON=""
  CATALYST_REPLICA_PATH_DISAGREES=0

  # An all-whitespace account is ABSENT, matching the JS `account.trim() === ""`.
  # ⚠️ The trim is used ONLY for that emptiness test — the name check below runs against
  # the ORIGINAL string, exactly as the JS does. " tenant-0 " must therefore come back
  # `account-invalid` (a space is not in the alphabet), never a silently-trimmed success.
  trimmed="${account#"${account%%[![:space:]]*}"}"
  trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
  if [ -z "$trimmed" ]; then
    CATALYST_REPLICA_PATH_REASON="account-absent"
    return 1
  fi
  if ! catalyst_replica_is_account_name "$account"; then
    CATALYST_REPLICA_PATH_REASON="account-invalid"
    return 1
  fi

  dir="$(_catalyst_replica_dir)"
  if [ "$account" = "$CATALYST_REPLICA_DEFAULT_ACCOUNT" ]; then
    derived="${dir}/catalyst-replica.db"
  else
    derived="${dir}/replicas/${account}.db"
  fi
  CATALYST_REPLICA_PATH_DERIVED="$derived"

  override="${CATALYST_REPLICA_DB:-}"
  if [ -n "$override" ]; then
    CATALYST_REPLICA_PATH_VALUE="$override"
    if [ "$override" = "$derived" ]; then
      CATALYST_REPLICA_PATH_SOURCE="override-agrees"
    else
      CATALYST_REPLICA_PATH_SOURCE="override"
      CATALYST_REPLICA_PATH_DISAGREES=1
    fi
    return 0
  fi

  CATALYST_REPLICA_PATH_VALUE="$derived"
  if [ "$account" = "$CATALYST_REPLICA_DEFAULT_ACCOUNT" ]; then
    CATALYST_REPLICA_PATH_SOURCE="derived-default"
  else
    CATALYST_REPLICA_PATH_SOURCE="derived"
  fi
  return 0
}
