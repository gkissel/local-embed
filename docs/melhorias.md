# Melhorias do LocalEmbed: registro para o artigo

Este arquivo reúne decisões, evidências e limitações das issues #3, #11 e #4. É um registro técnico
para apoiar a redação do artigo; as medições abaixo não constituem uma avaliação geral de
desempenho.

## Geração e armazenamento de embeddings — issue #3

O processamento usa uma fila persistente no PostgreSQL e workers Deno. Os dados de origem permanecem
sob responsabilidade da aplicação consumidora; os vetores ficam em destinos gerenciados no schema
`localembed`, com dimensão fixa por entidade. O worker acessa o servidor TEI por uma interface
compatível com OpenAI, usando o Vercel AI SDK. Um fingerprint SHA-256 combina conteúdo renderizado e
parâmetros de geração para evitar inferência quando o embedding já corresponde à entrada.

O backfill utiliza lotes persistentes e paginação por chave tipada. Isso permite retomar o
enfileiramento sem repetir os lotes concluídos e preserva a ordenação numérica de identificadores
bigint. Migrações, backfill e construção de índices são comandos administrativos explícitos,
separados da inicialização dos workers.

A distribuição local de referência utiliza ParadeDB com PostgreSQL 18.3, pg_search 0.22.6 e pgvector
0.8.1. O modelo é `intfloat/multilingual-e5-base`, revisão
`129286372ebbc09af0394786dd03e16427ade171`, com 768 dimensões. As imagens estão fixadas por digest
nos arquivos Compose em `deployments/`.

**Benefícios:** separação entre a aplicação consumidora e a inferência; retomada do trabalho
persistido; verificação de dimensão; armazenamento idempotente por identificador; infraestrutura de
referência reproduzível.

**Custos e limites:** cada alteração relevante ainda escreve na fila; o banco assume coordenação e
armazenamento adicionais; a atualização de configurações, polling e dependências de conteúdo
permanecem pendentes. O índice HNSW atual é construído de forma transacional e bloqueia escritas no
destino durante a criação.

## Coordenação, redução de tarefas e leases — issue #11

A fila passou a reutilizar uma única tarefa por configuração, entidade e identificador de origem.
Cada alteração relevante incrementa sua geração. Updates em campos não declarados ou que mantêm o
mesmo conteúdo não enfileiram trabalho. Alterações acumuladas podem ser reunidas antes do
processamento, pois a tarefa representa o estado a produzir, em vez de armazenar todos os eventos
individuais.

Workers reservam tarefas com `SKIP LOCKED` e um token UUID. O lease é renovado periodicamente,
respeitando um limite absoluto de execução. Os valores padrão são 60 segundos de lease, renovação a
cada 20 segundos e execução máxima de 5 minutos. A perda de posse ou o esgotamento do prazo cancela
a espera pela inferência.

Antes de gravar, o worker verifica token, prazo, geração e fingerprint atual da origem. Uma resposta
antiga não pode sobrescrever a geração mais recente. A transação final segue a ordem de bloqueios da
escrita na origem para evitar inversão de locks. Uma função administrativa restrita permite adquirir
o bloqueio necessário mantendo o papel do worker sem permissão de UPDATE na origem.

**Benefícios:** menos trabalho redundante; uma reserva válida por identificador; processamento
paralelo de identificadores distintos; proteção contra respostas obsoletas; suporte a inferências
que ultrapassam o primeiro lease.

**Custos e limites:** as renovações também escrevem no banco; a comparação de campos nos triggers
consome CPU; o mesmo identificador pode sofrer contenção; o provedor pode continuar computando mesmo
após o cancelamento. Uma queda após a inferência e antes da gravação pode provocar nova chamada. A
garantia continua sendo processamento ao menos uma vez, sem promessa de inferência exatamente uma
vez. Tarefas `failed` permanecem assim, inclusive após novas alterações na origem, até que o
reprocessamento administrativo seja implementado na #6.

## Evidência experimental controlada

A comparação utilizou o estado após a #3 (`8dcbc9f`) e a implementação da #11 (`6365cee`, integrada
em `940e0f8`). A carga contém uma inserção, 50 updates em campo não utilizado, 50 atribuições que
mantêm o conteúdo e 20 mudanças reais de conteúdo. Três workers iniciam a inferência sob uma
barreira controlada.

| Indicador                             | Antes da #11 | Após a #11 |
| ------------------------------------- | -----------: | ---------: |
| Capturas de alterações                |          121 |         21 |
| Linhas na fila antes do processamento |          121 |          1 |
| Chamadas ao provedor                  |            3 |          1 |
| Linhas finais no destino              |            1 |          1 |

O provedor desta comparação foi **simulado**, permitindo controlar a concorrência. As capturas são
contadas por linhas na fila antiga e pela soma das gerações na fila nova. Esses números não incluem
escritas de reserva, renovação ou conclusão. Não foram medidos throughput, latência, CPU, bytes de
armazenamento ou WAL; não se deve deduzir dessas contagens uma melhoria geral de velocidade.

