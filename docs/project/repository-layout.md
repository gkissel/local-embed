# Estrutura planejada do monorepo

O monorepo usa workspaces e tasks nativas do Deno. Lume gera o site de documentação e `llms.txt`;
não haverá Turborepo. A interface segue a direção visual definida em
[documentation-design.md](./documentation-design.md), baseada nos padrões do site do Lume.

```text
contracts/      JSON Schema, OpenAPI e exemplos validados
services/       administração, worker, query API, poller, snapshots e bibliotecas Deno
deployments/    Compose de referência e configuração de telemetria; Helm planejado na #9
                telemetry/ contém Collector e provisionamento Grafana
docs/           site Lume, proposta, arquitetura e guias operacionais
examples/       aplicação consumidora de busca híbrida e variante experimental de armazenamento
tests/          integração, contrato e avaliação reproduzível
```
