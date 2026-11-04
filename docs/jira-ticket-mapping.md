# IB1 to Jira Ticket Mapping

This describes how the `Jira tickets` view and `npm run jira:plan` turn one IB1 XML into a Jira ticket plan. The browser planner is read-only. Jira writes through `npm run jira:sync` require a reviewed approval file.

Code: [src/jira/ib1JiraPlan.ts](../src/jira/ib1JiraPlan.ts) (mapping) and [src/jira/exporters.ts](../src/jira/exporters.ts) (Jira markup, CSV, JSON).

## Hierarchy

```text
Vehicle / Traveller ticket (e.g. PRDFSI-35)      not touched by the tool
└── Electronic Control Unit ticket (e.g. PRDFSI-150)   one per IB1 / ECU-ID
    └── Commissioning Step block ticket                one per BLOCK (default)
        └── Workaround step sub-task                    one per STEP / HMI-STEP
```

The PRDFSI project exposes `Commissioning Step` as a standard issue type and `Workaround` as a sub-task issue type. This lets Jira represent the IB1 parent/child relationship instead of placing block and step tickets as siblings. Configure alternative project issue types with `JIRA_CHILD_ISSUE_TYPE` and `JIRA_STEP_ISSUE_TYPE`; the step issue type must be a sub-task type.

## ECU ticket

| Source in IB1 XML | Ticket |
| --- | --- |
| `NAME` | Summary |
| `DIAG-INFOS/DIAG-INFO/ECU-ID` | `Diag Address` (`0044`) and `Diagnostic Address` (`0x0044`) |
| `DIAG-INFO` protocols, PDX/ODX, `IB-DESCRIPTION` objectives and slaves | Description |
| `version`, `RELEASE-DATE` | Description |

If the ECU ticket already exists, enter its key (`--parent PRDFSI-150` on the CLI); the plan then only adds children. The ECU card shows a JQL query to find it by `Diag Address`. Human-owned fields such as part numbers, supplier, or VFF status are never planned.

If no `ECU-ID` exists, the 4-character prefix of the IB1 name is used and a warning is shown.

## Child tickets

