# IB1 Jira Tickets

Turns IB1 commissioning specifications (raw XML) into Jira tickets: an `Electronic Control Unit` ticket per ECU with one child ticket per step or block. The home page previews the tickets for an IB1 file, and `npm run jira:sync` writes them to Jira and keeps them up to date when new IB1 versions arrive.

A secondary page, `Compare IB1 versions` (`#/compare`), compares two IB1 specification versions side by side, with added, removed, and changed records highlighted in place. It reads generated HTML reports as well as XML.

## Who This Is For

Factory software integration: get IB1 commissioning content into Jira (project `PRDFSI`) without retyping it, and keep the tickets current when a new IB1 version arrives. Tickets follow the existing hierarchy: Vehicle/Traveller → `Electronic Control Unit` → `Commissioning Step`.

The web page reads files locally in the browser; they are not uploaded to a server. Only `npm run jira:sync` talks to Jira, using your own API token.

## Requirements

- Node.js 22.18 or newer (the command-line tools run TypeScript directly)
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

The home page is the Jira ticket preview. For writing to Jira, also follow the one-time setup under [Jira Sync](#jira-sync-writes-to-jira).

## Jira Ticket Preview (Dry Run)

The home page turns one IB1 XML into the Jira tickets it would create: an `Electronic Control Unit` parent plus one child ticket per step (or per block). The page itself sends nothing to Jira; you review the plan and can export it. Use `npm run jira:sync` (below) to write to Jira.

- Load the IB1 `.xml`. HTML reports are rejected because they lack the stable ids used to update tickets later.
- Enter an `Existing ECU ticket` (for example `PRDFSI-150`) to attach the children to it; leave it blank to plan a new ECU ticket. The JQL shown on the ECU card finds an existing one.
- `One ticket per` switches between `Step` (default) and `Block`. Blocks without steps, such as most standard blocks, always become one ticket.
- `Export Jira CSV` produces a file for the Jira Cloud CSV importer; `Export JSON` saves the full plan.

The same plan is available from the command line (needs Node.js 22.18 or newer, which runs TypeScript directly):

```bash
npm run jira:plan -- path/to/IB1_0044_EPS.xml --parent PRDFSI-150
npm run jira:plan -- path/to/IB1_0044_EPS.xml --parent PRDFSI-150 --label Mule --label VFF --format csv --out eps.csv
npm run jira:plan -- --help
```

How IB1 content maps to tickets is described in [docs/jira-ticket-mapping.md](docs/jira-ticket-mapping.md).

## Jira Sync (Writes To Jira)

`npm run jira:sync` sends the same plan to Jira Cloud through the REST API. It is a **dry run by default**: it reads Jira, prints what it would do, and writes nothing until you add `--apply`.

One-time setup:

1. Create an API token at <https://id.atlassian.com/manage-profile/security/api-tokens> (ideally for a service account).
2. Copy `.env.example` to `.env` and fill in `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN`. `.env` is git-ignored; never commit it.

```bash
# Preview against the existing EPS ECU ticket, linking hand-made tickets with matching names
npm run jira:sync -- path/to/IB1_0044_EPS.xml --parent PRDFSI-150 --granularity block --adopt
# Same, but write to Jira
npm run jira:sync -- path/to/IB1_0044_EPS.xml --parent PRDFSI-150 --granularity block --adopt --apply
# A whole folder of IB1 files; each ECU ticket is found by its Diag Address
npm run jira:sync -- path/to/inbox --apply --report ib1-sync-report.json
npm run jira:sync -- --help
```

To try the sync safely, `samples/jira-test/` holds a made-up IB1 for a fake ECU 0099 in several versions (2.0 to 2.3). Run `test-ecu-v2.0.xml` with `--create-ecu --apply`, then the later versions with `--parent <new ECU key> --apply`, and delete the test tickets afterwards.

Routine changes are applied automatically; risky ones are held or block the file. Exit code `2` means something needs a person to look at it. The rules are in [docs/jira-ticket-mapping.md](docs/jira-ticket-mapping.md#sync-rules).

## Compare IB1 Versions (Secondary Page)

`Compare IB1 versions` (link at the top right, or `http://localhost:5173/#/compare`) shows two IB1 specification versions side by side with added, removed, and changed records highlighted in place. Drop the old document as `Baseline spec` and the new one as `New version`.

### Supported Inputs

The comparison supports both IB1 source XML and generated IB1 HTML reports:

- XML files with an `IB-1` root element, usually ending in `.xml`.
- Generated IB1 HTML reports, usually ending in `.html` or `.htm`.

You can compare any supported pairing:

- XML against XML keeps the richest XML-level comparison, including REST request payload records.
- HTML against HTML keeps the generated report layout and compares the records visible in the report.
- XML against HTML uses a mixed-format comparison mode. In that mode, the app normalizes both files into shared IB1 records and compares only the facts both formats expose. XML-only details that do not exist in the generated HTML report are omitted from the mixed comparison instead of being reported as false removals.

More detail is available in [docs/comparison-behavior.md](docs/comparison-behavior.md).

### Demo Files

Two small XML demo files are included to confirm the page works before using real specifications:

```text
samples/baseline.xml
samples/new-version.xml
```

Open `Compare IB1 versions` (top right) and load those two files. You should see side-by-side documents with changed metadata, a changed block, a changed REST request, and an added objective highlighted.

### Controls

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
npm test
npm run build
```

## Troubleshooting

- If `npm install` fails, check that Node.js is version 22.18 or newer.
- If the browser page is blank, stop the terminal command with `Ctrl+C`, run `npm install`, then run `npm run start` again.
- If colleagues cannot open the network URL, check the macOS firewall and make sure they are on the same network.
- If an HTML file fails to load, confirm it is a generated IB1 report with section headings and procedure tables.
- If an XML file fails to load, confirm it is valid XML and that the root element is `IB-1`.
