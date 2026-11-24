#!/usr/bin/env bash
# Make an offline bundle of the map server, to carry to a network without internet (air-gapped)
# and install there with its install.sh: serve-only, with the map data as built here.
#
#   npm run bundle                                 for linux/amd64 (most servers)
#   npm run bundle -- --platform linux/arm64       for ARM servers
#
# Writes bundles/blue-marble-globe-<UTC date and time>/ (not committed): the map server image, the
# map data (tiles, vectors, the globe, provenance), install.sh, README.txt and SHA256SUMS. The
# admin login, the HTTPS key and the private CA's key are never included.
set -euo pipefail
cd "$(dirname "$0")/.."
platform=linux/amd64
while [ $# -gt 0 ]; do
  case "$1" in
    --platform) platform=$2; shift 2 ;;
    *) echo "usage: npm run bundle [-- --platform linux/amd64|linux/arm64]" >&2; exit 1 ;;
  esac
done
version=$(date -u +%Y%m%d-%H%M%S)
out=bundles/blue-marble-globe-$version
say() { printf '\n== %s\n' "$*"; }
[ -s public/tiles/blue-marble-webp/PROVENANCE.json ] || { echo "No Blue Marble tiles yet: run npm run maps first." >&2; exit 1; }

say "Refreshing the catalog and building the globe"
python3 -I scripts/build_server.py >/dev/null
npm run -s server:globe >/dev/null

say "Building the map server image for $platform"
docker build -q --platform "$platform" -t "blue-marble-globe/mapserver:$version" mapserver
arch=$(docker image inspect -f '{{.Os}}/{{.Architecture}}' "blue-marble-globe/mapserver:$version")
[ "$arch" = "$platform" ] || { echo "built $arch, expected $platform" >&2; exit 1; }

mkdir -p "$out"
say "Saving the image"
docker save -o "$out/images.tar" "blue-marble-globe/mapserver:$version"
docker image rm -f "blue-marble-globe/mapserver:$version" >/dev/null   # not needed here

say "Packing the map data"
# No macOS metadata files in the archive; hard-linked duplicate tiles stay links
mac=(); [ "$(uname)" = Darwin ] && mac=(--no-mac-metadata)
COPYFILE_DISABLE=1 tar "${mac[@]}" --exclude .DS_Store -cf "$out/data.tar" \
  -C mapserver www globe -C ../public tiles vectors -C .. provenance LICENSING.md NOTICE

cp mapserver/airgap/compose.yaml mapserver/airgap/install.sh mapserver/airgap/README.txt "$out/"
[ -s mapserver/tls/ca.crt ] && cp mapserver/tls/ca.crt "$out/"   # public: for devices to trust
echo "$version" > "$out/VERSION"
(cd "$out" && find . -type f ! -name SHA256SUMS | sed 's|^\./||' | sort | xargs shasum -a 256 > SHA256SUMS)

say "Bundle ready: $out"
du -sh "$out"/* | sed 's|bundles/[^/]*/||'
echo
echo "Copy the whole folder across, then on the server: ./install.sh   (see README.txt)"
