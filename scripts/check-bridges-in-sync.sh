#!/usr/bin/env bash
# Verifies bridge1/ and bridge2/ hold IDENTICAL source.
#
# The two gate bridges are duplicated source in one repo, so nothing but this
# check stands between "edited one copy" and two gates running different code.
# Run it before every commit that touches a bridge, and in CI if there is one.
#
#   scripts/check-bridges-in-sync.sh          -> exit 0 in sync, 1 if drifted
#
# Per-gate state is expected to differ and is never compared: .env (this gate's
# identity, reader, port) and data/ (this gate's movement journal, cursor and
# sequence counters — copying it between gates double-counts in Nexus).
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for d in bridge1 bridge2; do
  [[ -d "$d" ]] || { echo "MISSING: $d/ does not exist" >&2; exit 1; }
done

OUT="$(diff -r bridge1 bridge2 \
  -x node_modules -x data -x data-test -x '.env' -x '*.log' \
  -x 'dist-reader' -x 'dist-printer' -x 'dist-printer.zip' 2>&1)"

if [[ -z "$OUT" ]]; then
  echo "IN SYNC: bridge1/ and bridge2/ source is identical."
  exit 0
fi

echo "DRIFTED: bridge1/ and bridge2/ are NOT identical." >&2
echo >&2
echo "$OUT" >&2
echo >&2
echo "Apply the change to BOTH copies before committing. To mirror bridge1 -> bridge2:" >&2
echo "  rsync -a --delete --exclude='.env' --exclude='data/' --exclude='node_modules/' bridge1/ bridge2/" >&2
exit 1
