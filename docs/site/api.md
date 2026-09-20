---
title: Query API
url: /api/
---

<p class="kicker">REFERÊNCIA · OPENAPI</p>

# Gere o vetor. A busca continua sua.

`POST /v1/embeddings` recebe texto e uma entidade já aplicada. A resposta informa vetor, dimensão,
modelo, provedor e o fingerprint da geração. Não existe endpoint de busca no LocalEmbed.

```http
POST /v1/embeddings
Authorization: Bearer $LOCAL_EMBED_SERVICE_KEY
Content-Type: application/json

{ "entity": "article", "input": "Como funciona a sincronização incremental?" }
```

```json
{
  "embedding": [0.018, -0.044],
  "dimensions": 768,
  "model": "intfloat/multilingual-e5-base",
  "provider": "local_tei",
  "generation": { "config_version": "localembed/v1", "fingerprint": "…" }
}
```

Autenticação é Bearer com uma chave de serviço aleatória de 32 bytes, injetada por variável de
ambiente. Consulte o [OpenAPI completo](/contracts/openapi/localembed.v1.yaml) para todos os códigos
de resposta e formatos.

## Especificação navegável

<div class="api-reference" data-api-reference>
  <p class="api-loading">Carregando o contrato OpenAPI…</p>
</div>

<script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
<script>
  const reference = document.querySelector('[data-api-reference]');
  Redoc.init(
    '/contracts/openapi/localembed.v1.yaml',
    {
      hideHostname: true,
      nativeScrollbars: true,
      theme: {
        colors: { primary: { main: '#16614a' } },
        typography: {
          fontFamily: "'DM Mono', monospace",
          headings: { fontFamily: "'Newsreader', Georgia, serif" },
          code: { fontFamily: "'DM Mono', monospace" },
        },
        sidebar: { width: '220px', backgroundColor: '#f1f2e9' },
        rightPanel: { backgroundColor: '#202a28' },
      },
    },
    reference,
  );
</script>
