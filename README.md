# IB1 Jira Tickets

Turns IB1 commissioning specifications (raw XML) into Jira tickets: an `Electronic Control Unit` ticket per ECU, a child ticket per block, and nested sub-task tickets for each step. The home page previews the tickets for an IB1 file, and `npm run jira:sync` writes them to Jira and keeps them up to date when new IB1 versions arrive.

A secondary page, `Compare IB1 versions` (`#/compare`), compares two IB1 specification versions side by side, with added, removed, and changed records highlighted in place. It reads generated HTML reports as well as XML.

## Who This Is For

Factory software integration: get IB1 commissioning content into Jira (project `PRDFSI`) without retyping it, and keep the tickets current when a new IB1 version arrives. Tickets follow the hierarchy: Vehicle/Traveller → `Electronic Control Unit` → `Commissioning Step` block → `Workaround` step sub-task.

The web page reads files locally in the browser; they are not uploaded to a server. Only `npm run jira:sync` talks to Jira, using your own API token.

## Sharing With Teammates

Preview/review website:
<https://josephbrooks-scout.github.io/IB1-JIRA-SYNC/>.
The website and source repository are publicly accessible.
It contains only the built application, not credentials, sample source documents, or Jira review reports.
Uploaded files are processed in the visitor's browser. The hosted website never asks for or stores Jira tokens.

Anyone can use the hosted XML preview and comparison without Jira credentials. To read or write Jira,
each teammate must run the CLI on their own computer with their own Jira email and API token:

```bash
git clone https://github.com/josephbrooks-scout/IB1-JIRA-SYNC.git
cd IB1-JIRA-SYNC
npm ci
cp .env.example .env
```

Repository access and Node.js 22.18 or newer are required. Edit the new `.env` locally:
set `JIRA_BASE_URL` to your Jira site, `JIRA_EMAIL` to your own account email,
and `JIRA_API_TOKEN` to a token created by that account.
Do not use another person's credentials. Jira permissions still control what each account can read or change.
No shared token, GitHub Actions Jira secret, or `VITE_` credential is needed.
`.env` is ignored by Git and is not loaded by Vite; the CLI loads it locally.
Environment variables already set in your shell take precedence over `.env`.

```bash
# On your own computer: read Jira and generate a review report; no Jira writes
npm run jira:sync -- path/to/IB1.xml --parent PRDFSI-150 --report review.json
```

Open the hosted website's **Review changes** page, load your local `review.json`,
review every item, and export approvals. Then, on the same computer:

```bash
npm run jira:sync -- path/to/IB1.xml --parent PRDFSI-150 --apply --approval-file path/to/ib1-jira-approvals.json
```

Use the same planning options for the report and apply commands. Keep reports and approvals private:
they can contain document and Jira content. If no required credentials are configured, the CLI stops
with an explicit missing-credentials error before contacting Jira. A static GitHub Pages site
does not provide direct Jira login or sync; those operations remain local to each user.

### Website Deployment

The [Pages workflow](.github/workflows/pages.yml) validates `main` and uploads only `dist/`
to GitHub Pages. Enable **Settings → Pages → Source: GitHub Actions** on GitHub.
It requires no Jira credentials or repository secrets. Every push to `main` redeploys the site.
Pages is enabled using GitHub Actions for this public repository. Private repository
Pages availability depends on the GitHub account plan.

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

The home page turns one IB1 XML into the Jira tickets it would create: an `Electronic Control Unit` parent, one `Commissioning Step` child per block, and one `Workaround` sub-task per IB1 step. Each step ticket is nested under its block ticket. The page itself sends nothing to Jira; you review the plan and can export it. Use `npm run jira:sync` (below) to write to Jira.

- Load the IB1 `.xml`. HTML reports are rejected because they lack the stable ids used to update tickets later.
- Follow **Load document → Preview tickets → Review changes**. The first two stages only preview the XML; the review stage requires a separate Jira dry-run report.
- Enter an `Existing ECU ticket (optional)` (for example `PRDFSI-150`) to attach the children to it; leave it blank to plan a new ECU ticket. Expand `Find this ECU in Jira` on the ECU card to see its lookup query.
- Expand **Advanced settings** to change the project, issue types, labels, or ticket structure. `Block + steps` is the default: a block ticket with separate nested step sub-tasks. `Block only` puts step details in the block description; `Step only` creates flat step tickets under the ECU.
- Expand **Download ticket plan** for `Export Jira CSV` (for the Jira Cloud CSV importer) or `Export JSON` (the full plan).

The interface uses the supplied Scout brand reference: Harvest Orange (`#FF5432`), Chalk (`#FAF9F5`), and Moonstone (`#131F26`). System sans-serif and monospace fonts are used until licensed Scout font files and a standalone wordmark asset are supplied; no Scout logo is recreated from the reference image. Added, changed, and removed items use distinct text labels and semantic colors as well as filter counts.

The same plan is available from the command line (needs Node.js 22.18 or newer, which runs TypeScript directly):

```bash
npm run jira:plan -- path/to/IB1_0044_EPS.xml --parent PRDFSI-150
npm run jira:plan -- path/to/IB1_0044_EPS.xml --parent PRDFSI-150 --label Mule --label VFF --format csv --out eps.csv
npm run jira:plan -- --help
```

How IB1 content maps to tickets is described in [docs/jira-ticket-mapping.md](docs/jira-ticket-mapping.md).

## Jira Sync (Writes To Jira)

`npm run jira:sync` compares an IB1 plan with Jira Cloud through the REST API. It is a **dry run by default**. Every proposed create, update, removal, or version refresh must be reviewed and checked off in the browser before the CLI will write anything.

One-time setup:

1. Create an API token at <https://id.atlassian.com/manage-profile/security/api-tokens> (ideally for a service account).
2. Copy `.env.example` to `.env` and fill in `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN`. The defaults use `Commissioning Step` for block tickets and `Workaround` for step sub-tasks; both issue types must be available in the Jira project. `.env` is git-ignored; never commit it.

```bash
# Generate a Jira comparison report (writes nothing to Jira)
npm run jira:sync -- path/to/IB1_0044_EPS.xml --parent PRDFSI-150 --report review.json
# Open http://localhost:5173/#/review, upload review.json, choose accept/keep/merge,
# check off every proposed change, then export ib1-jira-approvals.json.
# Apply only the reviewed decisions; stale Jira/source snapshots are rejected.
npm run jira:sync -- path/to/IB1_0044_EPS.xml --parent PRDFSI-150 --apply --approval-file ib1-jira-approvals.json
# A whole folder of IB1 files; each ECU ticket is found by its Diag Address
npm run jira:sync -- path/to/inbox --report review.json
npm run jira:sync -- --help
```

For each action, choose to accept the incoming change, keep the current Jira content, or manually edit a merged summary/description when available. Additions must be explicitly approved; removals must be explicitly approved to move the ticket to Not Relevant. The approval file is bound to the exact Jira/source review; rerun the dry run and review again if either changes. Direct `--apply` without a matching approval file is blocked.

The **Added / Changed / Removed** filters only change which actions are displayed; they do not approve or exclude changes. Review progress and approval export still cover every proposed change across all files, including actions hidden by a filter. Snapshot details are available in an expandable panel.

The browser review compares the proposed IB1 content with the current Jira content. Git branch baselines and conflict checks are not yet integrated. Exit code `2` means a plan is blocked or review is incomplete. The rules are in [docs/jira-ticket-mapping.md](docs/jira-ticket-mapping.md#sync-rules).

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
