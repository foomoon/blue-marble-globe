#!/usr/bin/env bash
# Install or update the Blue Marble Globe map server from this bundle, with no internet needed.
#
#   ./install.sh [install folder]        default: /opt/blue-marble-globe
#
# Checks every file against SHA256SUMS, loads the map server image, unpacks the map data as a new
# release, points the server at it and (re)starts it. The previous release is kept, for going back.
# Needs: Docker with the compose plugin, and tar and sha256sum (standard on Linux).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
dest=${1:-/opt/blue-marble-globe}
version=$(cat "$here/VERSION")
say() { printf '\n== %s\n' "$*"; }

say "Checking the bundle's files (SHA256SUMS)"
(cd "$here" && sha256sum -c SHA256SUMS >/dev/null) || { echo "The bundle is damaged or incomplete: copy it again." >&2; exit 1; }
echo "all files intact"

say "Loading the map server image"
docker load -i "$here/images.tar"

say "Unpacking the map data: release $version"
mkdir -p "$dest/releases" "$dest/tls"
rm -rf "$dest"/releases/*.partial   # left by an install that was interrupted
rel="$dest/releases/$version"
if [ -d "$rel" ]; then echo "already unpacked: $rel"; else
  tmp="$rel.partial"; rm -rf "$tmp"; mkdir -p "$tmp"
  tar -xf "$here/data.tar" -C "$tmp"     # keeps the hard-linked duplicate tiles as links
  chmod -R a+rX "$tmp"                    # nginx (another user) must read everything
  mv "$tmp" "$rel"
fi
sed "s/__VERSION__/$version/" "$here/compose.yaml" > "$dest/compose.yaml.new"
mv "$dest/compose.yaml.new" "$dest/compose.yaml"
[ -f "$dest/.env" ] || printf 'HTTP_PORT=80\nHTTPS_PORT=443\n' > "$dest/.env"
ln -sfn "releases/$version" "$dest/current"

say "Starting the map server"
docker compose -f "$dest/compose.yaml" --project-directory "$dest" up -d --force-recreate --remove-orphans

# Keep the two newest releases (the one now running, and the one before, for going back)
ls -1d "$dest"/releases/*/ 2>/dev/null | sort | awk -v n="$(ls -1d "$dest"/releases/*/ | wc -l)" 'NR <= n - 2' | while read -r old; do
  echo "removing old release $(basename "$old")"; rm -rf "$old"
done

if [ -s "$dest/tls/server.crt" ] && [ -s "$dest/tls/server.key" ]; then
  echo; echo "Running release $version, over HTTPS. Open https://<this server's name>/globe/"
else
  echo; echo "Running release $version over plain HTTP: no certificate in $dest/tls/ yet (see README.txt, HTTPS)."
fi