O procedimento está em [queue-coordination.md](queue-coordination.md) e
[scripts/measure_queue.ts](../scripts/measure_queue.ts). O script elimina e recria objetos de teste
e deve ser executado somente em banco descartável.

Separadamente, 15 testes de integração passaram em ParadeDB, incluindo uma verificação com o TEI
real fixado. Cobrem concorrência, mudanças durante inferência, exclusões, expiração e renovação de
leases, respostas tardias, atualização da fila antiga e acesso à origem com papel de leitura. Os
checks de formatação, lint e TypeScript também passaram. A integração real confirma funcionamento;
não substitui uma avaliação de qualidade semântica ou desempenho.

## Busca híbrida e posição dos vetores

ParadeDB permite preparar a demonstração de busca lexical com pg_search e busca vetorial com
pgvector. A aplicação consumidora pode combinar rankings pelos identificadores de origem, por
exemplo com RRF, mesmo com destinos separados.

Armazenar o vetor na tabela de origem pode simplificar consultas e algumas operações, mas introduz
mudanças no schema da aplicação consumidora. A decisão atual mantém destinos separados. A issue #8
deve comparar as duas alternativas, registrar planos e medições e fundamentar qualquer revisão dessa
decisão. Nenhuma superioridade de desempenho foi demonstrada até aqui.

## Geração de consulta autenticada — issue #4

A API `POST /v1/embeddings` recebe entidade e texto avulso, consulta a última configuração aplicada
que contém essa entidade e devolve o vetor com modelo, provedor, dimensão e fingerprint de geração.
A chave de serviço é independente da credencial do provedor. O papel de banco da API necessita
apenas de leitura da configuração; não lê dados de origem e não modifica tarefas ou destinos.

A implementação rejeita credenciais inválidas antes de consultar o banco ou fazer inferência, exige
JSON sem propriedades adicionais e limita a entrada a 32768 caracteres Unicode e o corpo a 262144
bytes. Valida a dimensão e os valores finitos do vetor, limita a espera pela inferência a 30
segundos e devolve erros sanitizados. O texto é enviado sem transformação: para o modelo de
referência, a aplicação consumidora inclui o prefixo `query:`. A API não executa busca nem persiste
consultas.

**Benefícios:** contrato estável para aplicações consumidoras, configuração de modelo centralizada e
separação entre acesso à API e acesso ao provedor.

**Custos e limites:** cada consulta aceita lê a configuração e chama o provedor; não há cache, quota
por consumidor ou retry automático. A chave compartilhada permite acesso a todas as entidades
aplicadas. O limite de caracteres não substitui o limite de tokens do modelo. O controle completo de
ativação e substituição de versões ainda depende da #6. A qualidade da busca depende também do
modelo, preparação do texto e consulta realizada pela aplicação consumidora.

Três testes da API verificam autenticação, entradas inválidas, metadata, determinismo do
fingerprint, vetores inválidos e timeout. Um teste de integração verifica a leitura da configuração
por papel restrito, a seleção por entidade e versão e o protocolo do provedor com servidor
compatível simulado. A verificação adicional com TEI real está documentada como opcional no README;
não foi executada novamente para a #4. Nenhuma medição de latência ou qualidade foi feita para a
API.

## Melhorias pendentes e rastreabilidade

- [#4](https://github.com/gkissel/local-embed/issues/4): API autenticada de geração de consulta, com
  contrato OpenAPI e limites de entrada.
- [#6](https://github.com/gkissel/local-embed/issues/6): classificação de falhas, retries limitados
  com backoff e jitter, reprocessamento administrativo e versões imutáveis de configuração.
- [#12](https://github.com/gkissel/local-embed/issues/12): retenção e limpeza da estrutura auxiliar.
  Reutilizar tarefas reduz crescimento por evento, mas não elimina crescimento por novos
  identificadores ou configurações.
- [#13](https://github.com/gkissel/local-embed/issues/13): construção concorrente de HNSW, com
  acompanhamento de falhas e estado do índice.
- [#5](https://github.com/gkissel/local-embed/issues/5): polling, reconciliação e dependências de
  conteúdo.
- [#7](https://github.com/gkissel/local-embed/issues/7): métricas que separem alterações capturadas,
  estados reunidos, inferências e eventos de lease. A contagem de linhas da fila reutilizável não
  representa histórico acumulado.
- [#8](https://github.com/gkissel/local-embed/issues/8): demonstração híbrida e comparação entre
  vetor na origem e destino separado.

Para o artigo, separar três tipos de afirmação: propriedades asseguradas pela implementação e
testes; contagens observadas no experimento controlado; hipóteses que ainda exigem avaliação.
Avaliações futuras devem registrar conjunto de dados, recursos, concorrência, modelo e revisão,
duração, latências, throughput, consumo do banco e qualidade da recuperação.
