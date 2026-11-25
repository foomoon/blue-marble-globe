#!/usr/bin/env bash
# Add regions to this map server from region packs: files exported on the connected side (the
# admin page's Regions panel, Export; or npm run regions:export). The same as the admin page's
# Import, for large packs or when there's no browser at hand.
#
#   ./add-regions.sh regions-kauai-20261124-163000.tar [more packs...]
#
# Each pack is checked in full (every file's checksum) before anything changes. Its regions go
# in beside the others, or replace their own older builds; the server keeps running.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
[ $# -ge 1 ] || { echo "usage: ./add-regions.sh <region pack.tar> [more...]" >&2; exit 1; }
[ -e "$here/current" ] || { echo "No map server installed in $here: run the bundle's install.sh first." >&2; exit 1; }

for pack in "$@"; do
  [ -f "$pack" ] || { echo "no such file: $pack" >&2; exit 1; }
  abs="$(cd "$(dirname "$pack")" && pwd)/$(basename "$pack")"
  echo "== $(basename "$pack")"
  docker compose -f "$here/compose.yaml" --project-directory "$here" run --rm -T --no-deps \
    -v "$abs:/in/pack.tar:ro" importer python3 -I /app/region_pack.py import /in/pack.tar --release /release
done
echo
echo "Done: the new regions are on the globe (reload the page)."
