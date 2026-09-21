#!/usr/bin/env bash
#
# Blinding layer 4 of 4: assert against the ACTUAL BUILT BUNDLE that a control
# participant's browser cannot obtain progress information.
#
# The other three layers are the two return types (lib/dal/quiz.ts), the
# code-split shells (app/quiz/page.tsx), and the ESLint import wall. This one
# is the only check that survives a refactor which quietly defeats them all.
#
#   pnpm build && ./scripts/check-blinding.sh
#
# Next 16 removed the "First Load JS" column from build output, so grepping
# the chunks is the way to verify this now.
set -euo pipefail

CHUNKS=".next/static/chunks"
[ -d "$CHUNKS" ] || { echo "✖ No build found. Run: pnpm build" >&2; exit 1; }

fail=0
note() { printf '  %-52s %s\n' "$1" "$2"; }

# The chunk shared by BOTH shells is identified by a string only the shells
# contain. A control participant definitely downloads this one.
SHARED=$(grep -rl "Time remaining" "$CHUNKS"/*.js 2>/dev/null || true)

if [ -z "$SHARED" ]; then
  echo "✖ Could not locate the shell chunk. Did the header markup change?" >&2
  echo "  Update the marker string in this script." >&2
  exit 1
fi

echo "Shell chunk (downloaded by BOTH groups): $(basename "$SHARED")"
echo

# Nothing in this list may appear in a chunk the control group downloads.
for marker in \
  'aria-valuenow' \
  'progressbar' \
  'Progress toward completion' \
  'answeredCount' \
  'totalCount' \
  'bg-emerald'
do
  if grep -q "$marker" "$SHARED"; then
    note "$marker" "PRESENT — BLINDING VIOLATION"
    fail=1
  else
    note "$marker" "absent ✓"
  fi
done

echo

# And the bar must still exist somewhere, in its own chunk — otherwise this
# script would "pass" simply because the treatment group lost its manipulation.
BAR=$(grep -rl "aria-valuenow" "$CHUNKS"/*.js 2>/dev/null || true)
if [ -z "$BAR" ]; then
  echo "✖ The progress bar is not in ANY chunk. The treatment group would see" >&2
  echo "  no manipulation at all." >&2
  exit 1
fi
echo "Progress bar isolated in: $(basename "$BAR")"

if [ "$fail" -ne 0 ]; then
  echo
  echo "✖ BLINDING CHECK FAILED — do not deploy." >&2
  echo "  A control participant could find progress information in devtools." >&2
  exit 1
fi

echo
echo "✔ Blinding verified: the control bundle contains no progress affordance."
