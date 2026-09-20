import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import SwaggerParser from '@apidevtools/swagger-parser';

type JsonValidator = {
  (data: unknown): boolean;
  errors?: Array<{ instancePath: string; message?: string }> | null;
};
type Ajv = { compile(schema: unknown): JsonValidator };
type AjvConstructor = new (options: { allErrors: boolean; strict: boolean }) => Ajv;

// Deno's Node compatibility layer exposes these CommonJS default exports with
// namespace typings; retain strict checking at the public boundary below.
const Ajv2020 = Ajv2020Module as unknown as AjvConstructor;
const addFormats = addFormatsModule as unknown as (ajv: Ajv) => void;

export async function validateContracts(): Promise<void> {
  const root = new URL('../', import.meta.url);
  const schema = await readJson(new URL('contracts/schema/localembed.v1.schema.json', root));
  const example = await readJson(new URL('contracts/examples/localembed.v1.example.json', root));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  if (!validate(example)) {
    const details = (validate.errors ?? [])
      .map((error) => `  ${error.instancePath || '/'} ${error.message}`)
      .join('\n');
    throw new Error(`Canonical JSON Schema example is invalid:\n${details}`);
  }

  try {
    await SwaggerParser.validate(new URL('contracts/openapi/localembed.v1.yaml', root).pathname);
  } catch (error) {
    throw new Error(
      `OpenAPI contract is invalid:\n${error instanceof Error ? error.message : String(error)}`,
    );
  }

  console.log('Validated localembed/v1 JSON Schema canonical example.');
  console.log('Validated localembed/v1 OpenAPI document.');
}

if (import.meta.main) await validateContracts();

async function readJson(url: URL): Promise<unknown> {
  return JSON.parse(await Deno.readTextFile(url));
}
