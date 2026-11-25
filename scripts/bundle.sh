#!/usr/bin/env bash
# Make an offline bundle of the map server, to carry to a network without internet (air-gapped)
# and install there with its install.sh: serve-only, with the map data as built here.
#
#   npm run bundle                                 for linux/amd64 (most servers)
#   npm run bundle -- --platform linux/arm64       for ARM servers
#
# Writes bundles/blue-marble-globe-<UTC date and time>/ (not committed): the images (the map server,
# and its importer: the air-gapped admin page's sign-in and Import), the map data (tiles, vectors,
# the globe, provenance, the sign-in and Import pages), install.sh, add-regions.sh, set-password.sh,
# README.txt and SHA256SUMS. The admin login, the HTTPS key and the private CA's key are never
# included. Regions built later travel on their own, as region packs: npm run regions:export.
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

say "Building the images for $platform"
docker build -q --platform "$platform" -t "blue-marble-globe/mapserver:$version" mapserver
# The importer's build context: just its files (not the whole project, tiles and all)
ctx=$(mktemp -d); trap 'rm -rf "$ctx"' EXIT
cp mapserver/importer/Dockerfile mapserver/importer/import_server.py \
   scripts/region_pack.py scripts/build_server.py scripts/admin_login.py "$ctx/"
docker build -q --platform "$platform" -t "blue-marble-globe/importer:$version" "$ctx"
for image in mapserver importer; do
  arch=$(docker image inspect -f '{{.Os}}/{{.Architecture}}' "blue-marble-globe/$image:$version")
  [ "$arch" = "$platform" ] || { echo "$image: built $arch, expected $platform" >&2; exit 1; }
done

mkdir -p "$out"
say "Saving the images"
docker save -o "$out/images.tar" "blue-marble-globe/mapserver:$version" "blue-marble-globe/importer:$version"
docker image rm -f "blue-marble-globe/mapserver:$version" "blue-marble-globe/importer:$version" >/dev/null   # not needed here

say "Packing the map data"
# No macOS metadata files in the archive; hard-linked duplicate tiles stay links
mac=(); [ "$(uname)" = Darwin ] && mac=(--no-mac-metadata)
COPYFILE_DISABLE=1 tar "${mac[@]}" --exclude .DS_Store -cf "$out/data.tar" \
  -C mapserver www globe login import -C ../public tiles vectors -C .. provenance LICENSING.md NOTICE

cp mapserver/airgap/compose.yaml mapserver/airgap/install.sh mapserver/airgap/README.txt \
   mapserver/airgap/add-regions.sh mapserver/airgap/set-password.sh "$out/"
[ -s mapserver/tls/ca.crt ] && cp mapserver/tls/ca.crt "$out/"   # public: for devices to trust
echo "$version" > "$out/VERSION"
# Readable by whoever installs it (docker save writes images.tar for its owner only)
chmod 644 "$out"/*; chmod 755 "$out"/*.sh
(cd "$out" && find . -type f ! -name SHA256SUMS | sed 's|^\./||' | sort | xargs shasum -a 256 > SHA256SUMS)

say "Bundle ready: $out"
du -sh "$out"/* | sed 's|bundles/[^/]*/||'
echo
echo "Copy the whole folder across, then on the server: ./install.sh   (see README.txt)"
