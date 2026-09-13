#!/usr/bin/env bash
# output-path.sh — Resolve the output path for the morning briefing markdown.
#
# Usage:
#   output-path.sh [--date YYYY-MM-DD] [--dry-run] [--root DIR]
#
# Prints an absolute (or root-relative) path. Default root is the repo CWD;
# dry-run uses /tmp.

set -euo pipefail

DATE=""
DRY_RUN=0
ROOT="${PWD}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --date) DATE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --root) ROOT="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,8p' "$0"; exit 0 ;;
    *)
      echo "output-path.sh: unknown flag $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$DATE" ]]; then
  DATE="$(date -u +%Y-%m-%d)"
fi

if ! [[ "$DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "output-path.sh: --date must be YYYY-MM-DD, got: $DATE" >&2
  exit 2
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  printf '/tmp/morning-briefing-%s.md\n' "$DATE"
else
  printf '%s/thoughts/briefings/%s.md\n' "$ROOT" "$DATE"
fi
