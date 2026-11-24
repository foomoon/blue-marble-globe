# The map server's builder: runs Landsat region builds for the admin page (/admin/), and the API
# behind it (server/admin-api.js). nginx (the mapserver container) passes /api/ to it, behind the
# admin password; this container isn't published on any port.
#
# GDAL, Python and numpy from OSGeo's official image, pinned to the release the project is built
# with (the same as on the Mac); Node copied from the official Node image.
FROM node:26.13.1-bookworm-slim AS node

FROM ghcr.io/osgeo/gdal:ubuntu-small-3.13.3
# Node's Linux build needs libatomic, which this image doesn't include
RUN apt-get update \
 && apt-get install -y --no-install-recommends libatomic1 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node

# The project is mounted at /project (compose.yaml): code read-only, data folders writable
WORKDIR /project
ENV PROJECT_ROOT=/project \
    STUDIO_PYTHON=python3 \
    PORT=8090 \
    HOME=/tmp \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s \
  CMD node -e "fetch('http://127.0.0.1:8090/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "server/admin-api.js"]
