# Embeddings no schema gerenciado do LocalEmbed

Os vetores serão armazenados no destino gerenciado `localembed`, separado das
tabelas de origem. Aplicações consumidoras podem consultar esse destino por
chave e criar índices pgvector nele; uma demonstração integrará os vetores com
BM25/pg_search por SQL, mas o LocalEmbed não será responsável pela busca híbrida
nem exigirá uma coluna vetorial no schema da aplicação. Cada entidade receberá
um destino próprio de dimensão fixa, para que seus índices pgvector sejam
eficientes mesmo quando entidades usam modelos diferentes.

Os destinos criam HNSW por padrão, com parâmetros configuráveis. HNSW oferece
melhor troca velocidade/recall que IVFFlat e não exige treinamento, mas consome
mais memória e demora mais para construir; essas propriedades serão documentadas
e observadas na avaliação.

Cada entidade declara a métrica de distância, com cosseno como padrão, e o tipo
de armazenamento `vector` ou `halfvec`; este último permite dimensões acima do
limite de `vector` com menor precisão. A configuração é validada por preflight
antes de criar destinos ou iniciar backfill, e o HNSW é construído depois do
backfill inicial.
