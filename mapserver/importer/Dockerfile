# The air-gapped map server's importer: the admin page's sign-in and its Import (region packs
# exported on the connected side). Python's standard library only; no GDAL, nothing is built here.
# Built by scripts/bundle.sh, from a context with these files:
#   import_server.py  region_pack.py  build_server.py  admin_login.py
FROM python:3.14.2-alpine3.23
COPY import_server.py region_pack.py build_server.py admin_login.py /app/
ENV RELEASE=/release AUTH_DIR=/auth MAPSERVER_AUTH_DIR=/auth PORT=8090 PYTHONDONTWRITEBYTECODE=1
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=3s CMD python3 -I -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/healthz', timeout=2)" || exit 1
CMD ["python3", "-I", "-u", "/app/import_server.py"]
