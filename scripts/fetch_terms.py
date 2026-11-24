#!/usr/bin/env python3
"""
Archive the pages that set the usage terms for the map data (NASA, Natural Earth, NOAA).

Writes, for each page:
  provenance/terms/raw/<name>.html   the page exactly as served (the evidence)
  provenance/terms/<name>.md         its main text as readable Markdown
  provenance/terms/terms.json        URL, retrieval time, HTTP Last-Modified, SHA-256

Re-run it to refresh the snapshot. Git history then shows exactly when and how
NASA's wording changed.

Standard library only:  python3 scripts/fetch_terms.py
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import re
import sys
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

PAGES = [
    {
        "name": "nasa-images-and-media-guidelines",
        "title": "NASA Images and Media Usage Guidelines",
        "url": "https://www.nasa.gov/nasa-brand-center/images-and-media/",
        "why": "NASA-wide terms: copyright status, permission, endorsement, logos",
    },
    {
        "name": "nasa-blue-marble-next-generation",
        "title": "NASA Earth Observatory: Blue Marble Next Generation",
        "url": "https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/",
        "why": "Dataset page: producer and the requested credit line",
    },
    {
        "name": "natural-earth-terms-of-use",
        "title": "Natural Earth: Terms of Use",
        "url": "https://www.naturalearthdata.com/about/terms-of-use/",
        "why": "Licence for the country-border vector layer (public domain)",
        "container_id": "content",  # this site has no <main>; its text is in <div id="content">
    },
    {
        "name": "noaa-etopo-2022-metadata",
        "title": "NOAA NCEI: ETOPO 2022 15 Arc-Second Global Relief Model, dataset metadata",
        "url": "https://data.noaa.gov/metaview/page?xml=NOAA/NESDIS/NGDC/MGG/DEM//iso/xml/etopo_2022.xml"
               "&view=getDataView&header=none",
        "why": "Licence for the terrain: not subject to copyright, CC0 worldwide; the requested citation",
        "container_id": "content",
    },
    {
        "name": "noaa-etopo-2022",
        "title": "NOAA NCEI: ETOPO Global Relief Model",
        "url": "https://www.ncei.noaa.gov/products/etopo-global-relief-model",
        "why": "Product page for the terrain source: versions, downloads and the citation",
        "container_id": "block-ncei-content",
    },
]

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "provenance" / "terms"


class MainText(HTMLParser):
    """Collect the text inside <main> (or the element with a given id) as simple Markdown."""

    BLOCK = {"p", "div", "section", "article", "br", "tr", "table", "ul", "ol", "figure", "blockquote"}
    SKIP = {"script", "style", "svg", "noscript", "button", "form", "nav", "iframe"}

    def __init__(self, container_id: str | None = None) -> None:
        super().__init__(convert_charrefs=True)
        self.container_id = container_id
        self.container_tag = "main"
        self.in_main = 0
        self.skip = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag, attrs):
        if self.in_main and tag == self.container_tag:
            self.in_main += 1  # nested element of the same kind
        elif not self.in_main and (
            (self.container_id and dict(attrs).get("id") == self.container_id)
            or (not self.container_id and tag == "main")
        ):
            self.container_tag = tag
            self.in_main = 1
            return
        if not self.in_main:
            return
        if tag in self.SKIP:
            self.skip += 1
        elif self.skip:
            return
        elif re.fullmatch(r"h[1-6]", tag):
            self.parts.append("\n\n" + "#" * min(int(tag[1]) + 1, 6) + " ")
        elif tag == "li":
            self.parts.append("\n- ")
        elif tag in self.BLOCK:
            self.parts.append("\n\n")

    def handle_endtag(self, tag):
        if not self.in_main:
            return
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
        elif not self.skip and (re.fullmatch(r"h[1-6]", tag) or tag in self.BLOCK):
            self.parts.append("\n\n")
        if tag == self.container_tag:
            self.in_main -= 1

    def handle_data(self, data):
        if self.in_main and not self.skip:
            self.parts.append(re.sub(r"\s+", " ", data))

    def markdown(self) -> str:
        text = "".join(self.parts)
        lines = [ln.strip() for ln in text.splitlines()]
        text = "\n".join(lines)
        text = re.sub(r"\n{3,}", "\n\n", text)
        text = re.sub(r"^(#+|-)\s*$\n?", "", text, flags=re.M)  # empty headings / bullets
        return text.strip() + "\n"


def main() -> None:
    """Archive every page, or only the ones named on the command line (others keep their record)."""
    only = set(sys.argv[1:])
    unknown = only - {p["name"] for p in PAGES}
    if unknown:
        sys.exit(f"unknown page(s): {', '.join(sorted(unknown))}")
    (OUT / "raw").mkdir(parents=True, exist_ok=True)
    previous = {}
    if (OUT / "terms.json").exists():
        previous = {p["name"]: p for p in json.loads((OUT / "terms.json").read_text())["pages"]}
    record = []
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    for page in PAGES:
        if only and page["name"] not in only:
            if page["name"] in previous:
                record.append(previous[page["name"]])
            continue
        req = urllib.request.Request(page["url"], headers={"User-Agent": "blue-marble-globe/1.0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            final_url = r.geturl()
            last_modified = r.headers.get("Last-Modified")
        digest = hashlib.sha256(raw).hexdigest()
        (OUT / "raw" / f"{page['name']}.html").write_bytes(raw)

        parser = MainText(page.get("container_id"))
        parser.feed(raw.decode("utf-8", errors="replace"))
        header = (
            f"<!--\n"
            f"  Archived copy of {final_url}\n"
            f"  Retrieved {now}. The text below is extracted from the page's "
            f"{'element #' + page['container_id'] if page.get('container_id') else '<main> element'}.\n"
            f"  Exact page as served: raw/{page['name']}.html (sha256 {digest})\n"
            f"  Reproduced here as a record of the terms relied on.\n"
            f"-->\n\n"
            f"# {page['title']}\n\n"
            f"> Source: <{final_url}>  \n"
            f"> Retrieved: {now}\n\n"
        )
        (OUT / f"{page['name']}.md").write_text(header + parser.markdown())

        record.append({
            "name": page["name"],
            "title": page["title"],
            "why": page["why"],
            "url": page["url"],
            "final_url": final_url,
            "retrieved_utc": now,
            "http_last_modified": last_modified,
            "raw_file": f"raw/{page['name']}.html",
            "raw_sha256": digest,
            "text_file": f"{page['name']}.md",
        })
        print(f"saved {page['name']}  sha256 {digest[:16]}...")

    (OUT / "terms.json").write_text(json.dumps({"pages": record}, indent=2) + "\n")
    print(f"Recorded {len(record)} pages in {(OUT / 'terms.json').relative_to(ROOT)}")


if __name__ == "__main__":
    main()
