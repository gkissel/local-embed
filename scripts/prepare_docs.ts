const root = new URL('../', import.meta.url);
const source = new URL('contracts/', root);
const destination = new URL('docs/site/contracts/', root);

await Deno.remove(destination, { recursive: true }).catch((error: unknown) => {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
});
await copyDirectory(source, destination);

console.log('Prepared public contracts for the Lume site.');

async function copyDirectory(source: URL, destination: URL): Promise<void> {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const target = new URL(entry.name, destination);
    const origin = new URL(entry.name, source);
    if (entry.isDirectory) {
      await copyDirectory(
        new URL(`${entry.name}/`, source),
        new URL(`${entry.name}/`, destination),
      );
    } else if (entry.isFile) await Deno.copyFile(origin, target);
  }
}
