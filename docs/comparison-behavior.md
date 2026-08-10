# Comparison Behavior

IB1 Spec Differ reads files locally in the browser and converts them into comparable records before calculating differences. The input files are not uploaded to a server.

## Same-Format Comparisons

### XML Against XML

XML inputs are parsed from the `IB-1` source structure. This gives the most complete comparison because the XML contains records that generated HTML reports may not display, such as REST request payloads and detailed nested procedure structure.

### HTML Against HTML

HTML inputs are parsed from generated IB1 report pages. The app preserves the original report markup for side-by-side viewing and anchors highlights directly into the visible report rows or sections.

## Mixed XML/HTML Comparisons

When one side is XML and the other side is HTML, the app uses mixed-format comparison mode.

Mixed mode normalizes both files into shared IB1 records such as metadata, contacts, revisions, objectives, diagnostics, environment conditions, production modes, procedures, cases, blocks, and steps. It also normalizes common report formatting differences, including generated HTML line breaks and German report column names.

Records and fields that only one format can represent are intentionally left out of the mixed comparison. For example, XML-only REST request payload records are not treated as removed just because the generated HTML report does not expose the payload content.

The exported report records this behavior with:

```json
{
  "comparisonMode": "mixed",
  "totals": {
    "omittedFromMixedComparison": 0
  }
}
```

The omitted count varies by file pair. It is informational and helps explain why the mixed-mode total can be lower than the full XML record count.

## Highlighting

For HTML files, highlights are applied inside the original generated report layout. For XML files, the app generates a readable document view from parsed XML records and highlights the corresponding generated sections.

If a changed record exists only in one side, only that side can be highlighted for that record.