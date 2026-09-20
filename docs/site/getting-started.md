---
title: Visão geral
url: /getting-started/
---

<p class="kicker">COMEÇAR</p>

# Comece pela configuração aplicada

LocalEmbed mantém embeddings alinhados a dados PostgreSQL a partir de uma configuração declarativa.
Você descreve entidades, provedores e o conteúdo que será vetorizado; a ferramenta aplica uma versão
imutável dessa intenção antes de qualquer processamento.

## Escreva uma configuração

Toda configuração começa com a versão de contrato `localembed/v1`. Use o exemplo canônico como ponto
de partida e adapte os nomes de entidade, fonte e provedor:

```json
{
  "version": "localembed/v1",
  "providers": [{ "name": "local_tei", "type": "tei", "dimensions": 768 }],
  "entities": [{ "name": "article", "provider": "local_tei" }]
}
```

O contrato exige os demais campos necessários para uma entidade completa, incluindo tabela de
origem, chave, template e destino. Ele impede SQL livre, segredos literais e templates executáveis.

## Aplique com segurança

Uma configuração não se torna ativa apenas por existir. O comando administrativo de aplicação, que
será introduzido junto ao runtime, valida, persiste e reconcilia as entidades afetadas. Workers usam
somente uma versão aplicada e imutável.

## O que esta referência oferece hoje

Esta documentação já publica os contratos verificáveis de configuração e de consulta. A execução de
PostgreSQL, fila, worker, inferência e API HTTP chega em etapas posteriores.

## O que vem depois

Os contratos já descrevem a configuração que será aplicada por um comando administrativo e a API que
usará esse estado aplicado. Eles ainda não implementam banco, fila, worker, servidor de inferência
ou endpoint HTTP.