**Nested mode (default):** one `Commissioning Step` ticket per block, titled with the block name, and one `Workaround` sub-task per `STEP`/`HMI-STEP`, titled `[block name] step name`. The block description includes the ECU name and ID, IB1 source, block description and parameters, and a `Steps` overview table (#, Step, Action, Runs inside). Each step sub-task gets its own full step detail:

The ECU name comes from the matched ECU ticket's Jira **Summary** when syncing to an existing ECU; when creating a new ECU, it comes from the IB1 name.

- step type (diagnostic or HMI), action, the loop it runs inside, and whether it is cyclic;
- the step description, REST request with request body and expected output, diagnostic service and parameters, wait time, HMI parameters, and TIS;
- `Conditional handling` for branch content such as "Abort button actuated".

A change to a block updates the block ticket; a change to an individual step updates that step sub-task. Each ticket is independently reviewed before apply.

**Block-only mode (`--granularity block`):** steps are included in each block ticket description. **Step-only mode (`--granularity step`):** step tickets are flat children of the ECU, and blocks without steps become a single ticket.

Structure handling:

- Nested `GROUP` elements are traversed. Group names appear in each block's source fields and ticket path; every block across every procedure group is planned.
- `NAME_EN` is preferred over the German `NAME` for standard blocks.
- Blocks inside `SWITCH/CASE` get the case name appended: `[coding (LHD)] write coding`.
- `LOOP`s do not become tickets. Their inner steps do, with the loop name, poll interval and timeout in a `Runs inside` field.
- `BRANCH`/`IF`/`ELSEIF`/`ELSE` content (for example the generic "Abort button actuated" path) is listed under `Conditional handling` on the surrounding steps instead of becoming tickets.
- `VALUE-REF` references are resolved to the block parameter value, for example `2500 (block parameter "wait_after_reset")`.
- Repeated titles get a ` (2)` suffix and a warning.

Step descriptions include the IB1 source context, the step description, the REST method, URI and pretty-printed request body, the UDS service, DID and parameters table, wait times, HMI parameters, test instructions, and the sync key.

Labels: `ib1`, `ecu-<id>`, `ib1-step` or `ib1-block`, plus `standard-block`, `optional` and `hmi` where they apply, and any extra labels you enter.

## Sync key

Every planned ticket carries a key `ib1:<ECU-ID>:<element id>`, for example `ib1:0044:uuid_444ec0fa-...`. It is printed at the end of the description and exported as the `IB1 Key` CSV column.

The key is scoped by ECU because IB1 revision notes show UUIDs being copied between sibling IB1 documents. When an element has no `id`, a position-based key is used and the file is held for review, because such keys are not stable between versions.

## Sync rules

`npm run jira:sync` stores the key on each ticket it creates or adopts, as the hidden issue property `ib1.sync` (key, content hash, IB1 name and version). A dry-run report compares current Jira content with the incoming source and is reviewed in `#/review`. Re-running against the same or a newer IB1 compares by that key:

| Situation | What happens |
| --- | --- |
| New block | `Commissioning Step` ticket created under the ECU |
| New step | `Workaround` sub-task created under its block ticket |
| Content changed | Presented for review: accept incoming, keep current, or manually merge summary/description. Accepted changes reopen the ticket (or add `ib1-spec-changed`) |
| Only version or date changed | Presented for review; acceptance refreshes the hidden property without changing status |
| Same content | Nothing written |
| Step/block removed from the IB1 | Presented for review: accept to move to `Not Relevant` (or label `ib1-removed`), or keep the current ticket |
| Hand-made ticket with the same name | **Held** as a possible duplicate. With `--adopt`: linked to the IB1 key and left as is (status and summary untouched) |
| Ticket created from a different IB1 for the same ECU | Left untouched |
| ECU ticket created by this tool (`--create-ecu`) | Description refreshed on each new version of the same IB1 document. Hand-made ECU tickets are never edited |
| File older than the version already synced | Blocked, so an old file can never overwrite newer data |

The whole file is **blocked** (nothing is written) when: the ECU ticket is missing (unless `--create-ecu`) or ambiguous; the file is older than the version already synced; the plan has review warnings (missing/duplicate ids, no ECU-ID); hand-made tickets look like IB1 blocks/steps but do not match (try another `--granularity` with `--adopt`, or `--ignore-unmanaged`); a managed issue has the wrong Jira issue type or parent for the requested nesting; or more than `--max-updates` (default 25) tickets would be reopened. Existing flat tickets are not silently moved or converted; resolve migration blockers in Jira before syncing nested mode.

All proposed changes require an individual review choice and check-off. Merged descriptions are saved as user-reviewed content; the next source comparison will surface the difference again. The approval file is bound to the exact Jira/source snapshot and all files in a batch are validated before any write. After applying, a summary comment is added to the ECU ticket. Status names can be changed with `JIRA_REOPEN_STATUS` and `JIRA_REMOVED_STATUS`.

```bash
npm run jira:sync -- path/to/IB1.xml --parent PRDFSI-150 --report review.json
# Open http://localhost:5173/#/review and export approvals after checking off every change.
npm run jira:sync -- path/to/IB1.xml --parent PRDFSI-150 --apply --approval-file ib1-jira-approvals.json
```

Git branch baselines and conflict checks are not yet integrated; this review compares incoming IB1 content with Jira.

## CSV import

The CSV targets the Jira Cloud CSV importer:

- `Issue Id` / `Parent Id` link a new ECU row to its children in the same import.
- `Parent` holds the existing ECU key when one was given.
- `Labels` is repeated, one label per column.
- `Description` uses Jira wiki markup.
- `IB1 Key`: map it to a custom text field if one exists, or ignore it. The key also appears in the description.

Check `Child issue type` before importing. It defaults to `Commissioning Step` (the type used under ECU tickets in PRDFSI) and must match an issue type that is allowed under `Electronic Control Unit` in the project.

## Not yet covered

- Automatic intake (watching a mailbox, SharePoint or share folder) and scheduled runs in GitHub Actions, then Azure/AWS.
- Attaching the source IB1 file to the ECU ticket, and notifications.
- HTML-only inputs, because they have no stable ids.
