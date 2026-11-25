#!/bin/sh
# Assemble the map server's nginx config at start-up (nginx's image runs /docker-entrypoint.d/*.sh
# before nginx), from the pieces in /etc/nginx/mapserver/:
#
#   HTTPS   on when /etc/nginx/tls/server.crt and server.key exist (mounted from mapserver/tls/:
#           npm run server:cert, or your own CA's). Then port 8080 only redirects to HTTPS
#           (and answers /healthz); MAPSERVER_HTTPS_PORT is the port browsers are sent to (443).
#   Admin   MAPSERVER_ADMIN: on (default) the admin page, sign-in and API, handled by the builder
#           container; import: the same, handled by the importer (an air-gapped server: its admin
#           page is the Import page); off: none of it, serve-only.
set -eu
D=/etc/nginx/mapserver
OUT=/etc/nginx/conf.d/mapserver.conf
CRT=/etc/nginx/tls/server.crt
KEY=/etc/nginx/tls/server.key
HTTPS_PORT=${MAPSERVER_HTTPS_PORT:-443}

ADMIN=${MAPSERVER_ADMIN:-on}
case "$ADMIN" in
  on) admin="    set \$mapserver_backend builder:8090;
    include $D/admin.conf;" ;;
  import) admin="    set \$mapserver_backend importer:8090;
    include $D/admin.conf;" ;;
  off) admin="" ;;
  *) echo "mapserver: MAPSERVER_ADMIN must be on, import or off (got '$ADMIN')" >&2; exit 1 ;;
esac

{
  echo "# Generated at start-up by mapserver-config.sh: edit the pieces in $D instead."
  echo "include $D/http.conf;"
  if [ -s "$CRT" ] && [ -s "$KEY" ]; then
    suffix=""; [ "$HTTPS_PORT" = 443 ] || suffix=":$HTTPS_PORT"
    cat <<CONF
server {
    listen 8080;
    server_name _;
    server_tokens off;
    location = /healthz {
        access_log off;
        default_type text/plain;
        return 200 "ok\n";
    }
    location / {
        return 301 https://\$host$suffix\$request_uri;
    }
}
server {
    listen 8443 ssl;
    http2 on;
    server_name _;
    ssl_certificate $CRT;
    ssl_certificate_key $KEY;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:tls:4m;
    include $D/site.conf;
$admin
}
CONF
    echo "mapserver: HTTPS on (port 8443 in the container), HTTP redirects to it; admin $ADMIN" >&2
  else
    cat <<CONF
server {
    listen 8080;
    server_name _;
    include $D/site.conf;
$admin
}
CONF
    echo "mapserver: HTTP only (no certificate in mapserver/tls/); admin $ADMIN" >&2
  fi
} > "$OUT"
