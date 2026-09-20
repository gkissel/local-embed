import { validateContracts } from '../scripts/validate_contracts.ts';

Deno.test('public contracts validate', async () => {
  await validateContracts();
});
