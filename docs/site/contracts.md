---
title: Configuração localembed/v1
url: /contracts/
---

<p class="kicker">REFERÊNCIA · JSON SCHEMA</p>

# Configuração declarativa, sem SQL livre

`localembed/v1` é o contrato público de configuração. Ele separa a intenção da aplicação da
implementação futura de serviços.

## O formato

Uma configuração declara provedores, entidades e opções operacionais. Templates aceitam apenas
placeholders de campos ou relações declarados — não há condicionais, loops, SQL ou segredos
literais.

```json
{
  "version": "localembed/v1",
  "providers": [{
    "name": "local_tei",
    "type": "tei",
    "dimensions": 768
  }],
  "entities": [{
    "name": "article",
    "source": { "table": "public.articles" },
    "template": "title: {{title}}\\n\\n{{body}}"
  }]
}
```

## Regras que importam

- `providers` contém endpoint, modelo, métrica, dimensão e a referência de segredo por variável de
  ambiente.
- Entidades usam chave `uuid`, `bigint`, `text` ou `ulid`; polling exige `updated_at`.
- Um provedor externo (`openai`) exige `external_data_transfer_accepted: true`.
- Destinos são nomeados explicitamente. Remover entidade desativa sua configuração; apagar dados
  requer uma ação administrativa futura.

O [schema completo](/contracts/schema/localembed.v1.schema.json) e o
[exemplo canônico](/contracts/examples/localembed.v1.example.json) são entregues pela própria imagem
de documentação.
