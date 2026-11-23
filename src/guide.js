// In-app guide: a button that opens a side panel showing the project's own docs.
// The panel renders docs/*.md directly, so the UI and the docs on disk can't drift apart.
import { Marked } from "marked";
import buildingTiles from "../docs/building-the-tiles.md?raw";
import addingLayer from "../docs/adding-a-map-layer.md?raw";
import "./guide.css";

const TABS = [
  { id: "tiles", label: "Build the map data", md: buildingTiles },
  { id: "layer", label: "Add layers in code", md: addingLayer },
];

// Links to repo files (../src/main.js, LICENSING.md) mean nothing in the browser,
// so show them as code. External links open in a new tab.
const marked = new Marked({
  renderer: {
    link({ href, tokens }) {
      const text = this.parser.parseInline(tokens);
      if (/^https?:\/\//.test(href)) {
        return `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
      }
      return `<code>${href.replace(/^(\.\.\/)+/, "")}</code>`;
    },
  },
});

export function mountGuide(parent = document.body) {
  const toggle = el("button", "guide-toggle", "Guide");
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", "guide-panel");

  const panel = el("aside", "guide-panel");
  panel.id = "guide-panel";
  panel.hidden = true;

  const header = el("header", "guide-header");
  const tabs = el("div", "guide-tabs");
  tabs.setAttribute("role", "tablist");
  const close = el("button", "guide-close", "×");
  close.setAttribute("aria-label", "Close guide");
  header.append(tabs, close);

  const body = el("div", "guide-body");
  body.setAttribute("role", "tabpanel");
  body.tabIndex = 0;
  panel.append(header, body);

  const buttons = TABS.map((tab) => {
    const b = el("button", "guide-tab", tab.label);
    b.setAttribute("role", "tab");
    b.addEventListener("click", () => show(tab.id));
    tabs.append(b);
    return b;
  });

  function show(id) {
    const i = TABS.findIndex((t) => t.id === id);
    buttons.forEach((b, j) => b.setAttribute("aria-selected", String(i === j)));
    body.innerHTML = marked.parse(TABS[i].md);
    body.scrollTop = 0;
    try { localStorage.setItem("guide-tab", id); } catch {}
  }

  function setOpen(open) {
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    if (open) body.focus();
  }

  toggle.addEventListener("click", () => setOpen(panel.hidden));
  close.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) setOpen(false);
  });

  let saved = null;
  try { saved = localStorage.getItem("guide-tab"); } catch {}
  show(TABS.some((t) => t.id === saved) ? saved : "tiles");
  parent.append(toggle, panel);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}
