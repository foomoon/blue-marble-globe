#!/usr/bin/env python3
"""
Region packs: built regions in one file, to carry from the connected side to an air-gapped map
server that doesn't have them yet (or has an older build of them).

  python3 scripts/region_pack.py export kauai maui              -> bundles/regions-kauai-maui-<UTC>.tar
  python3 scripts/region_pack.py export kauai -o kauai.tar      (or --stdout: what the admin page uses)
  python3 region_pack.py import PACK --release DIR              on the air-gapped server (add-regions.sh,
                                                                or the admin page's Import)
  python3 region_pack.py carry --from OLD --release NEW         install.sh: keep imported regions that a
                                                                new full bundle doesn't have

A pack is a plain tar (the tiles are WebP: compressing gains nothing):
  region-pack.json                    first: format, the regions, and the SHA-256 of every file
  tiles/landsat/<name>/...            the region's imagery tiles, terrain/ and PROVENANCE.json
  provenance/regions/<name>.json      its build record

Importing only adds: each region's folder goes in beside the others (replacing that region's own
older build, if there is one), then the regions list (tiles/landsat/index.json) and the catalog
(www/) are rewritten from what's actually on that server. Nothing else is touched, and the
server keeps running. A pack is checked in full (paths, file types, every checksum) in a staging
folder before anything is moved into place. Standard library only.
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import io
import json
import os
import re
import secrets
import shutil
import sys
import tarfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # build_server.py, beside this file
import build_server  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = "region-pack.json"
FORMAT = "blue-marble-globe/region-pack"
NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")  # as the admin page allows (server/studio-api.js)


class PackError(Exception):
    """The pack can't be imported: the message says why, for the person importing it."""


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


# ---------------------------------------------------------------- export

def region_files(name: str, root: Path = ROOT) -> list[tuple[Path, str]]:
    """(file on disk, path in the pack) for one built region."""
    tiles = root / "public" / "tiles" / "landsat" / name
    record = root / "provenance" / "regions" / f"{name}.json"
    if not NAME.match(name):
        raise PackError(f"not a region name: {name!r}")
    if not (tiles / "PROVENANCE.json").exists() or not record.exists():
        raise PackError(f"{name}: not built here (no tiles/landsat/{name}/PROVENANCE.json)")
    out = [(p, f"tiles/landsat/{name}/{p.relative_to(tiles).as_posix()}")
           for p in sorted(tiles.rglob("*")) if p.is_file() and not p.is_symlink()]
    return out + [(record, f"provenance/regions/{name}.json")]


def export(names: list[str], out, root: Path = ROOT) -> dict:
    """Write a pack of the named regions to the binary stream out. Returns its manifest."""
    if not names:
        raise PackError("name at least one region")
    files = [f for n in dict.fromkeys(names) for f in region_files(n, root)]
    regions = []
    for n in dict.fromkeys(names):
        rec = json.loads((root / "public" / "tiles" / "landsat" / n / "PROVENANCE.json").read_text())
        regions.append({"name": n, "title": rec["region"].get("title", n), "built_utc": rec["built_utc"],
                        "tile_count": rec["output"]["tile_count"]})
    manifest = {
        "format": FORMAT, "format_version": 1,
        "created_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "regions": regions,
        "bytes": sum(p.stat().st_size for p, _ in files),
        "files": {arc: sha256(p) for p, arc in files},
    }

    def tidy(ti: tarfile.TarInfo) -> tarfile.TarInfo:
        ti.uid = ti.gid = 0
        ti.uname = ti.gname = ""
        ti.mode = 0o755 if ti.isdir() else 0o644
        return ti

    with tarfile.open(fileobj=out, mode="w|", format=tarfile.PAX_FORMAT) as tar:
        data = (json.dumps(manifest, indent=2) + "\n").encode()
        ti = tidy(tarfile.TarInfo(MANIFEST))
        ti.size, ti.mtime = len(data), int(dt.datetime.now().timestamp())
        tar.addfile(ti, io.BytesIO(data))
        for p, arc in files:  # hard-linked duplicate tiles go in once, the rest as links
            tar.add(p, arcname=arc, recursive=False, filter=tidy)
    return manifest


def default_name(names: list[str]) -> str:
    shown = "-".join(names[:3]) + (f"-and-{len(names) - 3}-more" if len(names) > 3 else "")
    return f"regions-{shown}-{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d-%H%M%S')}.tar"


# ---------------------------------------------------------------- import

