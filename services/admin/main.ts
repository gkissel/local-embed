import { applyConfiguration } from './apply.ts';
import { backfill, buildIndexes, prepareWorker } from './synchronize.ts';

try {
  const databaseUrl = Deno.env.get('DATABASE_URL');
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const [command, path] = Deno.args;
  if (command === 'migrate' && path && Deno.args.length === 2) {
    await applyConfiguration(databaseUrl, JSON.parse(await Deno.readTextFile(path)));
    console.log('Configuration applied. Configured detection is ready.');
  } else if (command === 'prepare-worker' && Deno.args.length === 1) {
    await prepareWorker(databaseUrl);
  } else if (command === 'backfill' && Deno.args.length === 1) {
    await backfill(databaseUrl);
  } else if (command === 'build-indexes' && Deno.args.length === 1) {
    await buildIndexes(databaseUrl);
  } else {throw new Error(
      'Usage: localembed migrate <config.json> | prepare-worker | backfill | build-indexes',
    );}
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  Deno.exit(1);
}
