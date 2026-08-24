# Handoff — Issue #1: Bootstrap Deno workspace and public contracts

## Comece aqui

Trabalhe na branch `feature-#1/bootstrap-docs-contracts`, criada a partir de
`development`. Ao iniciar implementação, mova a issue #1 para `In Progress` no
[Project LocalEmbed](https://github.com/users/gkissel/projects/4).

Leia antes de alterar o repositório:

- [Especificação inicial](../project/initial-specification.md)
- [Arquitetura](../architecture/overview.md)
- [Contratos públicos](../contracts/overview.md)
- [Direção visual da documentação](../project/documentation-design.md)
- ADR-0002, ADR-0005 e ADR-0010

## Entrega

Crie a base executável do monorepo Deno que permita a um contribuidor:

1. validar um exemplo canônico do JSON Schema `localembed/v1`;
2. consultar a especificação OpenAPI inicial de `POST /v1/embeddings`;
3. gerar e navegar uma documentação Lume responsiva, com `llms.txt` e direção
   visual baseada no site do Lume.

Mantenha JSON Schema e OpenAPI como contratos públicos independentes dos
serviços futuros. Os exemplos devem ser validados por checagem automatizada.

## Fronteira

Esta issue estabelece contratos e documentação. Implementação de PostgreSQL,
fila, worker, TEI, API funcional e dashboard pertence às issues posteriores.

## Encerramento

Antes de entregar, execute as verificações introduzidas, atualize a issue com os
comandos de validação e mova o item do Project para `Done` somente após o merge
em `master`.
