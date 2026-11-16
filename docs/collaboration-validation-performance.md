# Collaboration validation — local performance, 16 November 2026

The reusable isolated validator preserves the validation-before-persistence-before-
integration boundary while removing the full Yjs reconstruction from ordinary
accepted edits. The final local ten-client workload converged and matched reloaded
persisted state in every run. These measurements qualify this local code path;
they do not qualify the Marseille VPS or the complete deployment stack.

## Reproduce

From the checkout, after `npm ci`, run:

```sh
npm run benchmark:collaboration -- \
  --runs=3 --samples=100 --rounds=15 \
  --baseline-revision=497d12008e7101595be18437e371a67827ffe410 \
  --output=/tmp/collaboration-validation.json
```

The runner builds temporary Node bundles without changing the checkout. For the
reference bundle, a Vite loader reads only `hocuspocusServer.ts` from the specified
Git revision; its dependencies and the workload are identical to the new bundle.
Without `--baseline-revision`, reference mode uses the retained reconstruction
validator with current security hardening. That mode is useful for differential
checks, but is not byte-identical to the historical implementation.

Each case runs in a fresh process. Modes run in alternating order across three
repetitions. Raw per-run results and environment metadata are retained in
[the measurement JSON](benchmarks/collaboration-validation-local-2026-11-16.json).
The host was an Apple M3 Max, 14 logical CPUs, 36 GiB RAM, macOS arm64, Node
24.10.0. Heavy repository tests were paused during the measurements; the machine
was not an otherwise controlled laboratory or a CPU-limited VPS emulator.

## Workload and measurement boundaries

| Fixture | Manuscript | Figures | Bibliography | Review history | Encoded Yjs state |
| --- | ---: | --- | ---: | --- | ---: |
| Article | 40 KiB | 2 × 128 KiB SVG | 50 citations | 50 threads, 250 messages, 25 proposals, 13 decisions | 486,692 bytes |
| Rich article | 160 KiB | 4 × 512 KiB SVG | 200 citations | 200 threads, 1,000 messages, 100 proposals, 50 decisions | 3,345,674 bytes |

The fixtures include anchored review records and actual shared resource records.
The SVGs are valid deterministic fixtures padded with comments to the specified
byte sizes; image decoding and rendering are outside this server workload. The
manuscript is marker-free prose with citations. Eight writers edit `Y.Text` and
two append attributed comment-message records. The transport roles are one
owner, seven editors and two commenters; the initialized owner's permissions
follow the editor path. The microbenchmark uses eight editor calls and two
commenter calls in each ten-update cycle.

The microbenchmark times validation only, with 20 warmup updates followed by
100 measured updates. Its process CPU/memory fields also include applying each
accepted update to the authoritative document and ten local peer documents;
they are not isolated validator resource counters. Full-state fingerprints
verify final equivalence outside the timed region.

The transport workload uses ten independent authenticated Hocuspocus providers
over actual loopback WebSockets, with the server in a separate process. Every
burst submits eight manuscript edits and two replies before yielding, waits for
all ten peers to integrate every update, then waits 100 ms. Two warmup bursts
precede 15 measured bursts: 150 measured writes per case. Lightweight text-delta
and changed-message-key observers measure mutation-to-all-peers propagation;
they do not repeatedly rescan complete manuscripts.

Persistence is the real `FileCollaborationStore` on a local temporary directory,
with every append awaited before integration. Its default 128-update compaction
threshold is crossed during the 170 workload writes, so log compaction remains
inside the measured window. Scheduled Hocuspocus snapshots are debounced beyond
that window; shutdown creates a snapshot before persisted reload is checked.
The benchmark checks reload equivalence, while the transport regression tests
establish failure-before-integration behavior for failed appends. This is not a
PostgreSQL/S3 or power-loss durability benchmark.

## Results

Each value below is the median of three independent per-run statistics, not a
percentile pooled across runs. Times are milliseconds. Before means the original
server at the specified Git revision; after means the optimized implementation.

| Validation only | p50 before → after | p95 before → after | Mean before → after |
| --- | ---: | ---: | ---: |
| Article | 15.69 → 0.40 | 32.92 → 1.19 | 18.28 → 0.57 |
| Rich article | 71.93 → 1.70 | 104.96 → 4.68 | 67.71 → 2.46 |

The median run means improve by about 32× and 28× for these marker-free fixtures.

| Ten-client transport | All-peers p50 before → after | All-peers p95 before → after | Server CPU ms/write before → after | Sampled peak server RSS MiB before → after |
| --- | ---: | ---: | ---: | ---: |
| Article | 135.67 → 22.28 | 239.98 → 45.32 | 29.29 → 3.04 | 290.3 → 152.8 |
| Rich article | 473.30 → 32.61 | 805.62 → 63.68 | 93.26 → 5.27 | 476.3 → 397.3 |

