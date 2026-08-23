# Arquitetura do LocalEmbed

## Fluxo principal

```text
Tabelas de origem ── trigger ou polling ──> fila localembed
                                               │
                                               ▼
                                      worker Deno escalável
                                               │
                         ┌─────────────────────┴─────────────────────┐
                         ▼                                           ▼
             TEI local OpenAI-compatible                    API externa
                         │                                           │
                         └─────────────────────┬─────────────────────┘
                                               ▼
                           destino pgvector por entidade no schema localembed
```

O trigger somente registra uma tarefa persistente na transação da alteração; ele
nunca executa inferência. No modo `POLLING`, `updated_at` é obrigatório em cada
origem ou dependência de conteúdo, e reconciliação remove referências órfãs após
exclusões físicas.

## Garantias

- Processamento ao menos uma vez com tarefa persistente, lease e retry.
- Escritas idempotentes protegidas por fingerprint SHA-256 de conteúdo e
  configuração de geração.
- Tarefas em falha terminal preservam contexto e exigem reprocessamento
  administrativo explícito.
- Uma versão de configuração só vale após `apply-config`; tarefas iniciadas sob
  versão antiga não podem gravar resultado após uma nova versão ser aplicada.

## Papéis de implantação

- `worker`: consome tarefas, processa backfill e mantém embeddings.
- `query-api`: autentica com chave de serviço e gera vetor de texto avulso.
- `inference-server`: TEI com modelo local; pode escalar independentemente.
- `dashboard`: Grafana provisionado sobre OpenTelemetry, Prometheus e Loki.

Docker Compose é o ambiente de desenvolvimento e avaliação. Kubernetes é
entregue por Helm chart, usando as mesmas imagens e contratos.
