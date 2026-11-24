#!/usr/bin/env python3
"""
Check that everything this project needs is installed, at versions that work.

  npm run doctor            (python3 scripts/doctor.py)
  npm run doctor -- --server   only what the map server needs (Python + Docker)

Prints one line per check and exits non-zero if a required one fails. Standard library only,
so it runs before anything else is installed.
"""

from __future__ import annotations

import json
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIN_GDAL = (3, 6)  # gdal2tiles WebP tiles, OSR StripVertical
MIN_PYTHON = (3, 11)
UBUNTU = Path("/etc/os-release").exists() and "ubuntu" in Path("/etc/os-release").read_text().lower()
MAC = platform.system() == "Darwin"

results = []  # (ok, required, name, detail, fix)


def check(name, ok, detail="", fix="", required=True):
    results.append((bool(ok), required, name, detail, fix))


def run(*cmd):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        return p.returncode, (p.stdout + p.stderr).strip()
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, str(e)


def install_hint(apt: str, brew: str) -> str:
    return f"sudo apt install {apt}" if UBUNTU else f"brew install {brew}" if MAC else f"install {apt}"


def main() -> None:
    server_only = "--server" in sys.argv

    # Python (every script)
    v = sys.version_info
    check("Python 3.11+", v[:2] >= MIN_PYTHON, platform.python_version(), install_hint("python3", "python"))

    # Docker (map server)
    docker = shutil.which("docker")
    code, out = run("docker", "compose", "version") if docker else (1, "")
    check("Docker + Compose", docker and code == 0, out.splitlines()[0] if code == 0 else "not found",
          install_hint("docker.io docker-compose-v2", "--cask docker"), required=server_only)
    if docker and code == 0:
        code, out = run("docker", "info", "--format", "{{.ServerVersion}}")
        check("Docker engine running", code == 0, out if code == 0 else "not running",
              "sudo systemctl enable --now docker; and add yourself to the docker group" if UBUNTU else "start Docker Desktop",
              required=server_only)

    if not server_only:
        # GDAL command-line tools (all tile builds)
        tools = ["gdalinfo", "gdalwarp", "gdalbuildvrt", "gdaladdo", "ogr2ogr", "gdal_rasterize"]
        missing = [t for t in tools if not shutil.which(t)]
        check("GDAL tools", not missing, "all present" if not missing else "missing " + ", ".join(missing),
              install_hint("gdal-bin", "gdal"))
        g2t = shutil.which("gdal2tiles") or shutil.which("gdal2tiles.py")
        check("gdal2tiles", g2t, g2t or "not found", install_hint("python3-gdal", "gdal"))
        if g2t:
            jpeg = run(g2t, "--tiledriver=JPEG", "--help")[0] == 0
            check("gdal2tiles writes JPEG", jpeg, "yes" if jpeg else "no (GDAL < 3.9): the Blue Marble build writes PNG "
                  "and converts each tile, adding a couple of minutes", "nothing needed; a GDAL 3.9+ is faster", required=False)
        code, out = run("gdalinfo", "--version")
        m = re.search(r"GDAL (\d+)\.(\d+)\.(\d+)", out)
        ver = tuple(int(x) for x in m.groups()) if m else (0, 0, 0)
        check(f"GDAL {MIN_GDAL[0]}.{MIN_GDAL[1]}+", ver[:2] >= MIN_GDAL, out.split(",")[0] if m else "unknown",
              "newer GDAL: sudo add-apt-repository ppa:ubuntugis/ubuntugis-unstable" if UBUNTU else install_hint("gdal-bin", "gdal"))
        code, out = run("gdalinfo", "--formats")
        check("GDAL WebP driver", "WEBP" in out, "present" if "WEBP" in out else "missing (Landsat regions and terrain need it)",
              "a GDAL built with libwebp (Ubuntu's and Homebrew's are)")

        # The project's venv: GDAL bindings + numpy (terrain and region builds)
        venv = ROOT / ".venv" / "bin" / "python"
        if not venv.exists():
            check(".venv", False, "not created", "python3 -m venv --system-site-packages .venv")
        else:
            probe = ("from osgeo import gdal, osr, gdal_array; import numpy, json; "
                     "s = osr.SpatialReference(); s.ImportFromEPSG(4326); s.StripVertical(); "
                     "d = gdal.GetDriverByName('MEM').Create('', 2, 2, 1); d.GetRasterBand(1).ReadAsArray(); "
                     "print(json.dumps([gdal.__version__, numpy.__version__]))")
            code, out = run(str(venv), "-c", probe)
            found = [ln for ln in out.splitlines() if ln.startswith("[")]  # (warnings may follow it)
            ok = code == 0 and found
            detail = "GDAL {} + numpy {}".format(*json.loads(found[0])) if ok else (out.splitlines() or ["failed"])[-1][:120]
            fix = ("recreate it with --system-site-packages, and use Ubuntu's python3-gdal and python3-numpy "
                   "(don't pip install numpy into it)") if UBUNTU else "see README, Higher-resolution regions: Before you start"
            check(".venv: GDAL bindings + numpy", ok, detail, fix)

        # Node and the npm packages (the app, dev server, tests)
        code, out = run("node", "--version")
        want = (ROOT / ".nvmrc").read_text().strip()
        major = re.match(r"v(\d+)", out)
        check(f"Node {want}", major and major.group(1) == want, out if code == 0 else "not found",
              "nvm install (reads .nvmrc). Just installed? Open a new terminal, or run: source ~/.nvm/nvm.sh")
        check("npm packages", (ROOT / "node_modules" / "cesium").exists() and (ROOT / "node_modules" / "vite").exists(),
              "installed" if (ROOT / "node_modules" / "cesium").exists() else "not installed", "npm ci")

    width = max(len(r[2]) for r in results)
    for ok, required, name, detail, fix in results:
        mark = "ok  " if ok else ("FAIL" if required else "warn")
        print(f"  {mark}  {name:<{width}}  {detail}" + ("" if ok else f"\n        fix: {fix}"))
    failed = [r for r in results if not r[0] and r[1]]
    print("\nAll required checks passed." if not failed else f"\n{len(failed)} required check(s) failed.")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
