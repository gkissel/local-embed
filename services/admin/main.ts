import { cleanup, configureRetention } from './retention.ts';
import { activate, cancelRevision, reprocess } from './revisions.ts';
import { applyConfiguration } from './apply.ts';
import { backfill, buildIndexes, prepareWorker } from './synchronize.ts';

try {
  const databaseUrl = Deno.env.get('DATABASE_URL');
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const [command, path] = Deno.args;
  if ((command === 'migrate' || command === 'stage') && path && Deno.args.length === 2) {
    const revision = await applyConfiguration(
      databaseUrl,
      JSON.parse(await Deno.readTextFile(path)),
      undefined,
      command === 'stage',
    );
    console.log(
      JSON.stringify({
        event: command === 'stage' ? 'configuration_staged' : 'configuration_applied',
        revision,
      }),
    );
  } else if (command === 'activate' && path && Deno.args.length === 2) {
    await activate(databaseUrl, path);
  } else if (command === 'cancel' && path && Deno.args.length === 2) {
    await cancelRevision(databaseUrl, path);
  } else if (
    command === 'reprocess' && path && Deno.args[2] &&
    (Deno.args.length === 3 || Deno.args.length === 4)
  ) {
    const count = await reprocess(databaseUrl, path, Deno.args[2], Deno.args[3]);
    console.log(JSON.stringify({ event: 'tasks_reprocessed', count }));
  } else if (command === 'configure-retention' && path && Deno.args.length === 2) {
    await configureRetention(databaseUrl, JSON.parse(await Deno.readTextFile(path)));
  } else if (command === 'cleanup' && (!path || path === '--apply') && Deno.args.length <= 2) {
    console.log(JSON.stringify(await cleanup(databaseUrl, path !== '--apply')));
  } else if (command === 'prepare-worker' && Deno.args.length === 1) {
    await prepareWorker(databaseUrl);
  } else if (command === 'backfill' && Deno.args.length === 1) {
    await backfill(databaseUrl);
  } else if (command === 'build-indexes' && Deno.args.length === 1) {
    await buildIndexes(databaseUrl);
  } else {throw new Error(
      'Usage: localembed migrate|stage <config.json> | activate|cancel <revision> | reprocess <revision> <entity> [source-id] | configure-retention <policy.json> | cleanup [--apply] | prepare-worker | backfill | build-indexes',
    );}
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  Deno.exit(1);
}
