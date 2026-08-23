# LocalEmbed — Especificação Inicial

## Título

**LocalEmbed: uma Arquitetura Agnóstica para Geração e Sincronização Incremental de Embeddings em PostgreSQL**

## Problema e justificativa

Embeddings representam textos como vetores numéricos e viabilizam busca
semântica, recomendação e recuperação por similaridade. Embora pgvector permita
armazenar esses vetores no PostgreSQL, aplicações normalmente precisam assumir a
geração, atualização, falhas e reprocessamento. Isso acopla a aplicação ao
modelo, à estratégia de sincronização e ao provedor de inferência.

LocalEmbed propõe um artefato independente da linguagem, framework e ORM da
aplicação consumidora. Ele observa alterações em dados PostgreSQL, compõe o
conteúdo configurado, gera embeddings localmente ou por APIs externas e mantém
um destino vetorial separado e consistente de forma eventual.

## Objetivo geral

Desenvolver e avaliar o LocalEmbed como uma arquitetura agnóstica para geração e
sincronização incremental de embeddings associados a dados em PostgreSQL.

## Objetivos específicos

- Definir contratos versionados de configuração e de API para embeddings.
- Detectar alterações por `TRIGGER` ou `POLLING` configurados por entidade.
- Processar tarefas persistentes de modo assíncrono, idempotente e escalável.
- Gerar embeddings por servidor local ou API externa compatível com OpenAI.
- Armazenar vetores e seu ciclo de vida em estrutura gerenciada pelo LocalEmbed.
- Oferecer geração autenticada de embedding para textos de consulta.
- Demonstrar consumo híbrido com pgvector e pg_search/ParadeDB, sem incorporar a
  busca ao LocalEmbed.
- Avaliar cenários funcionais e métricas operacionais reproduzíveis.

## Escopo e fronteiras

O LocalEmbed suporta uma aplicação PostgreSQL 18+ por implantação, chaves de
origem `uuid`, `bigint`, `text` ou ULID textual e dependências de conteúdo
muitos-para-um declaradas. Cada entidade possui um destino de dimensão fixa no
schema `localembed` e um embedding atual por dado de origem.

Busca, ranking, RAG, gestão de usuários e mecanismo de logging próprio estão
fora do escopo. A aplicação consumidora é responsável por consultar e combinar
os resultados; o LocalEmbed é responsável por gerar, atualizar e manter o ciclo
de vida dos embeddings.

## Método de avaliação

O trabalho é desenvolvimento de artefato com avaliação experimental
quantitativa. Cenários cobrem inserção, alteração, exclusão, reprocessamento,
falha, provedores local e externo, e os modos `TRIGGER` e `POLLING`. As medições
incluem latência p50/p95/p99, throughput, profundidade e idade de fila, falhas,
retries, recursos dos serviços e indicadores PostgreSQL/HNSW. As cargas
reproduzíveis combinam dados sintéticos e um pequeno conjunto público de textos.
