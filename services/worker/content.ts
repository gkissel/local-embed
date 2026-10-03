import type postgres from 'postgres';
import type { Configuration } from '../admin/apply.ts';

export const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
export const table = (s: string) => s.split('.').map(quote).join('.');
export const idType = (type: string): string =>
  ({ uuid: 'uuid', bigint: 'bigint', text: 'text', ulid: 'text' })[type]!;
type Entity = Configuration['entities'][number];
type Sql = ReturnType<typeof postgres> | postgres.TransactionSql;

/** Locking reads use fixed administrative helpers; ordinary reads need only SELECT. */
export async function readContent(
  sql: Sql,
  entity: Entity,
  identifier: string,
  locked = false,
): Promise<Record<string, unknown> | undefined> {
  const [row] = await sql.unsafe(
    locked
      ? `SELECT * FROM ${table('localembed.lock_source_' + entity.name)}($1::text)`
      : `SELECT * FROM ${table(entity.source.table)} WHERE ${
        quote(entity.source.id.column)
      } = $1::${idType(entity.source.id.type)}`,
    [identifier],
  );
  if (!row) return undefined;
  await addDependencies(sql, entity, row, locked);
  return row;
}

export async function addDependencies(
  sql: Sql,
  entity: Entity,
  row: Record<string, unknown>,
  locked = false,
): Promise<void> {
  const dependencies = (entity.dependencies ?? []).map((dep, index) => ({ dep, index }));
  // Use a global ordering even when two roots reference the same parents in reverse roles.
  dependencies.sort((a, b) => {
    const left = JSON.stringify([a.dep.target.table, String(row[a.dep.source_column])]);
    const right = JSON.stringify([b.dep.target.table, String(row[b.dep.source_column])]);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  for (const { dep, index } of dependencies) {
    const value = row[dep.source_column];
    const [parent] = value == null ? [] : await sql.unsafe(
      locked
        ? `SELECT * FROM ${table(`localembed.lock_dep_${entity.name}_${index}`)}($1::text)`
        : `SELECT * FROM ${table(dep.target.table)} WHERE ${quote(dep.target.id.column)} = $1::${
          idType(dep.target.id.type)
        }`,
      [String(value)],
    );
    for (const field of dep.fields) row[`${dep.name}.${field}`] = parent?.[field] ?? null;
  }
}
