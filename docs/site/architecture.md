---
title: Arquitetura
url: /architecture/
---

<p class="kicker">ARQUITETURA</p>

# Um fluxo assíncrono, uma responsabilidade por papel

```text
tabelas de origem → trigger ou polling → fila persistente
                                          ↓
                                  worker Deno escalável
                                   ↙                 ↘
                         TEI local              API externa
                                   ↘                 ↙
                         destino pgvector no schema localembed
```

O trigger futuro registra trabalho na mesma transação, nunca executa inferência. A execução tem
semântica de pelo menos uma vez, com fingerprint SHA-256 para escrita idempotente e versões
aplicadas imutáveis.

Estes contratos definem as bordas que unem esses papéis. A implementação de PostgreSQL, fila,
worker, TEI e API operacional será introduzida nas próximas etapas da ferramenta.
