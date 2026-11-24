#!/usr/bin/env python3
"""
Store identical tiles once: replace each duplicate with a hard link to one copy.

  python3 scripts/dedupe_tiles.py public/tiles/grey [more folders...]

Every tile stays an ordinary file at its usual path, so the globe, the map server and anything
else reading them see no difference; the disk just keeps one copy of each distinct tile. Grey is
the case it's for: most of its zoom-9 tiles are the same solid grey square inland, and every small
file takes a whole disk block (about 4 KB), so 132 MB of tiles took ~590 MB on disk.

Safe to re-run (already-linked files are skipped). Copying the tiles elsewhere keeps the saving
only if the copy preserves hard links: rsync -H, cp -a, tar.

Standard library only.
"""

from __future__ import annotations

import hashlib
import os
import sys
from collections import defaultdict
from pathlib import Path

TILE_SUFFIXES = {".png", ".jpg", ".webp"}


def disk_bytes(root: Path) -> int:
    """Bytes the files under root take on disk, counting each hard-linked file once."""
    seen, total = set(), 0
    for p in root.rglob("*"):
        if p.is_file():
            st = p.stat()
            if (st.st_dev, st.st_ino) not in seen:
                seen.add((st.st_dev, st.st_ino))
                total += st.st_blocks * 512
    return total


def dedupe(root: Path) -> dict:
    """Hard-link identical tiles under root to one copy. Returns counts and bytes on disk."""
    before = disk_bytes(root)
    by_size = defaultdict(list)
    for p in root.rglob("*"):
        if p.suffix in TILE_SUFFIXES and p.is_file():
            by_size[p.stat().st_size].append(p)
    files = sum(len(v) for v in by_size.values())
    linked = 0
    for paths in by_size.values():
        if len(paths) < 2:
            continue  # a unique size can't have a duplicate
        by_hash = defaultdict(list)
        for p in paths:
            by_hash[hashlib.sha256(p.read_bytes()).hexdigest()].append(p)
        for same in by_hash.values():
            keep = same[0].stat()
            for p in same[1:]:
                st = p.stat()
                if (st.st_dev, st.st_ino) == (keep.st_dev, keep.st_ino):
                    continue  # already linked
                tmp = p.with_name(p.name + ".link")
                os.link(same[0], tmp)
                os.replace(tmp, p)  # atomic: readers see the old or the new file, never neither
                linked += 1
    unique = len({(p.stat().st_dev, p.stat().st_ino) for v in by_size.values() for p in v})
    return {"files": files, "unique": unique, "newly_linked": linked,
            "disk_before": before, "disk_after": disk_bytes(root)}


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__.strip().splitlines()[2])
    for arg in sys.argv[1:]:
        r = dedupe(Path(arg))
        print(f"{arg}: {r['files']:,} tiles, {r['unique']:,} distinct; linked {r['newly_linked']:,} duplicates; "
              f"on disk {r['disk_before'] / 1e6:,.0f} MB -> {r['disk_after'] / 1e6:,.0f} MB")


if __name__ == "__main__":
    main()
