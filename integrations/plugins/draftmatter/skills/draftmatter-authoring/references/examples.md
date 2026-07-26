# DraftMatter request examples

Replace revisions and returned references with values from inspection. Omit
`protocolVersion` and `domain` when the selected MCP tool already supplies
them.

## Tracked rewrite

```json
{
  "action": "suggest",
  "mode": "suggest",
  "expectedRevision": "sha256:<inspection>",
  "idempotencyKey": "rewrite-introduction-claim-001",
  "actor": {"id":"agent:writer","name":"Local assistant"},
  "selector": {
    "kind": "quote",
    "quote": "The original sentence.",
    "prefix": "Previous sentence. "
  },
  "proposal": "The more precise sentence.",
  "rationale": "State the condition explicitly."
}
```

## Figure computation

```json
{
  "action": "create",
  "mode": "apply",
  "expectedRevision": "sha256:<inspection>",
  "idempotencyKey": "create-treatment-figure-001",
  "actor": {"id":"agent:analyst","name":"Local assistant"},
  "language": "python",
  "role": "figure",
  "source": "figure = plot_treatment_response(data)\nfigure.savefig(DRAFTMATTER_OUTPUT_PATH)",
  "selector": {"kind":"section-label","label":"sec-results"},
  "placement": "end",
  "caption": "Treatment response through time.",
  "alt": "Two treatment lines diverge after week four."
}
```

Run the returned cell reference under the latest revision:

```json
{
  "action": "run",
  "reference": "cell:<returned>",
  "expectedRevision": "sha256:<latest>",
  "idempotencyKey": "run-treatment-figure-001",
  "actor": {"id":"agent:analyst","name":"Local assistant"},
  "timeoutMs": 120000
}
```

Inspect the returned logs, hashes, environment, durable manifest path, and
`artifact:` reference. When the client supports images, inspect the MCP image
content before claiming the figure is correct.

## Table and named values

Create a `table` or `values` computation without identities:

```json
{
  "action": "create",
  "mode": "apply",
  "expectedRevision": "sha256:<inspection>",
  "idempotencyKey": "create-model-summary-001",
  "actor": {"id":"agent:analyst","name":"Local assistant"},
  "language": "r",
  "role": "table",
  "source": "summary <- publish_model_summary(fit)\nwrite.csv(summary, DRAFTMATTER_OUTPUT_PATH, row.names = FALSE)",
  "selector": {"kind":"heading","text":"Results"},
  "placement": "end",
  "caption": "Model estimates.",
  "publishedValues": ["sample_size", "mean_response"]
}
```

After a successful inspected run, insert a value semantically:

```json
{
  "action": "mutate",
  "mode": "apply",
  "expectedRevision": "sha256:<latest>",
  "idempotencyKey": "insert-sample-size-001",
  "actor": {"id":"agent:writer","name":"Local assistant"},
  "mutation": {
    "kind": "published-value",
    "operation": "insert",
    "selector": {"kind":"quote","quote":"The study included "},
    "placement": "after",
    "name": "sample_size"
  }
}
```

## Authoritative citation

Search first:

```json
{
  "action": "search",
  "query": "10.1016/j.envsoft.2019.104609",
  "sources": ["project", "zotero", "crossref"],
  "allowNetwork": true
}
```

Then add and cite the returned candidate:

```json
{
  "action": "add-and-cite",
  "mode": "apply",
  "expectedRevision": "sha256:<inspection>",
  "idempotencyKey": "cite-method-source-001",
  "actor": {"id":"agent:writer","name":"Local assistant"},
  "candidate": "citation-candidate:<returned>",
  "selector": {"kind":"quote","quote":"The model was calibrated."},
  "placement": "before",
  "locator": "p. 18"
}
```

## Final validation

```json
{"action":"publication"}
```

Do not claim readiness unless `ready` is true and no blocking diagnostic
remains.
