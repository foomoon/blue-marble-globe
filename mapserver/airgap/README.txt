Blue Marble Globe map server: offline bundle
============================================

This bundle runs the map server on a network without internet: the globe at /globe/, and the map
layers for other web maps at /. Nothing is built here (builds need the internet). New regions
built on the connected side come across as region packs, small files you import (below), or
with the next full bundle.

Contents
  install.sh      installs or updates the server from this bundle
  add-regions.sh  imports region packs (install.sh copies it to the install folder)
  set-password.sh sets the admin page's sign-in (copied there too)
  images.tar      the Docker images: the map server (nginx) and its importer (Python)
  data.tar        the map data: tiles, vectors, the globe, provenance, the sign-in and Import pages
  compose.yaml    how the server runs (install.sh copies it)
  ca.crt          the private CA's certificate, if the bundle was made with one (see HTTPS)
  SHA256SUMS      checksums of all of the above; install.sh checks them first
  VERSION         this release's name

Install or update (on the server; needs Docker with compose, run as a user allowed to use Docker)
  ./install.sh                          into /opt/blue-marble-globe
  ./install.sh /srv/blue-marble-globe   or another folder

  Each install unpacks a new release next to the previous one and switches to it. Regions you
  imported here (below) that the new bundle doesn't have are kept. To go back:
  point the "current" link at the older folder in releases/, and change the image version in
  compose.yaml to match its name, then: docker compose -f <folder>/compose.yaml up -d --force-recreate

Ports: 80 (HTTP) and 443 (HTTPS). To change them, edit .env in the install folder, then run
install.sh again (or docker compose ... up -d). Run install.sh as the user who should own the
install folder (one allowed to use Docker), not root: the importer runs as that user.

Adding regions: region packs
  On the connected side, export built regions: the admin page's Regions panel, "Export for
  another server" (tick them, download one .tar), or npm run regions:export -- kauai,maui.
  Carry the file across, then either:

  - the admin page: https://<this server's name>/admin/ (the Admin pill on the globe). Sign in,
    drop the file on the page. Set the sign-in once first, on the server: ./set-password.sh
    (in the install folder). It's this server's own login, not the connected side's.
  - or on the server: ./add-regions.sh regions-kauai-....tar   (in the install folder)

  Every file is checked (SHA-256) before anything changes; a damaged or altered pack is refused.
  The regions go in beside the others, or replace their own older builds. Nothing else changes,
  the server keeps running, and the globe shows them on the next page load.
  No admin page at all (serve-only): put ADMIN=off in .env, then run install.sh again.

HTTPS
  Put the server's certificate and key in <install folder>/tls/ as server.crt and server.key,
  then run install.sh again. Plain HTTP then redirects to HTTPS. Two ways to get them:

  - From this network's own certificate authority, if it has one: ask for a certificate for the
    server's name (and IP address). Put any intermediate certificates after it in server.crt.
  - From the project's private CA, on the connected side: npm run server:cert -- <name> <IP>
    makes mapserver/tls/server.crt and server.key; carry those two files across once (they're not
    in the bundle). Each device must then trust ca.crt (below).

Names: hosts file (no DNS server needed)
  On each device, add a line with the server's IP address and name, for example:
      10.20.0.5   maps.example.internal
  Linux and macOS: /etc/hosts.  Windows: C:\Windows\System32\drivers\etc\hosts (as administrator).
  The name must be one the certificate was made for.

Trusting the private CA (ca.crt) on each device, once
  macOS:    sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ca.crt
  Windows:  certutil -addstore -f Root ca.crt   (as administrator)
  Ubuntu:   sudo cp ca.crt /usr/local/share/ca-certificates/blue-marble-globe.crt && sudo update-ca-certificates
  Firefox keeps its own list: Settings > Privacy & Security > Certificates > View Certificates >
  Authorities > Import.
