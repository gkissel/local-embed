# Papéis de implantação independentes

O ambiente de referência terá quatro papéis implantáveis: `worker`, que
sincroniza embeddings; `query-api`, que gera vetores de texto avulso;
`inference-server`, que hospeda modelos locais; e `dashboard`, que apresenta a
telemetria. Worker e servidor de inferência podem escalar independentemente;
PostgreSQL é a infraestrutura compartilhada e ParadeDB aparece apenas na
aplicação demonstradora de busca híbrida.
