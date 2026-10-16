#!/usr/bin/env bash
# downscale-screenshots.sh — cap QA screenshot resolution to keep vision-token reads cheap.
#
# WHY: a full-res web/full-page screenshot can cost up to ~4,784 image tokens on Opus;
# capped to a 1600px long edge it's ~1,600. 1600px is still plenty for a Linear bug
# attachment (Linear displays them smaller). This only shrinks files ABOVE the ceiling,
# so it's idempotent and never enlarges.
#
# SAFE BY DEFAULT: dry-run unless you pass --apply. Downscales IN PLACE, so review the
# dry-run first. Originals above the ceiling are not otherwise backed up.
#
# USAGE:
#   scripts/downscale-screenshots.sh                 # dry-run over projects/*/qa-reports
#   scripts/downscale-screenshots.sh --apply         # actually downscale
#   scripts/downscale-screenshots.sh <dir> --apply   # scope to one dir
#   CEIL=1080 scripts/downscale-screenshots.sh --apply   # custom long-edge ceiling

set -euo pipefail
CEIL="${CEIL:-1600}"
APPLY=0
DIR=""
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    --*) echo "unknown flag: $a" >&2; exit 2 ;;
    *) DIR="$a" ;;
  esac
done

# Default scan roots: every project's qa-reports (that's where attachments live).
roots=()
if [ -n "$DIR" ]; then roots+=("$DIR")
else for d in projects/*/qa-reports; do [ -d "$d" ] && roots+=("$d"); done
fi
[ ${#roots[@]} -eq 0 ] && { echo "no target dirs (pass one explicitly)"; exit 1; }

total=0 over=0 saved_before=0 saved_after=0
tmp="$(mktemp)"
# Collect candidate images (png/jpg/jpeg), skip the figma _rendered cache (already bounded).
find "${roots[@]}" -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' \) \
  -not -path '*/_rendered/*' -print0 > "$tmp"

while IFS= read -r -d '' f; do
  total=$((total+1))
  w=$(sips -g pixelWidth  "$f" 2>/dev/null | awk '/pixelWidth/{print $2}')
  h=$(sips -g pixelHeight "$f" 2>/dev/null | awk '/pixelHeight/{print $2}')
  [ -z "${w:-}" ] || [ -z "${h:-}" ] && continue
  long=$(( w > h ? w : h ))
  if [ "$long" -gt "$CEIL" ]; then
    over=$((over+1))
    bytes=$(stat -f%z "$f" 2>/dev/null || echo 0)
    saved_before=$((saved_before + bytes))
    if [ "$APPLY" -eq 1 ]; then
      sips -Z "$CEIL" "$f" >/dev/null 2>&1
      abytes=$(stat -f%z "$f" 2>/dev/null || echo 0)
      saved_after=$((saved_after + abytes))
      printf '  shrunk %sx%s → long≤%s  %s\n' "$w" "$h" "$CEIL" "${f#./}"
    else
      printf '  would shrink %sx%s (long=%s)  %s\n' "$w" "$h" "$long" "${f#./}"
    fi
  fi
done < "$tmp"
rm -f "$tmp"

echo ""
echo "images scanned: $total   over ${CEIL}px long-edge: $over"
if [ "$APPLY" -eq 1 ]; then
  mb() { awk "BEGIN{printf \"%.1f\", $1/1048576}"; }
  echo "disk: $(mb $saved_before)MB → $(mb $saved_after)MB on the $over resized files"
  echo "Done (in place)."
else
  echo "(dry-run — re-run with --apply to downscale in place)"
fi
