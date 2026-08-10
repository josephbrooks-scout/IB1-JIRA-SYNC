# IB1 Spec Differ

A small browser tool for comparing two IB1 specification versions. It parses generated HTML reports and IB1 XML locally in the browser, then displays the documents side by side in their familiar report layout with added, removed, and changed records highlighted in place.

## Who This Is For

Use this when a new IB1 spec version arrives and you want to review the differences instead of reading the whole document from the beginning.

The files are not uploaded to a server. They are read by the browser on the machine running the page.

## Supported Inputs

The comparator supports both IB1 source XML and generated IB1 HTML reports:

- XML files with an `IB-1` root element, usually ending in `.xml`.
- Generated IB1 HTML reports, usually ending in `.html` or `.htm`.

You can compare any supported pairing:

- XML against XML keeps the richest XML-level comparison, including REST request payload records.
- HTML against HTML keeps the generated report layout and compares the records visible in the report.
- XML against HTML uses a mixed-format comparison mode. In that mode, the app normalizes both files into shared IB1 records and compares only the facts both formats expose. XML-only details that do not exist in the generated HTML report are omitted from the mixed comparison instead of being reported as false removals.

More detail is available in [docs/comparison-behavior.md](docs/comparison-behavior.md).

## Requirements

- Node.js 20.19 or newer
- npm, included with Node.js

Check your versions:

```bash
node --version
npm --version
```

## First-Time Setup

From this folder:

```bash
npm install
npm run start
```

Open the URL printed by Vite. It is usually:

```text
http://localhost:5173/
```

Drop or select the old IB1 HTML/XML document as `Baseline spec` and the new IB1 HTML/XML document as `New version`.

## Demo Files

Two small XML demo files are included so colleagues can confirm the tool is working before using real specifications:

```text
samples/baseline.xml
samples/new-version.xml
```

Load those two files in the interface. You should see side-by-side documents with changed metadata, a changed block, a changed REST request, and an added objective highlighted.

## Daily Use

Run the local app:

```bash
npm run start
```

Then open:

```text
http://localhost:5173/
```

Useful controls in the app:

- `Search changes` filters by title, path, field names, and changed values.
- `All record types` filters to blocks, steps, REST requests, metadata, and other record groups.
- `All`, `Changed`, `Added`, and `Removed` focus the review list.
- Selecting a change scrolls the side-by-side document panes to the highlighted record when it exists in that document.
- `Export report` downloads a JSON summary of the current comparison.

The report includes the detected source format for each file. When XML and HTML are compared together, the exported JSON also includes `comparisonMode: "mixed"` and an `omittedFromMixedComparison` count for records that only one source format can represent.

## Share On The Office Network

The `start` script already exposes the app on the local network:

```bash
npm run start
```

Vite prints a `Network` URL if the machine allows network access. Colleagues on the same network can open that URL in their browser while the command keeps running.

If macOS asks whether Node.js can accept incoming network connections, allow it for this local demo use case.

## Build A Static Version

For a version that can be hosted on an internal static web server:

```bash
npm run build
```

The generated files are written to:

```text
dist/
```

To check the production build locally:

```bash
npm run serve
```

## Development Checks

Before sharing changes to the tool itself, run:

```bash
npm run lint
npm run build
```

## Troubleshooting

- If `npm install` fails, check that Node.js is version 20.19 or newer.
- If the browser page is blank, stop the terminal command with `Ctrl+C`, run `npm install`, then run `npm run start` again.
- If colleagues cannot open the network URL, check the macOS firewall and make sure they are on the same network.
- If an HTML file fails to load, confirm it is a generated IB1 report with section headings and procedure tables.
- If an XML file fails to load, confirm it is valid XML and that the root element is `IB-1`.
