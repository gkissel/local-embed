import postgres from 'npm:postgres@3.4.7';
// No provider inference or DDL in periodic health probes.
const sql = postgres(Deno.env.get('DATABASE_URL')!, {
  max: 1,
  connect_timeout: 3,
  connection: { statement_timeout: 3000 },
});
try {
  const rows = await sql`SELECT 1 FROM localembed.entity_revisions WHERE state = 'active' LIMIT 1`;
  if (rows.length !== 1) throw new Error('No active revision');
  if (Deno.args[0] === 'api') {
    const response = await fetch('http://127.0.0.1:8090/v1/embeddings', {
      signal: AbortSignal.timeout(3000),
    });
    if (response.status !== 405) throw new Error('API unavailable');
  }
} finally {
  await sql.end();
}
