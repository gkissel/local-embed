# Queue coordination verification

The probe compares issue #3 (merge commit `8dcbc9f`) against issue #11 using the same workload: one
initial insert, 50 updates to an unrelated field, 50 assignments of unchanged content, 20 content
changes, and three concurrent workers. Workers are held at an inference barrier before responses are
released, so the duplicate-inference scenario is deterministic. The probe drains remaining work and
verifies the destination row count.

| Measurement                            | Before (#3) | After (#11) |
| -------------------------------------- | ----------: | ----------: |
| Source changes captured by the trigger |         121 |          21 |
| Task rows before processing            |         121 |           1 |
| Provider calls                         |           3 |           1 |
| Final destination rows                 |           1 |           1 |

These are work counts from a controlled scenario, not a throughput or database I/O benchmark. The
provider is simulated to isolate queue behavior. Generation sums count captured changes in the new
queue; the old queue records each capture as a separate row. The comparison excludes worker claim,
renewal and completion writes. It does not establish how many WAL bytes or CPU cycles an upsert
saves compared with an insert.

The database was ParadeDB PostgreSQL 18.3 with `pg_search` 0.22.6 and pgvector 0.8.1, using the
image digest in `deployments/database.compose.yaml`. Integration scenarios also passed using the
real CPU TEI image and immutable E5 model revision in `deployments/tei.compose.yaml`.

Run against a disposable database: the probe removes `localembed` and `public.articles`.

```sh
TEST_DATABASE_URL=postgres://postgres:password@localhost/test \
deno run --allow-env --allow-net --allow-read scripts/measure_queue.ts
```

For the baseline, use an isolated checkout while running the same current probe script:

```sh
git worktree add --detach /tmp/localembed-issue3-baseline 8dcbc9f
LOCAL_EMBED_SOURCE_ROOT=file:///tmp/localembed-issue3-baseline/ \
TEST_DATABASE_URL=postgres://postgres:password@localhost/test \
deno run --config /tmp/localembed-issue3-baseline/deno.json \
  --allow-env --allow-net --allow-read scripts/measure_queue.ts
git worktree remove /tmp/localembed-issue3-baseline
```

The integration suite additionally verifies irrelevant-update filtering, generation preservation
when old inference fails, deletion/reinsertion, identifier changes, independent identifiers, renewal
beyond the initial lease, cancellation after ownership loss, late-response fencing, maximum
execution duration, renewal failure, legacy queue migration, retention of terminal failure context,
source/writer lock ordering, and a worker with SELECT-only source access.
