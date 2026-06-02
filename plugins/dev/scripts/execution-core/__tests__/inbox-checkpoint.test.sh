#!/usr/bin/env bash
# CTL-749: Verify inbox.jsonl is written and readable at a phase checkpoint.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXEC_CORE_DIR="$(dirname "$SCRIPT_DIR")"

ORCH_DIR=$(mktemp -d)
TICKET="CTL-999"
mkdir -p "${ORCH_DIR}/workers/${TICKET}"

node --input-type=module <<EOF
import { createCommentInboxWriter, createUpdateInboxWriter } from '${EXEC_CORE_DIR}/daemon.mjs';

// Test 1: comment writer
const commentWriter = createCommentInboxWriter('${ORCH_DIR}', '');
commentWriter({ ticket: '${TICKET}', commentId: 'c1', body: 'please add tests', authorId: 'u1', authorName: 'Ryan' });

// Test 2: description update writer
const updateWriter = createUpdateInboxWriter('${ORCH_DIR}', '');
updateWriter({ ticket: '${TICKET}', identifier: '${TICKET}', description: 'new desc', descriptionChanged: true, actorId: 'u1', actorName: 'Ryan' });
EOF

INBOX="${ORCH_DIR}/workers/${TICKET}/inbox.jsonl"
[[ -f "$INBOX" ]] || { echo "FAIL: inbox.jsonl not created"; rm -rf "$ORCH_DIR"; exit 1; }

ENTRIES=$(cat "$INBOX")
echo "$ENTRIES" | grep -q '"kind":"comment"' \
  || { echo "FAIL: missing comment entry"; echo "Got: $ENTRIES"; rm -rf "$ORCH_DIR"; exit 1; }
echo "$ENTRIES" | grep -q '"body":"please add tests"' \
  || { echo "FAIL: wrong comment body"; echo "Got: $ENTRIES"; rm -rf "$ORCH_DIR"; exit 1; }
echo "$ENTRIES" | grep -q '"kind":"description_changed"' \
  || { echo "FAIL: missing description_changed entry"; echo "Got: $ENTRIES"; rm -rf "$ORCH_DIR"; exit 1; }
echo "$ENTRIES" | grep -q '"description":"new desc"' \
  || { echo "FAIL: wrong description"; echo "Got: $ENTRIES"; rm -rf "$ORCH_DIR"; exit 1; }

echo "PASS: inbox.jsonl written with correct schema (comment + description_changed)"
rm -rf "$ORCH_DIR"
