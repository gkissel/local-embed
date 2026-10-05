import postgres from 'npm:postgres@3.4.7';
import { demoConfiguration, setup } from '../../examples/hybrid-search/setup.ts';
import { backfill } from '../../services/admin/synchronize.ts';

// Explicit one-shot administration; runtime containers never receive this URL.
const url = Deno.env.get('DATABASE_URL');
if (!url) throw new Error('Administrative DATABASE_URL required');
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const [exists] = await sql`SELECT to_regnamespace('hybrid_demo') IS NOT NULL AS present`;
  if (!exists.present) {
    const config = demoConfiguration();
    config.providers[0].endpoint = Deno.env.get('LOCAL_EMBED_TEI_ENDPOINT') ?? 'http://tei:80';
    await setup(url, config);
  }
  // An interrupted setup is deliberately an error, never an implicit schema reset.
  const [ready] = await sql`SELECT count(*) AS count FROM localembed.entity_revisions
    WHERE entity = 'demo_article' AND state = 'active'`;
  if (Number(ready.count) !== 1) throw new Error('Demo configuration needs administrative repair');
  await sql.unsafe(`
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    GRANT USAGE ON SCHEMA hybrid_demo, localembed TO le_worker, le_poller, le_api, le_snapshot, le_consumer;
    GRANT SELECT ON localembed.configurations, localembed.entity_revisions TO le_worker, le_poller, le_api, le_consumer;
    GRANT SELECT ON localembed.entity_revisions TO le_snapshot;
    GRANT SELECT ON hybrid_demo.articles TO le_worker, le_poller, le_consumer;
    GRANT SELECT, UPDATE ON localembed.tasks TO le_worker;
    GRANT SELECT, INSERT, UPDATE ON localembed.tasks, localembed.polling_state, localembed.enqueue_metrics TO le_poller;
    GRANT USAGE ON SEQUENCE localembed.tasks_id_seq TO le_poller;
    GRANT SELECT ON localembed.tasks, localembed.polling_state, localembed.enqueue_metrics, localembed.cleanup_totals TO le_snapshot;
    GRANT SELECT, INSERT, UPDATE, DELETE ON localembed.demo_article_embeddings TO le_worker;
    GRANT SELECT ON localembed.demo_article_embeddings TO le_poller, le_consumer;
    GRANT EXECUTE ON FUNCTION localembed.revision_eligible(bigint, text) TO le_worker, le_poller;
    GRANT EXECUTE ON FUNCTION localembed.lock_source_demo_article(text) TO le_worker;
    REVOKE EXECUTE ON FUNCTION localembed.enqueue_task(bigint,text,text,text), localembed.enqueue_task(bigint,text,text,text,text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION localembed.enqueue_task(bigint,text,text,text,text) TO le_poller;
  `);
  if (!exists.present) await backfill(url);
  console.log(JSON.stringify({ event: 'reference_initialized' }));
  console.log(
    JSON.stringify(
      await sql`SELECT extname, extversion FROM pg_extension WHERE extname IN ('vector','pg_search') ORDER BY extname`,
    ),
  );
} finally {
  await sql.end();
}
