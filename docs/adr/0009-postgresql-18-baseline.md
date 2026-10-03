# PostgreSQL 18 como baseline suportado

A primeira versão do LocalEmbed requer PostgreSQL 18 ou superior com pgvector. Limitar
explicitamente a matriz de suporte permite validar as imagens Docker, DDL, triggers e comportamento
dos índices, em vez de prometer compatibilidade com versões indeterminadas do PostgreSQL.

O ambiente local de referência usa a distribuição ParadeDB baseada em PostgreSQL 18, com `pg_search`
e pgvector no mesmo banco. A imagem e as versões das extensões serão fixadas e verificadas no perfil
de implantação. Isso permite testar a busca híbrida da aplicação demonstradora sem exigir
`pg_search` para o núcleo do LocalEmbed. A validação de sincronização também deve executar nessa
distribuição.

Esta escolha não altera o ADR-0007: embeddings continuam em destinos gerenciados, no mesmo banco das
tabelas de origem. A issue #8 deve comparar consultas híbridas com destinos separados e vetores na
origem antes de propor mudança de armazenamento.
