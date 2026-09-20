# LocalEmbed

LocalEmbed keeps embeddings synchronized with PostgreSQL while leaving search and application
concerns with the consumer. This repository currently publishes the versioned configuration and
query contracts plus their documentation; runtime services arrive in later issues.

## Workspace

The project uses Deno workspaces and native tasks. Install [Deno 2](https://deno.com/) and run:

```sh
deno task validate:contracts
deno task check
deno task docs:build
```

The public configuration contract is at `contracts/schema/localembed.v1.schema.json`, with its
canonical example in `contracts/examples/`. The initial query API is described by
`contracts/openapi/localembed.v1.yaml`.

To preview the documentation locally, run `deno task docs:serve` and open the address printed by
Lume. `deno task docs:prepare` copies the public contracts into the Lume input so the generated site
serves the JSON Schema, canonical example, and OpenAPI document.
