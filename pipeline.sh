#!/usr/bin/env bash
# Runs the full topic-to-video pipeline, four stages, one slug threaded through all of them.
#
# Usage: bash pipeline.sh "<topic>" <slug> [gen-brief.js extra flags...]
#   e.g. bash pipeline.sh "Kerala backwaters honeymoon trip" kerala-backwaters
#        bash pipeline.sh "Solo trek in Spiti valley" spiti-trek --objective action

set -euo pipefail

TOPIC="$1"; SLUG="$2"; shift 2

BRIEF="prompts/briefs/${SLUG}.json"
REFS_DIR="prompts/_refs/${SLUG}"
VEO_PROMPT="${REFS_DIR}/veo-prompt.md"
REFS_MANIFEST="${REFS_DIR}/references.json"
OUT="_reel/${SLUG}.mp4"

echo "== 1/4  brief   ($BRIEF)"
node gen-brief.js "$TOPIC" "$BRIEF" "$@"

echo "== 2/4  images  ($REFS_DIR)"
node gen-3refs.js "$BRIEF" "$REFS_DIR"

echo "== 3/4  veo prompt  ($VEO_PROMPT)"
node gen-veo-prompt.js "$BRIEF" "$VEO_PROMPT" "$REFS_MANIFEST"

echo "== 4/4  video   ($OUT)"
node build-reel.js "$VEO_PROMPT" "$REFS_MANIFEST" "$OUT"

echo
echo "done → $OUT"
