/**
 * Renders the Mermaid sources in docs/diagrams/*.mmd to light and dark PNGs.
 *
 * The documentation embeds the images instead of Mermaid blocks, so the diagrams look the same in
 * every Markdown viewer. Needs a local Chrome or Edge and network access to load Mermaid.
 *
 *   pnpm diagrams
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "diagrams");
const MERMAID = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js";
const THEMES = { "": "default", "-dark": "dark" };
const SCALE = 2;

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><script src="${MERMAID}"></script>
<style>html, body { margin: 0; background: transparent; } #out { display: inline-block; padding: 8px; }</style>
</head><body><div id="out"></div></body></html>`;

async function launch() {
  for (const channel of ["chrome", "msedge"]) {
    try {
      return await chromium.launch({ channel });
    } catch {
      // Try the next installed browser.
    }
  }
  throw new Error("Neither Chrome nor Edge could be started");
}

const browser = await launch();
const page = await browser.newPage({ deviceScaleFactor: SCALE, viewport: { width: 1800, height: 1400 } });
await page.setContent(PAGE);
await page.waitForFunction(() => window.mermaid !== undefined);

const sources = fs
  .readdirSync(directory)
  .filter((file) => file.endsWith(".mmd"))
  .sort();
for (const file of sources) {
  const source = fs.readFileSync(path.join(directory, file), "utf8");
  for (const [suffix, theme] of Object.entries(THEMES)) {
    const width = await page.evaluate(
      async ([definition, themeName]) => {
        window.mermaid.initialize({
          startOnLoad: false,
          theme: themeName,
          fontFamily: "Segoe UI, Helvetica, Arial, sans-serif",
          flowchart: { useMaxWidth: false, subGraphTitleMargin: { top: 6, bottom: 14 } },
          sequence: { useMaxWidth: false },
        });
        const { svg } = await window.mermaid.render(`diagram${Date.now()}`, definition);
        const out = document.getElementById("out");
        out.innerHTML = svg;
        return Math.ceil(out.getBoundingClientRect().width);
      },
      [source, theme],
    );
    const target = path.join(directory, `${path.basename(file, ".mmd")}${suffix}.png`);
    await page.locator("#out").screenshot({ path: target, omitBackground: true });
    console.log(`docs/diagrams/${path.basename(target)}  ${width}px`);
  }
}

await browser.close();