def read_manifest(tar: tarfile.TarFile) -> dict:
    first = tar.next()
    if first is None or first.name != MANIFEST or not first.isfile() or first.size > 64 << 20:
        raise PackError("not a region pack (it should start with region-pack.json): "
                        "export one from the admin page's Regions panel")
    try:
        m = json.loads(tar.extractfile(first).read())
    except (ValueError, UnicodeDecodeError):
        raise PackError("region-pack.json is damaged") from None
    if m.get("format") != FORMAT:
        raise PackError("not a region pack (unknown format)")
    if m.get("format_version") != 1:
        raise PackError(f"region pack format {m.get('format_version')} is newer than this server knows: "
                        "install a newer full bundle first")
    names = [r.get("name") for r in m.get("regions") or []]
    if not names or not all(isinstance(n, str) and NAME.match(n) for n in names) or len(set(names)) != len(names):
        raise PackError("region-pack.json lists no regions, or a bad region name")
    if not isinstance(m.get("files"), dict):
        raise PackError("region-pack.json has no file list")
    return m


def allowed(path: str, names: list[str]) -> bool:
    parts = path.split("/")
    if path.startswith("/") or any(p in ("", ".", "..") for p in parts):
        return False
    if len(parts) == 3 and parts[:2] == ["provenance", "regions"]:
        return parts[2] in {f"{n}.json" for n in names}
    return len(parts) >= 3 and parts[:2] == ["tiles", "landsat"] and parts[2] in names


def check_members(tar: tarfile.TarFile, m: dict) -> list[tarfile.TarInfo]:
    """Every member: an expected path and a plain file, folder or hard link. Nothing else gets in."""
    names = [r["name"] for r in m["regions"]]
    members, seen = [], set()
    for ti in tar:
        if ti.name == MANIFEST and ti.offset == 0:
            continue  # read already (read_manifest)
        if not allowed(ti.name, names):
            raise PackError(f"unexpected file in the pack: {ti.name}")
        if ti.islnk():
            if not allowed(ti.linkname, names) or ti.linkname not in seen:
                raise PackError(f"bad link in the pack: {ti.name}")
        elif not (ti.isfile() or ti.isdir()):
            raise PackError(f"not a plain file: {ti.name}")
        if ti.isfile() or ti.islnk():
            seen.add(ti.name)
        members.append(ti)
    listed = set(m["files"])
    if seen != listed:
        missing, extra = sorted(listed - seen), sorted(seen - listed)
        raise PackError("the pack is incomplete or damaged: " +
                        (f"missing {missing[0]}" if missing else f"unlisted {extra[0]}") +
                        (f" (and {len(missing) + len(extra) - 1} more)" if len(missing) + len(extra) > 1 else ""))
    for n in names:
        for need in (f"tiles/landsat/{n}/PROVENANCE.json", f"provenance/regions/{n}.json"):
            if need not in listed:
                raise PackError(f"{n}: the pack has no {need}")
    return members


def readable(root: Path) -> None:
    """nginx runs as another user: folders 755, files 644."""
    for dirpath, dirs, files in os.walk(root):
        os.chmod(dirpath, 0o755)
        for f in files:
            os.chmod(os.path.join(dirpath, f), 0o644)


