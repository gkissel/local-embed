import { assertEquals, assertThrows } from '@std/assert';
import { defaults, fuse, parameters } from '../examples/hybrid-search/search.ts';
Deno.test('consumer RRF uses independent ranks, numeric stable IDs and validated parameters', () => {
  const results = fuse(['10', '2'], ['2', '10'], defaults);
  assertEquals(results.map((row) => row.id), ['2', '10']);
  assertEquals(results[0].score, 0.5 / 61 + 0.5 / 62);
  assertEquals(results[0].lexicalRank, 2);
  assertEquals(results[0].semanticRank, 1);
  assertEquals(fuse(['1'], ['2'], parameters({ lexicalWeight: 0 })).map((row) => row.id), ['2']);
  assertEquals(
    fuse(['9007199254740993', '9007199254740992'], ['9007199254740992', '9007199254740993']).map((
      row,
    ) => row.id),
    ['9007199254740992', '9007199254740993'],
  );
  assertThrows(() => parameters({ candidateLimit: 0 }));
  assertThrows(() => parameters({ lexicalWeight: NaN }));
  assertThrows(() => parameters({ lexicalWeight: 0, semanticWeight: 0 }));
});
