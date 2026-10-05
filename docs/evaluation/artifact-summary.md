# Recorded baseline readout

Run: 2026-10-05T13:41:24.783Z. This is one small real-TEI operational baseline, not a production benchmark.

| Scenario | Completed task rows | p50 ms | p95 ms | Attempts |
| --- | ---: | ---: | ---: | ---: |
| initial_backfill | 32 | 11387.91 | 15709.28 | 34 |
| unrelated_unchanged | 0 | n/a | n/a | 0 |
| burst_coalescing | 1 | 86.57 | 86.57 | 1 |
| dependency_fanout | 28 | 2809.51 | 7805.37 | 28 |
| transient_retry | 1 | 150.58 | 150.58 | 2 |
| terminal_failure | 0 | n/a | n/a | 1 |
| explicit_reprocess | 1 | 142.04 | 142.04 | 1 |
| lease_renewal | 1 | 599.85 | 599.85 | 1 |
| polling_reconciliation | 4 | 505.96 | 813.96 | 3 |

Attempts: 77; injected transient/terminal failures: 1/1; observed natural provider failures: 0. Fresh embeddings verified: 31; retained tasks deleted: 32.

| Container | Samples | Sampled peak memory MiB | Peak sampled Docker CPU % |
| --- | ---: | ---: | ---: |
| localembed-evaluation-db | 17 | 71.02 | 21.79 |
| localembed-evaluation-tei | 17 | 1985.54 | 412.66 |

Docker CPU is core-relative; memory is sampled/rounded. Deno roles share one process. Latency samples represent latest completed task generations; deletion tasks are counted. Warmup/readiness are excluded from phase timings. See [methodology](../artifact-evaluation.md), [full report](artifact.json) and [raw samples](artifact-resources.jsonl).
