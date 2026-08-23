# Estrutura planejada do monorepo

O monorepo usa workspaces e tasks nativas do Deno. Lume gera o site de
documentação e `llms.txt`; não haverá Turborepo.

```text
contracts/      JSON Schema, OpenAPI e exemplos validados
services/       worker, query API e bibliotecas compartilhadas Deno
deploy/         Compose, Helm e configuração de telemetria
dashboard/      provisionamento Grafana
docs/           site Lume, proposta, arquitetura e guias operacionais
tests/          integração, contrato e avaliação reproduzível
```