Server CPU is measured with `process.cpuUsage` in the server child only and
includes validation, transport handling, authorization and file persistence.
The median server CPU utilization, normalized to one core, is 91.5% → 22.1%
for the article and 107.3% → 34.4% for the rich article. Values above 100% can
include concurrent runtime/GC work. Client-process CPU per write is separately
recorded: 1.93 → 1.59 ms and 2.34 → 1.67 ms, respectively.

RSS is sampled every 10 ms after warmup and an explicit GC; a blocking operation
can hide a transient from that sampler. Raw results also retain initial/final
RSS, sampled heap and OS lifetime maximum RSS, which includes startup. These
figures describe one Node collaboration process with one room, not all services.

Observed accepted-write rates were 30.7 → 76.2 writes/s for the article and
11.8 → 65.3 writes/s for the rich article. This is a paced burst workload with
an intentional 100 ms wait and convergence barrier, not a saturation test or a
maximum server-capacity claim. Median cold synchronization of all ten providers
was 189 → 124 ms and 496 → 395 ms, respectively, outside the warm measurement.
Across the three runs, optimized all-peers p95 ranged from 41.0–64.7 ms for the
article and 60.2–77.2 ms for the rich article. All 12 transport cases converged;
all persisted reloads matched all peer states, including resources and history.

## Profile and resulting implementation choices

A sampled Node CPU profile of the original rich microbenchmark (250 measured
updates) confirmed several costs rather than attributing all latency to copying:
`parseReviewMarkup` occupied about 42.7% of sampled stacks,
`projectResourcesDiagnostic` 16.3%, `encodeStateAsUpdate` 9.3%, and `applyUpdate`
9.3%. These are inclusive stack percentages and can overlap; the run also
includes fixture construction and peer propagation. The large-image base64
validation regex alone accounted for about 10.3% of self samples.

The implementation reuses an isolated Yjs mirror only after observing integration
from the expected authenticated sender, caches unchanged resource checks and
root reads with deep invalidation, and skips the Markdown AST parser only when
both literal class tokens needed by reserved markup are absent. Inputs containing
`.dm-anchor` or `.draftmatter-reviews`, including harmless occurrences in code
fences, retain full-parser validation. A preliminary profile before that lexical
guard measured rich validation means around 84 → 44 ms; it prompted the guard
and is not part of the final unprofiled table.

To reproduce a CPU diagnosis separately from unprofiled timing:

```sh
npm run benchmark:collaboration -- \
  --runs=1 --samples=250 --fixtures=rich --scenarios=micro \
  --baseline-revision=497d12008e7101595be18437e371a67827ffe410 \
  --profile=/tmp/collaboration-cpu --output=/tmp/collaboration-profile.json
```

CPU profiles are deliberately excluded from the repository. The profile flag
covers the micro worker; when used with transport it profiles the client worker,
not the separate server child.

## Verification run with the change

- Collaboration/service and shared-editor suites: **357 tests passed, 6 skipped**
  across 51 passing files and 2 skipped files. The command was
  `vitest run services/collaboration src/sharedEditor src/collaboration --maxWorkers=1 --testTimeout=15000`.
  A temporary Vite filesystem-allow configuration was needed solely because this
  isolated worktree reused dependencies through a symlink and the WASM loader
  otherwise rejected their path; application configuration was not changed.
- Application, website and collaboration-service TypeScript checks passed, as
  did the production collaboration-service build.
- The benchmark worker passed a separate strict TypeScript check, and the runner
  passed `node --check`. All 24 final benchmark cases completed their equivalence
  assertions; all 12 transport cases completed persisted reload verification.

## Integration verification

The change was integrated on top of main `d5bb0a371185def1e75e1c446e6eed003d6d4233` on
16 November 2026. After installing its locked dependencies, the same service,
shared-editor and collaboration suites passed **360 tests, with 6 skipped**.
Application, service and website type checks passed; production application, CLI,
service and website builds passed. The benchmark worker's strict type check and
runner syntax check passed. A short historical-reference/incremental smoke also
passed validation, ten-client convergence and persisted reload assertions on main;
its timings do not replace the three-run measurements above.

## Remaining qualification

The final speedups apply to the measured marker-free `Y.Text` edits and comment
appends. Full-parser fallbacks, ProseMirror XML edits, figure replacement,
large initial imports, repeated rejection/rebuilds, long-lived CRDT histories,
many rooms and sustained saturation need their own measurements. Adversarial
updates, deferred dependencies/delete sets, persistence failures and competing
connections are covered by regression tests rather than this throughput fixture.

Before deployment, repeat a realistic run on the actual shared-vCPU Marseille
VPS with the complete Compose stack, PostgreSQL and object storage, real network
latency and browser clients, and observe memory, latency and resource contention.
No VPS, DNS or deployment changes were made for this measurement.
