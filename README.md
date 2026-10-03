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

## Apply a trigger-backed configuration

Install pgvector in PostgreSQL 18 or later (`CREATE EXTENSION vector`) using the database
administrator role, then run:

```sh
export DATABASE_URL=postgres://admin:password@localhost/localembed
export LOCAL_EMBED_TEI_API_KEY=your-provider-key
deno task localembed migrate contracts/examples/localembed.v1.example.json
```

The command validates the public schema, provider references, template fields, source columns,
non-null unique identifiers, and provider output dimensions before committing any objects. It
persists the applied configuration, provisions a fixed-dimension destination, and installs triggers
that enqueue persistent `upsert` and `delete` tasks in the source transaction. No inference runs in
those triggers. Changes to source identifiers enqueue deletion of the old identifier as well.

This first administrative command supports new entities using trigger detection without content
dependencies. It rejects existing destinations and unsupported configurations with validation
errors; configuration updates, polling, and dependencies arrive in later issues. HNSW creation is
deferred until initial backfill, as specified by the managed-storage ADR. Workers and backfill are
not part of this command. The trigger executes with the source writer's privileges; runtime roles
need `USAGE` on `localembed`, `INSERT` on `localembed.tasks`, and `USAGE` on its identity sequence.

Run the database integration test against a disposable PostgreSQL 18 database with pgvector:

```sh
TEST_DATABASE_URL=postgres://postgres:password@localhost/test deno task test:integration
```

The integration test creates and removes `public.articles` and the `localembed` schema.
