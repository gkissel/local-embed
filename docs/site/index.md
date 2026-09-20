---
title: Contratos que deixam a aplicação livre
---

<p class="kicker">LOCAL-FIRST · DECLARATIVO · VERSIONADO</p>

# Embeddings que acompanham seus dados. Sem amarrar sua aplicação.

<p class="lede">LocalEmbed é a camada declarativa entre suas tabelas PostgreSQL e um destino vetorial consistente de forma eventual.</p>

<a class="cta" href="/getting-started/">Ler o guia inicial →</a>

<div class="grid">
  <div class="card"><strong>Uma configuração</strong><p>Um contrato JSON Schema independente de serviço, linguagem e ORM.</p></div>
  <div class="card"><strong>Uma API de consulta</strong><p>Gere vetores para texto avulso; busca continua sendo responsabilidade da aplicação.</p></div>
  <div class="card"><strong>Uma fonte de verdade</strong><p>Configurações aplicadas são imutáveis. Workers futuros sempre leem uma versão explícita.</p></div>
  <div class="card"><strong>Uma fronteira clara</strong><p>O contrato é público hoje; PostgreSQL, worker e inferência chegam como serviços depois.</p></div>
</div>

## Comece pelo contrato

O exemplo canônico mostra uma entidade `article` com um provedor TEI local e um destino vetorial de
768 dimensões. Use-o para entender a configuração antes de aplicar a ferramenta ao seu domínio.

<div class="hero-note">A documentação e seus contratos não escondem uma API funcional. Esta primeira versão define o que os serviços futuros deverão respeitar.</div>
