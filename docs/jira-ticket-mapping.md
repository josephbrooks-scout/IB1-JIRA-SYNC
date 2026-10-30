# IB1 to Jira Ticket Mapping

This describes how the `Jira tickets` view and `npm run jira:plan` turn one IB1 XML into a Jira ticket plan. The current version is a **dry run**: it previews tickets and exports CSV/JSON but never writes to Jira.

Code: [src/jira/ib1JiraPlan.ts](../src/jira/ib1JiraPlan.ts) (mapping) and [src/jira/exporters.ts](../src/jira/exporters.ts) (Jira markup, CSV, JSON).

## Hierarchy

```text
Vehicle / Traveller ticket (e.g. PRDFSI-35)      not touched by the tool
└── Electronic Control Unit ticket (e.g. PRDFSI-150)   one per IB1 / ECU-ID
    ├── [block] step ticket                           one per STEP / HMI-STEP (step mode)
    └── block ticket                                  blocks without steps, or every block in block mode
```

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

**Step mode (default):** each `STEP` and `HMI-STEP` becomes a ticket titled `[block name] step name`. Blocks with no steps, which covers most standard blocks, become a single ticket titled with the block name.

**Block mode:** one ticket per block, with a steps table in the description. This matches how some existing PRDFSI children are named (for example `reset_of_all_adaptions`).

Structure handling:

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

`npm run jira:sync` stores the key on each ticket it creates or adopts, as the hidden issue property `ib1.sync` (key, content hash, IB1 name and version). Re-running against the same or a newer IB1 compares by that key:

| Situation | What happens |
| --- | --- |
| New step/block | Ticket created under the ECU ticket |
| Content changed | Summary/description updated, ticket moved back to `Open` with a comment. If the workflow has no way back to `Open`, the label `ib1-spec-changed` is added instead |
| Only version or date changed | Hidden property refreshed; no notification, no status change |
| Same content | Nothing written |
| Step/block removed from the IB1 | **Held.** With `--allow-removals`: moved to `Not Relevant` (or labeled `ib1-removed`) with a comment |
| Hand-made ticket with the same name | **Held** as a possible duplicate. With `--adopt`: linked to the IB1 key and left as is (status and summary untouched) |
| Ticket created from a different IB1 for the same ECU | Left untouched |
| ECU ticket created by this tool (`--create-ecu`) | Description refreshed on each new version of the same IB1 document. Hand-made ECU tickets are never edited |
| File older than the version already synced | Blocked, so an old file can never overwrite newer data |

The whole file is **blocked** (nothing is written) when: the ECU ticket is missing (unless `--create-ecu`) or ambiguous; the file is older than the version already synced; the plan has review warnings (missing/duplicate ids, no ECU-ID); hand-made tickets look like IB1 blocks/steps but do not match (try the other `--granularity` with `--adopt`, or `--ignore-unmanaged`); or more than `--max-updates` (default 25) tickets would be reopened.

After applying, a summary comment is added to the ECU ticket. Status names can be changed with `JIRA_REOPEN_STATUS` and `JIRA_REMOVED_STATUS`.

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
