# Blue Marble Globe map server: nginx serving the layers built by this project.
# The layers themselves are mounted at run time (see compose.yaml), not baked in,
# so a rebuilt layer is served without rebuilding the image.
FROM nginx:1.30.5-alpine
RUN rm /etc/nginx/conf.d/default.conf
# The config comes in pieces, put together at start-up by mapserver-config.sh: HTTPS when a
# certificate is mounted in /etc/nginx/tls/, the admin routes unless MAPSERVER_ADMIN=off
COPY http.conf site.conf admin.conf /etc/nginx/mapserver/
COPY mapserver-config.sh /docker-entrypoint.d/40-mapserver-config.sh
COPY cors.conf origin.conf sea-level.webp /etc/nginx/
EXPOSE 8080 8443
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
