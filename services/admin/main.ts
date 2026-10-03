import { applyConfiguration } from './apply.ts';

if (Deno.args.length !== 2 || Deno.args[0] !== 'migrate') {
  console.error('Usage: deno task localembed migrate <configuration.json>');
  Deno.exit(1);
}
try {
  const databaseUrl = Deno.env.get('DATABASE_URL');
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  await applyConfiguration(databaseUrl, JSON.parse(await Deno.readTextFile(Deno.args[1])));
  console.log('Configuration applied. Trigger capture is active.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  Deno.exit(1);
}
