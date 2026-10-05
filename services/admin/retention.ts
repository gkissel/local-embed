import postgres from 'postgres';
import type { Configuration } from './apply.ts';
import { table } from '../worker/content.ts';
import { event } from '../shared/telemetry.ts';

export const READER_LOCK = 78129413;
export type RetentionPolicy = {
  completed_seconds: number;
  batch_size: number;
  retired_seconds: number;
  keep_retired: number;
  reader_grace_seconds: number;
  drop_retired_destinations: boolean;
  readers_use_lock_protocol: boolean;
  audit_seconds: number | null;
};
export const defaultRetention: RetentionPolicy = {
  completed_seconds: 604800,
  batch_size: 100,
  retired_seconds: 2592000,
  keep_retired: 2,
  reader_grace_seconds: 3600,
  drop_retired_destinations: false,
  readers_use_lock_protocol: false,
  audit_seconds: null,
};
export function retentionPolicy(value: unknown): RetentionPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid retention policy');
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !Object.hasOwn(defaultRetention, key))) {
    throw new Error('Unknown retention option');
  }
  const policy = { ...defaultRetention, ...input } as RetentionPolicy;
  for (
    const key of [
      'completed_seconds',
      'batch_size',
      'retired_seconds',
      'keep_retired',
      'reader_grace_seconds',
    ] as const
  ) {
    if (
      !Number.isSafeInteger(policy[key]) || policy[key] > 3155760000 ||
      policy[key] < (key === 'batch_size' ? 1 : 0)
    ) {
      throw new Error(`Invalid ${key}`);
    }
  }
  if (policy.batch_size > 10000 || policy.keep_retired > 10000) {
    throw new Error('Retention batch/window too large');
  }
  if (
    policy.audit_seconds !== null &&
    (!Number.isSafeInteger(policy.audit_seconds) || policy.audit_seconds < 0 ||
      policy.audit_seconds > 3155760000)
  ) throw new Error('Invalid audit retention');
  if (
    typeof policy.drop_retired_destinations !== 'boolean' ||
    typeof policy.readers_use_lock_protocol !== 'boolean'
  ) throw new Error('Invalid reader protection');
  if (policy.drop_retired_destinations && !policy.readers_use_lock_protocol) {
    throw new Error('Destination cleanup requires every consumer to use the reader lock protocol');
  }
  return policy;
}
export async function installRetention(tx: postgres.TransactionSql) {
  await tx.unsafe(`CREATE TABLE IF NOT EXISTS localembed.retention_policy (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), policy jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
    CREATE TABLE IF NOT EXISTS localembed.cleanup_totals(
      singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
      completed bigint NOT NULL DEFAULT 0, superseded bigint NOT NULL DEFAULT 0,
      metadata bigint NOT NULL DEFAULT 0, audit bigint NOT NULL DEFAULT 0,
      destinations bigint NOT NULL DEFAULT 0);
    INSERT INTO localembed.cleanup_totals(singleton) VALUES(true) ON CONFLICT DO NOTHING`);
  await tx`INSERT INTO localembed.retention_policy(policy) VALUES (${
    tx.json(defaultRetention)
  }) ON CONFLICT DO NOTHING`;
}
export async function configureRetention(url: string, value: unknown) {
  const policy = retentionPolicy(value);
  const sql = postgres(url, { max: 1 });
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(78129412)`;
      await tx`UPDATE localembed.retention_policy SET policy = ${
        tx.json(policy)
      }, updated_at = clock_timestamp()`;
      await tx`INSERT INTO localembed.admin_actions(action, details) VALUES ('configure_retention', ${
        tx.json(policy)
      })`;
    });
  } finally {
    await sql.end();
  }
}
/** One bounded administrative pass; skipped reservations are retried on the next schedule. */
export async function cleanup(url: string, dryRun = true) {
  const sql = postgres(url, {
    max: 1,
    connection: { statement_timeout: 30000, lock_timeout: 1000 },
    onnotice: () => {},
  });
  try {
    return await sql.begin(async (tx) => {
      const [owned] = await tx`SELECT pg_try_advisory_xact_lock(78129412) AS owned`;
      if (!owned.owned) throw new Error('Another administrator is active');
      const [stored] = await tx`SELECT policy FROM localembed.retention_policy WHERE singleton`;
      if (!stored) throw new Error('Run prepare-worker before cleanup');
      const policy = retentionPolicy(stored.policy);
      const [boundary] = await tx`SELECT clock_timestamp() AS now`;
      const now = new Date(boundary.now);
      const cutoff = new Date(now.getTime() - policy.completed_seconds * 1000);
      const completed = await tx`SELECT id FROM localembed.tasks
        WHERE status = 'done' AND processed_generation = generation AND completed_at <= ${cutoff}
        AND lease_token IS NULL AND lease_until IS NULL AND execution_deadline IS NULL
        ORDER BY completed_at, id LIMIT ${policy.batch_size} FOR UPDATE SKIP LOCKED`;
      let deleted = 0;
      if (!dryRun && completed.length) {
        // Row locks serialize concurrent enqueue; its next INSERT/upsert restores actionable work.
        const rows = await tx`DELETE FROM localembed.tasks WHERE id IN ${
          tx(completed.map((r) => r.id))
        }
          AND status = 'done' AND processed_generation = generation AND completed_at <= ${cutoff}
          AND lease_token IS NULL AND lease_until IS NULL AND execution_deadline IS NULL RETURNING id`;
        deleted = rows.length;
      }
      const revisions = await tx`SELECT v.*, c.configuration,
        row_number() OVER (PARTITION BY v.entity ORDER BY v.retired_at DESC, v.configuration_id DESC) AS position
        FROM localembed.entity_revisions v JOIN localembed.configurations c ON c.id = v.configuration_id
        WHERE v.state = 'retired' AND v.cleaned_at IS NULL`;
      const protectedRows =
        await tx`SELECT v.entity, c.configuration FROM localembed.entity_revisions v
        JOIN localembed.configurations c ON c.id = v.configuration_id WHERE v.state IN ('active','staging')`;
      const protectedTables = new Set<string>();
      for (const row of protectedRows) {
        for (
          const entity of (row.configuration as Configuration).entities.filter((e) =>
            e.name === row.entity
          )
        ) {
          protectedTables.add(entity.destination.table);
          protectedTables.add(entity.source.table);
          for (const dep of entity.dependencies ?? []) {
            protectedTables.add(dep.target.table);
          }
        }
      }
      const retiredCutoff = now.getTime() -
        Math.max(policy.retired_seconds, policy.reader_grace_seconds) * 1000;
      const destinations: {
        revision: string;
        entity: string;
        table: string;
        bytes: string;
        action: string;
      }[] = [];
      let metadata = 0, superseded = 0, audit = 0;
      const [readers] = policy.drop_retired_destinations
        ? await tx`SELECT pg_try_advisory_xact_lock(${READER_LOCK}) AS clear`
        : [{ clear: false }];
      for (const revision of revisions) {
        if (destinations.length >= policy.batch_size) break;
        if (
          Number(revision.position) <= policy.keep_retired || !revision.retired_at ||
          new Date(revision.retired_at).getTime() > retiredCutoff ||
          (revision.retired_execution_until &&
            new Date(revision.retired_execution_until).getTime() > now.getTime())
        ) continue;
        const config = revision.configuration as Configuration;
        const entity = config.entities.find((e) => e.name === revision.entity)!;
        const destination = entity.destination.table;
        if (
          protectedTables.has(destination) || revisions.some((other) =>
            other !== revision &&
            (other.configuration as Configuration).entities.some((e) =>
              e.name === other.entity && e.destination.table === destination
            )
          )
        ) continue;
        const [size] = await tx`SELECT CASE WHEN to_regclass(${
          table(destination)
        }) IS NULL THEN 0 ELSE pg_total_relation_size(to_regclass(${
          table(destination)
        })) END AS bytes`;
        const result = {
          revision: String(revision.configuration_id),
          entity: revision.entity as string,
          table: destination,
          bytes: String(size.bytes),
          action: 'retained',
        };
        destinations.push(result);
        if (!policy.drop_retired_destinations) {
          result.action = 'disabled';
          continue;
        }
        if (!readers.clear) {
          result.action = 'reader_active';
          continue;
        }
        if (dryRun) {
          result.action = 'eligible';
          continue;
        }
        try {
          const removedMetadata = await tx.savepoint(async (locked) => {
            const [exists] = await locked`SELECT to_regclass(${table(destination)}) AS relation`;
            if (exists.relation) {
              await locked.unsafe(
                `LOCK TABLE ${table(destination)} IN ACCESS EXCLUSIVE MODE NOWAIT`,
              );
              await locked.unsafe(`DROP TABLE ${table(destination)} RESTRICT`);
            }
            // Preserve diagnostics, configuration metadata and shared locking helpers.
            const polls =
              await locked`DELETE FROM localembed.polling_state WHERE configuration_id = ${revision.configuration_id} AND entity = ${revision.entity} RETURNING entity`;
            const fills =
              await locked`DELETE FROM localembed.backfills WHERE configuration_id = ${revision.configuration_id} AND entity = ${revision.entity} RETURNING entity`;
            await locked`UPDATE localembed.entity_revisions SET cleaned_at = ${now} WHERE configuration_id = ${revision.configuration_id} AND entity = ${revision.entity} AND state = 'retired'`;
            await locked`INSERT INTO localembed.admin_actions(action, details) VALUES ('retire_destination', ${
              locked.json({ ...result, action: exists.relation ? 'dropped' : 'already_absent' })
            })`;
            return { count: polls.length + fills.length, existed: Boolean(exists.relation) };
          });
          metadata += removedMetadata.count;
          result.action = removedMetadata.existed ? 'dropped' : 'already_absent';
        } catch (cause) {
          if (
            cause && typeof cause === 'object' && 'code' in cause &&
            ['55P03', '2BP01'].includes(String(cause.code))
          ) result.action = 'locked_or_dependent';
          else throw cause;
        }
      }
      const obsolete = await tx`SELECT t.id FROM localembed.tasks t
        JOIN localembed.entity_revisions v ON v.configuration_id = t.configuration_id AND v.entity = t.entity
        WHERE v.state = 'retired' AND v.cleaned_at IS NOT NULL
          AND t.status = 'superseded' AND t.superseded_from_status IN ('pending','processing')
          AND t.error_code IS NULL AND t.last_error IS NULL AND t.lease_token IS NULL
          AND t.lease_until IS NULL AND t.execution_deadline IS NULL
        ORDER BY t.id LIMIT ${policy.batch_size} FOR UPDATE OF t SKIP LOCKED`;
      if (!dryRun && obsolete.length) {
        const rows = await tx`DELETE FROM localembed.tasks WHERE id IN ${
          tx(obsolete.map((r) => r.id))
        } RETURNING id`;
        superseded = rows.length;
      }
      if (policy.audit_seconds !== null) {
        const auditCutoff = new Date(now.getTime() - policy.audit_seconds * 1000);
        const rows =
          await tx`SELECT id FROM localembed.admin_actions WHERE created_at < ${auditCutoff}
          ORDER BY created_at,id LIMIT ${policy.batch_size} FOR UPDATE SKIP LOCKED`;
        if (!dryRun && rows.length) {
          const removed = await tx`DELETE FROM localembed.admin_actions WHERE id IN ${
            tx(rows.map((r) => r.id))
          } RETURNING id`;
          audit = removed.length;
        }
      }
      const report = {
        dry_run: dryRun,
        cutoff: cutoff.toISOString(),
        eligible_completed: completed.length,
        deleted_completed: deleted,
        deleted_superseded: superseded,
        deleted_metadata: metadata,
        deleted_audit: audit,
        destinations,
      };
      if (!dryRun) {
        const dropped = destinations.filter((d) => d.action === 'dropped').length;
        await tx`UPDATE localembed.cleanup_totals SET completed = completed + ${deleted},
          superseded = superseded + ${superseded}, metadata = metadata + ${metadata},
          audit = audit + ${audit}, destinations = destinations + ${dropped} WHERE singleton`;
        await tx`INSERT INTO localembed.admin_actions(action, details) VALUES ('cleanup', ${
          tx.json(report)
        })`;
        event('cleanup_completed', {
          service: 'admin',
          count: deleted + superseded + metadata + audit,
        });
      }
      return report;
    });
  } finally {
    await sql.end();
  }
}
