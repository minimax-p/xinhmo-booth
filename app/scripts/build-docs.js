/**
 * Build the PDFs from their Markdown sources:  npm run docs
 *
 * Runs as a tiny Electron app with no window: each document is turned into
 * HTML with marked, styled like the booth itself (its navy ink, cream paper,
 * Didot headings and script wordmark), and printed to PDF by Chromium, so
 * fonts, tables and page breaks come out as they would in a browser.
 *
 * The Markdown files stay the source of truth. Edit them, then rebuild; never
 * edit a PDF.
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

// Paths below are relative to the booth folder, one level above app/.
const ROOT = path.join(__dirname, '..', '..');

// Staff documents sit at the top of the booth folder, next to the two
// launchers and nothing else, where they will be found. The emergency sheet
// goes in EMERGENCY/ with the update launchers it explains. Everything technical,
// sources included, stays inside app/.
const DOCS = [
  { src: 'app/docs/START-HERE.md', out: 'START-HERE.pdf', title: 'Start here', kind: 'For staff' },
  { src: 'app/docs/OPERATORS-GUIDE.md', out: 'OPERATORS-GUIDE.pdf', title: 'Staff guide', kind: 'For staff' },
  { src: 'app/docs/EMERGENCY.md', out: 'EMERGENCY/EMERGENCY.pdf', title: 'Emergency', kind: 'For staff' },
  { src: 'app/README.md', out: 'app/docs/Setup-and-technical-guide.pdf', title: 'Setup and technical guide', kind: 'Technical' },
  { src: 'app/docs/FLOW.md', out: 'app/docs/Session-flow.pdf', title: 'Session flow', kind: 'Technical' },
  { src: 'app/docs/UI-GUIDE.md', out: 'app/docs/Editing-the-screens.pdf', title: 'Editing the screens', kind: 'Technical' },
];

const CSS = `
  @page { size: Letter; margin: 0.75in 0.8in 0.85in; }
  :root {
    --ink: #26357e; --ink-deep: #16215a; --ink-soft: #6b77ae;
    --paper: #fff8ee; --paper-2: #f7ecd9; --line: rgba(38,53,126,.18); --seal: #8b0003;
  }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    margin: 0; color: #1e2340;
    font: 10.2pt/1.52 -apple-system, "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif;
  }

  /* The masthead: the booth's own wordmark and colours. */
  .mast {
    background: var(--ink); color: var(--paper); border-radius: 14px;
    padding: 22px 28px 20px; margin: 0 0 26px; position: relative; overflow: hidden;
  }
  .mast .brand { font: 34pt/1 "Snell Roundhand", "Apple Chancery", cursive; margin: 0; }
  .mast .title { font: 600 21pt/1.15 Didot, "Bodoni 72", Georgia, serif; margin: 10px 0 0; letter-spacing: .01em; }
  .mast .kind {
    position: absolute; top: 22px; right: 26px; font-size: 8pt; letter-spacing: .14em;
    text-transform: uppercase; color: var(--paper); opacity: .75;
    border: 1px solid rgba(255,248,238,.45); border-radius: 999px; padding: 4px 10px;
  }
  .mast .seal {
    position: absolute; right: -28px; bottom: -28px; width: 110px; height: 110px; border-radius: 50%;
    background: radial-gradient(circle at 40% 35%, #b3121a, var(--seal) 60%, #5c0002);
    opacity: .9;
  }

  /* The document's own # heading is replaced by the masthead. */
  .body > h1:first-child { display: none; }
  h1, h2, h3 { color: var(--ink); break-after: avoid; break-inside: avoid; }
  h2 + p, h3 + p { break-before: avoid; }
  h2 {
    font: 600 15pt/1.25 Didot, "Bodoni 72", Georgia, serif; margin: 22px 0 9px;
    padding-bottom: 6px; border-bottom: 1.5px solid var(--line);
  }
  h3 { font-size: 11.5pt; margin: 18px 0 6px; }
  p { margin: 0 0 9px; }
  a { color: var(--ink); }
  strong { color: var(--ink-deep); }

  ul, ol { margin: 0 0 10px; padding-left: 0; }
  li { margin: 0 0 7px; break-inside: avoid; }
  ul > li { list-style: none; position: relative; padding-left: 18px; }
  ul > li::before {
    content: ""; position: absolute; left: 3px; top: .62em; width: 6px; height: 6px;
    border-radius: 50%; background: var(--ink-soft);
  }
  /* Numbered steps get a navy disc, easy to follow with a finger. */
  ol { counter-reset: step; }
  ol > li { list-style: none; position: relative; padding-left: 34px; min-height: 22px; counter-increment: step; }
  /* Pinned inside its step, so no sliver of it is left behind at a page break. */
  ol > li::before {
    content: counter(step); position: absolute; left: 0; top: 0; width: 22px; height: 22px;
    border-radius: 50%; background: var(--ink); color: #fff; font: 700 9.5pt/22px -apple-system, Helvetica, sans-serif;
    text-align: center;
  }
  li > p { margin: 0 0 6px; }

  code {
    font: 9pt/1.4 "SF Mono", Menlo, monospace; background: var(--paper-2); color: var(--ink-deep);
    padding: 1px 5px; border-radius: 4px;
  }
  pre {
    background: #1d2a68; color: #f3eee3; border-radius: 10px; padding: 12px 16px;
    margin: 6px 0 12px; overflow: hidden; white-space: pre-wrap; word-break: break-word; break-inside: avoid;
  }
  pre code { background: none; color: inherit; padding: 0; font-size: 8.8pt; }

  table {
    width: 100%; border-collapse: separate; border-spacing: 0; margin: 8px 0 14px;
    border: 1px solid var(--line); border-radius: 10px; overflow: hidden; font-size: 9.6pt;
  }
  thead th {
    background: var(--ink); color: var(--paper); text-align: left; font-weight: 600;
    padding: 8px 12px; font-size: 9pt; letter-spacing: .02em;
  }
  td { padding: 7px 11px; vertical-align: top; border-top: 1px solid var(--line); }
  td code { white-space: nowrap; }
  th code { background: none; color: inherit; padding: 0; }
  tbody tr:nth-child(even) td { background: #fbf7f0; }
  tr { break-inside: avoid; }
  td:first-child { font-weight: 600; color: var(--ink-deep); }

  /* > Callouts: the things not to miss. */
  blockquote {
    margin: 10px 0 14px; padding: 12px 16px; background: var(--paper);
    border: 1px solid #ecdcc0; border-left: 5px solid var(--ink); border-radius: 8px; break-inside: avoid;
  }
  blockquote p:last-child { margin: 0; }
  /* An address split at its hyphen gets typed wrong. */
  blockquote code, p code, li code { white-space: nowrap; }

  hr { border: 0; border-top: 1px solid var(--line); margin: 20px 0; }
`;

function page(doc, markdown) {
  const body = marked.parse(markdown, { gfm: true });
  return `<!doctype html><html><head><meta charset="utf-8"><title>${doc.title}</title>
<style>${CSS}</style></head><body>
  <header class="mast">
    <span class="kind">${doc.kind}</span>
    <p class="brand">Xinhmo</p>
    <p class="title">${doc.title}</p>
    <span class="seal"></span>
  </header>
  <main class="body">${body}</main>
</body></html>`;
}

const FOOTER = (title) => `
  <div style="width:100%; font: 7.5pt -apple-system, Helvetica, sans-serif; color:#8a90b0;
              padding: 0 0.8in; display:flex; justify-content:space-between;">
    <span>Xinhmo booth &middot; ${title}</span>
    <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
  </div>`;

async function build(win, doc, n) {
  const src = path.join(ROOT, doc.src);
  const out = path.join(ROOT, doc.out);
  const html = page(doc, fs.readFileSync(src, 'utf8'));
  const tmp = path.join(app.getPath('temp'), `xinhmo-doc-${process.pid}-${n}.html`);
  fs.writeFileSync(tmp, html);

  await win.loadFile(tmp);
  const pdf = await win.webContents.printToPDF({
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: FOOTER(doc.title),
  });
  fs.rmSync(tmp, { force: true });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, pdf);
  console.log(`  ${doc.out.padEnd(38)} ${(pdf.length / 1024).toFixed(0)} KB`);
}

app.whenReady().then(async () => {
  // One hidden window for every document: making and destroying one each
  // time races Electron's own shutdown of the last.
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  let failed = 0;
  for (const [n, doc] of DOCS.entries()) {
    try {
      await build(win, doc, n);
    } catch (err) {
      failed++;
      console.error(`  ${doc.out}: ${err.message}`);
    }
  }
  app.exit(failed ? 1 : 0);
});
