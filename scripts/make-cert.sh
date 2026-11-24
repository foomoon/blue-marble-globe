#!/usr/bin/env bash
# HTTPS certificate for the map server, from a private certificate authority (CA) of the project's
# own: for a network without one (e.g. air-gapped). Each device using the map server must trust
# the CA once (mapserver/tls/ca.crt: see docs/map-server.md, "HTTPS").
#
#   npm run server:cert -- maps.example.internal 10.20.0.5     (names and/or IP addresses)
#
# Writes mapserver/tls/server.crt and server.key (what nginx uses) and ca.crt (to give to devices).
# The CA's own key stays in mapserver/ca/: keep it safe and off the air-gapped network; it's needed
# only to issue the next certificate. Neither folder is committed.
#
# Have a certificate from your network's own CA instead? Put it in mapserver/tls/ as server.crt
# (with any intermediate certificates after it) and server.key, and skip this script.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v openssl >/dev/null || { echo "Needs openssl." >&2; exit 1; }
[ $# -ge 1 ] || { echo "usage: npm run server:cert -- <name or IP> [more names or IPs...]" >&2; exit 1; }

CA=${MAPSERVER_CA_DIR:-mapserver/ca} TLS=${MAPSERVER_TLS_DIR:-mapserver/tls}   # (other folders: for tests)
mkdir -p "$CA" "$TLS"; chmod 700 "$CA"

# Subject alternative names: every argument, plus localhost for checks on the server itself
san="DNS:localhost,IP:127.0.0.1"
for n in "$@"; do
  if [[ "$n" =~ ^[0-9]+(\.[0-9]+){3}$ || "$n" == *:* ]]; then san="$san,IP:$n"
  elif [[ "$n" =~ ^[A-Za-z0-9*]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then san="$san,DNS:$n"
  else echo "Not a host name or IP address: $n" >&2; exit 1; fi
done

if [ ! -s "$CA/ca.key" ]; then
  echo "Creating the private CA ($CA/): valid 10 years"
  (umask 077; openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$CA/ca.key")
  openssl req -x509 -new -key "$CA/ca.key" -sha256 -days 3650 -out "$CA/ca.crt" \
    -subj "/CN=Blue Marble Globe private CA/O=Blue Marble Globe" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"
else
  echo "Using the existing private CA ($CA/)"
fi

# Server certificate: 825 days, the most Apple devices accept from a private CA
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
(umask 077; openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$tmp/server.key")
openssl req -new -key "$tmp/server.key" -subj "/CN=$1" -out "$tmp/server.csr"
cat > "$tmp/ext" <<EXT
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=$san
EXT
openssl x509 -req -in "$tmp/server.csr" -CA "$CA/ca.crt" -CAkey "$CA/ca.key" -CAcreateserial \
  -days 825 -sha256 -extfile "$tmp/ext" -out "$tmp/server.crt" 2>/dev/null
install -m 644 "$tmp/server.crt" "$TLS/server.crt"
install -m 600 "$tmp/server.key" "$TLS/server.key"   # nginx reads it as root, at start-up
install -m 644 "$CA/ca.crt" "$TLS/ca.crt"
echo "Certificate for: ${san//,/, }"
echo "  $TLS/server.crt, server.key   used by the map server (restart it: npm run server:up)"
echo "  $TLS/ca.crt                   give to each device to trust (see docs/map-server.md, HTTPS)"
openssl x509 -in "$TLS/server.crt" -noout -enddate | sed 's/notAfter=/  valid until /'