class Lock:
    """One import at a time (the admin page, add-regions.sh and install.sh may all try)."""

    def __init__(self, release: Path):
        self.path = release / ".import.lock"

    def __enter__(self):
        self.f = open(self.path, "w")
        try:
            fcntl.flock(self.f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.f.close()
            raise PackError("another import is running: try again when it's finished") from None
        return self

    def __exit__(self, *exc):
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


def reindex(release: Path) -> list[str]:
    """Rewrite the regions list and the catalog from the regions actually in this release."""
    build_server.use_release(release)
    index = build_server.regions_index()
    build_server.write_atomic(release / "tiles" / "landsat" / "index.json", json.dumps(index, indent=2) + "\n")
    build_server.generate()
    return [r["name"] for r in index["regions"]]


def import_pack(pack: Path, release: Path, log=print) -> dict:
    """Check the pack in full, then add its regions to the release. Raises PackError."""
    release = Path(release).resolve()
    if not (release / "tiles").is_dir() or not (release / "www").is_dir():
        raise PackError(f"{release} isn't an installed map server release (no tiles/ or www/)")
    with Lock(release):
        staging = release / ".import-tmp" / secrets.token_hex(6)
        staging.mkdir(parents=True)
        try:
            try:
                with tarfile.open(pack, "r:") as tar:
                    m = read_manifest(tar)
                    members = check_members(tar, m)
                    names = [r["name"] for r in m["regions"]]
                    log(f"checking {len(m['files']):,} files for {', '.join(names)}")
                    tar.extractall(staging / "new", members=members, filter="data")
            except tarfile.TarError as e:
                raise PackError(f"the pack is damaged or not a tar file ({e})") from None
            for arc, want in m["files"].items():
                if sha256(staging / "new" / arc) != want:
                    raise PackError(f"checksum mismatch: {arc} (the file was damaged on the way: copy it again)")
            for n in names:
                rec = json.loads((staging / "new" / "tiles" / "landsat" / n / "PROVENANCE.json").read_text())
                if not isinstance(rec.get("region", {}).get("bbox"), list):
                    raise PackError(f"{n}: its PROVENANCE.json isn't a region build record")
            readable(staging / "new")

            have = {p.parent.name for p in (release / "tiles" / "landsat").glob("*/PROVENANCE.json")}
            (release / "tiles" / "landsat").mkdir(parents=True, exist_ok=True)
            (release / "provenance" / "regions").mkdir(parents=True, exist_ok=True)
            for n in names:  # each region swaps in whole: a rename, on the same disk
                target = release / "tiles" / "landsat" / n
                if target.exists():
                    os.rename(target, staging / f"old-{n}")
                os.rename(staging / "new" / "tiles" / "landsat" / n, target)
                os.replace(staging / "new" / "provenance" / "regions" / f"{n}.json",
                           release / "provenance" / "regions" / f"{n}.json")
            now = reindex(release)
        finally:
            shutil.rmtree(staging, ignore_errors=True)
    added = [n for n in names if n not in have]
    replaced = [n for n in names if n in have]
    return {"added": added, "replaced": replaced, "regions": now,
            "files": len(m["files"]), "bytes": m.get("bytes")}


def carry(old: Path, release: Path, log=print) -> list[str]:
    """Copy regions that are in the old release but not the new one (imported there, not built on
    the connected side), so installing a new full bundle doesn't drop them."""
    old, release = Path(old), Path(release)
    have = {p.parent.name for p in (release / "tiles" / "landsat").glob("*/PROVENANCE.json")}
    moved = []
    for prov in sorted((old / "tiles" / "landsat").glob("*/PROVENANCE.json")):
        n = prov.parent.name
        record = old / "provenance" / "regions" / f"{n}.json"
        if n in have or not NAME.match(n) or not record.exists():
            continue
        shutil.copytree(prov.parent, release / "tiles" / "landsat" / n, symlinks=False)
        (release / "provenance" / "regions").mkdir(parents=True, exist_ok=True)
        shutil.copy2(record, release / "provenance" / "regions" / f"{n}.json")
        readable(release / "tiles" / "landsat" / n)
        moved.append(n)
    if moved:
        log(f"kept {len(moved)} region(s) imported on this server: {', '.join(moved)}")
        reindex(release)
    return moved


# ---------------------------------------------------------------- command line

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("export", help="pack built regions into one file")
    e.add_argument("names", nargs="+")
    e.add_argument("-o", "--output", type=Path)
    e.add_argument("--stdout", action="store_true", help="write the pack to standard output")
    i = sub.add_parser("import", help="add a pack's regions to an installed release")
    i.add_argument("pack", type=Path)
    i.add_argument("--release", type=Path, required=True)
    c = sub.add_parser("carry", help="copy imported regions from an old release into a new one")
    c.add_argument("--from", dest="old", type=Path, required=True)
    c.add_argument("--release", type=Path, required=True)
    a = ap.parse_args()

    try:
        if a.cmd == "export":
            names = [n for arg in a.names for n in arg.split(",") if n]
            if a.stdout:
                export(names, sys.stdout.buffer)
                return
            out = a.output or ROOT / "bundles" / default_name(names)
            out.parent.mkdir(parents=True, exist_ok=True)
            tmp = out.with_name(out.name + ".partial")
            with open(tmp, "wb") as f:
                m = export(names, f)
            os.replace(tmp, out)
            shown = out.relative_to(ROOT) if out.is_relative_to(ROOT) else out
            print(f"{shown}: {', '.join(r['name'] for r in m['regions'])}, "
                  f"{len(m['files']):,} files, {out.stat().st_size / 1e6:,.1f} MB")
            print("Carry it across, then on the server: ./add-regions.sh <file>, or the admin page's Import.")
        elif a.cmd == "import":
            r = import_pack(a.pack, a.release)
            if r["added"]:
                print(f"added: {', '.join(r['added'])}")
            if r["replaced"]:
                print(f"replaced with the new build: {', '.join(r['replaced'])}")
            print(f"this server now has {len(r['regions'])} region(s): {', '.join(r['regions']) or 'none'}")
        else:
            carry(a.old, a.release)
    except PackError as err:
        sys.exit(f"region pack: {err}")


if __name__ == "__main__":
    main()
