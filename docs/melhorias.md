# Melhorias do LocalEmbed: registro para o artigo

Este arquivo reúne decisões, evidências e limitações das issues #3, #11, #4, #5, #6, #7 e #8. É um
registro técnico para apoiar a redação do artigo; as medições abaixo não constituem uma avaliação
geral de desempenho.

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
armazenamento adicionais; alterações de configuração agora usam destino novo e ativação explícita
(#6). Polling e dependências diretas de conteúdo foram implementados na #5, descrita abaixo. O
índice HNSW atual é construído de forma transacional e bloqueia escritas no destino durante a
criação.

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
vez. Tarefas `failed` permanecem assim, inclusive após novas alterações na origem, até
reprocessamento administrativo explícito, entregue na #6.

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
registrou uma comparação inicial, com planos e medições descritos abaixo. Os resultados limitados
não demonstram superioridade geral nem justificam revisão dessa decisão.

## Geração de consulta autenticada — issue #4

A API `POST /v1/embeddings` recebe entidade e texto avulso, consulta a configuração ativa aplicada
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
por consumidor. Retries limitados foram adicionados na #6. A chave compartilhada permite acesso a
todas as entidades aplicadas. O limite de caracteres não substitui o limite de tokens do modelo. O
controle completo de ativação e substituição de versões foi implementado na #6. A qualidade da busca
depende também do modelo, preparação do texto e consulta realizada pela aplicação consumidora.

Três testes da API verificam autenticação, entradas inválidas, metadata, determinismo do
fingerprint, vetores inválidos e timeout. Um teste de integração verifica a leitura da configuração
por papel restrito, a seleção por entidade e versão e o protocolo do provedor com servidor
compatível simulado. A verificação adicional com TEI real está documentada como opcional no README;
não foi executada novamente para a #4. Nenhuma medição de latência ou qualidade foi feita para a
API.

## Polling e dependências de conteúdo — issue #5

O LocalEmbed passou a aceitar detecção por polling, com cursor persistente formado por timestamp e
identificador tipado, lotes limitados e preservação de microssegundos. Uma janela incremental com
sobreposição acelera a detecção. A reconciliação completa percorre origens e destinos por chave para
encontrar commits atrasados, mudanças atrás do cursor e embeddings órfãos após exclusões físicas.
Cursor, fase e limites superiores da varredura ficam persistidos junto ao enfileiramento.

Dependências diretas muitos-para-um são explícitas: uma coluna do Produto aponta para a chave única
da Categoria, e o template pode usar `{{category.name}}`. Em trigger, mudanças relevantes na
Categoria enfileiram os Produtos afetados. Em polling, a reconciliação detecta alterações na
Categoria sem exigir mudança no timestamp do Produto. Antes de gravar, o worker verifica e bloqueia
os dados de origem e de suas dependências por funções restritas, mantendo os papéis de runtime sem
UPDATE nas tabelas da aplicação consumidora.

**Benefícios:** funcionamento sem triggers de captura em modo polling; retomada após reinício;
suporte a conteúdo relacionado; limpeza eventual de vetores órfãos; verificação de respostas antigas
mesmo quando não houve captura transacional.

**Custos e limites:** consultas periódicas, cálculo de fingerprints e varreduras completas aumentam
a carga no banco. Exclusões físicas, commits muito atrasados e mudanças apenas nas dependências
podem esperar a reconciliação; intervalo, duração da varredura e backlog influenciam o atraso. Um
pai com muitos registros dependentes pode tornar sua transação cara no modo trigger. Locks finais
podem disputar acesso com a aplicação. Não há suporte a coleções, dependências encadeadas ou
autorrelações. Polling observa o estado atual e não reconstrói todos os estados intermediários.
Tarefas com falha exigem reprocessamento administrativo explícito, entregue na #6.

Sete testes novos verificam cursores, retomada, precisão, commits atrasados, concorrência,
exclusão/reinserção, fan-out, rollback e privilégios de runtime em ParadeDB com inferência simulada.
O procedimento e a política de completude estão em
[polling-dependencies.md](polling-dependencies.md). Não foram feitas medições de throughput,
latência ou qualidade de recuperação para esta entrega.

## Configurações e tarefas resilientes — issue #6

O worker e a API passaram a compartilhar a classificação de falhas. Erros transitórios utilizam
tentativas limitadas, backoff exponencial, jitter e Retry-After; autenticação, configuração,
dimensão incompatível e outras falhas terminais interrompem as tentativas automáticas. Na fila, o
próximo horário de tentativa e o orçamento da geração são persistidos. Na API, as tentativas ficam
limitadas ao prazo total da requisição, sem enfileirar nem persistir consultas.

O comando administrativo de reprocessamento seleciona tarefas com falha, registra o principal do
banco e os diagnósticos sanitizados em uma trilha de ações e reinicia o orçamento para a geração
mais recente. Mudanças no dado de origem não apagam automaticamente os diagnósticos de uma tarefa já
falhada. Categorias de erro e status HTTP ficam disponíveis no estado da fila e nos logs
estruturados; métricas acumuladas e dashboard continuam na #7.

Configurações persistidas são imutáveis. Uma atualização prepara uma revisão candidata em destino
novo; a revisão ativa continua disponível enquanto o candidato recebe backfill e processamento. A
ativação explícita verifica conclusão, índice HNSW válido, fingerprints atuais e ausência de órfãos.
Na mesma transação, desativa a revisão anterior, remove sua captura, invalida tokens e impede novos
trabalhos antigos. A API passa a selecionar a revisão ativa e identificá-la nos metadados. O
cancelamento de um candidato preserva a revisão ativa. Destinos anteriores não são removidos
implicitamente.

**Benefícios:** recuperação automática limitada para falhas transitórias; retomada de agendamentos
após reinício; diagnóstico sanitizado e reprocessamento auditado; troca de modelo/dimensão com
validação prévia; bloqueio de respostas antigas após ativação, incluindo workers já realizando
inferência e pollers de revisões retiradas.

**Custos e limites:** retries podem repetir computação e aumentar a carga. Revisões novas exigem
outro destino e backfill, inclusive quando só parâmetros mudam; destinos antigos e ações
administrativas consomem espaço até a política de retenção (#12). Ativação bloqueia escritas nas
origens/dependências durante a validação completa e pode exigir janela de manutenção. A identidade
das origens e relações é mantida; mudanças dessa identidade exigem outra entidade. Retorno a
parâmetros anteriores após ativação exige nova preparação e atualização dos vetores; não há rollback
imediato para um snapshot possivelmente desatualizado. Cancelamento não assegura interromper a
computação no servidor de inferência.

A suíte passou com 28 testes de integração em ParadeDB, incluindo quatro novos cenários de
recuperação e revisões e um cenário HTTP pelo SDK real, com respostas 429 e 503 antes do sucesso.
Dois testes adicionais cobrem classificação, delays, cancelamento e prazo da API. A inferência foi
simulada nesta entrega: a verificação com modelo real permanece na #17. Não há medições novas de
throughput, latência, custo dos locks ou qualidade semântica. Operação e permissões estão em
[resilience.md](resilience.md).

## Melhorias pendentes e rastreabilidade

- [#12](https://github.com/gkissel/local-embed/issues/12): retenção e limpeza da estrutura auxiliar.
  Reutilizar tarefas reduz crescimento por evento, mas não elimina crescimento por novos
  identificadores ou configurações.
- [#13](https://github.com/gkissel/local-embed/issues/13): construção concorrente de HNSW, com
  acompanhamento de falhas e estado do índice.

Para o artigo, separar três tipos de afirmação: propriedades asseguradas pela implementação e
testes; contagens observadas no experimento controlado; hipóteses que ainda exigem avaliação.
Avaliações futuras devem registrar conjunto de dados, recursos, concorrência, modelo e revisão,
duração, latências, throughput, consumo do banco e qualidade da recuperação.

As limitações da API também foram registradas em
[#14](https://github.com/gkissel/local-embed/issues/14) (preparação e tokens),
[#15](https://github.com/gkissel/local-embed/issues/15) (credenciais, quotas e concorrência),
[#16](https://github.com/gkissel/local-embed/issues/16) (cache) e
[#17](https://github.com/gkissel/local-embed/issues/17) (verificação da API com TEI real). Retries
síncronos fazem parte da #6; implantação, métricas e avaliação foram complementadas nas #9, #7 e
#10.

As mitigações de polling e dependências foram registradas em
[#18](https://github.com/gkissel/local-embed/issues/18) (leituras em lote e intervalo adaptativo),
[#19](https://github.com/gkissel/local-embed/issues/19) (cursores de dependências e tombstones),
[#20](https://github.com/gkissel/local-embed/issues/20) (invalidação com expansão assíncrona),
[#21](https://github.com/gkissel/local-embed/issues/21) (coleções e caminhos explícitos) e
[#22](https://github.com/gkissel/local-embed/issues/22) (avaliação de CDC). Falhas e reprocessamento
foram entregues na #6; as medições de custo e atraso foram acrescentadas à #10. As mitigações
#18–#22 estão planejadas, não implementadas.

## Mitigações de resiliência planejadas

As limitações da #6 têm os seguintes encaminhamentos. Ainda não são garantias implementadas:

- #25: reutilizar inferência bem-sucedida por fingerprint e parâmetros, limitar cache e verificar
  suporte explícito a idempotência do provedor. Uma resposta perdida pode repetir cálculo; sem
  cooperação do provedor não há garantia de execução única. O cache da API permanece na #16.
- #23 (P1): validar o snapshot antes da ativação, acompanhar alterações concorrentes e conferir
  apenas o delta sob uma barreira curta. Exige protocolo que cubra commits tardios e exclusões;
  medir tempo de bloqueio antes de afirmar redução.
- #12: reter destinos por idade e quantidade, preservar revisões ativas/em preparação e janela de
  rollback, oferecer simulação e impedir limpeza com execuções/leitores ainda em uso.
- #24 (P2): manter a revisão anterior sincronizada durante uma janela limitada de rollback. Reduz
  tempo de recuperação ao custo de escritas, armazenamento e possivelmente inferência duplicados.
  Fora da janela, reconstruir continua necessário.
- #17 (P1): executar inferência com TEI/modelo fixados e testar limites, prefixo, dimensão e
  cancelamento. Um proxy de falhas verifica 429/503 e perda de resposta, distinguindo falha simulada
  da execução real do modelo.

## Telemetria operacional e dashboard — issue #7

**O que foi feito:** OpenTelemetry instrumenta worker, API e poller; Grafana é provisionado com 16
painéis sobre Prometheus, Loki e Tempo. Um processo separado lê snapshots com permissões somente de
leitura. Capturas/enfileiramentos e trabalho reunido têm contadores transacionais separados da fila
reutilizável; idade de execução usa timestamp de aquisição, separado da idade do trabalho
solicitado. Logs/traces incluem contexto de tarefa sem conteúdo ou vetores.

**Pontos positivos:** o operador consegue distinguir profundidade atual, solicitações capturadas,
inferências, resultados, retries, leases e reconciliação. Limpeza de tarefas não apaga os contadores
persistidos. Logs carregam IDs de trace para investigação; filtros do Collector excluem
instrumentação automática com URLs e logs fora do formato sanitizado.

**Pontos negativos:** contadores adicionam uma escrita por enfileiramento e possíveis disputas entre
transações, mesmo com 16 shards. Snapshots leem a fila periodicamente e ficam antigos se o banco
falhar. Eventos de processo podem se perder antes da exportação ou durante indisponibilidade do
backend; não substituem auditoria durável. A stack LGTM é de referência local, consome recursos e
ainda exige política de retenção/segurança para produção (#9/#12). A API identifica apenas a chave
de serviço compartilhada; identidades, quotas e cache continuam nas #15/#16.

**Evidências:** testes determinísticos verificam contadores após rollback, migração e remoção de
tarefas concluídas, zeros na fila e acesso somente de leitura; o teste de privacidade rejeita campos
extras e credenciais. Smoke de exportação verificou métricas em Prometheus, logs em Loki, trace em
Tempo e provisionamento dos painéis; inferência foi simulada. Não houve benchmark de throughput,
custo dos contadores ou qualidade semântica. Operação e reprodução em [telemetry.md](telemetry.md).

## Mitigações da telemetria planejadas

- #26: contadores persistentes configuráveis e snapshots adaptativos; desativar contadores sacrifica
  histórico acumulado. Agregação assíncrona/contadores incrementais só depois das medições da #10.
- #10: medir escrita adicional, disputas, EXPLAIN das consultas, frequência, amostragem e perdas.
- #9: exportação no desligamento, fila persistente no Collector, amostragem, recursos e
  TLS/auth/rede. A fila protege eventos já recebidos pelo Collector, não eventos ainda no processo
  que caiu.
- #12: retenção dos backends e classificação de eventos críticos; auditoria/contadores de banco já
  são duráveis. Outbox transacional apenas se houver lacunas críticas de recuperação/auditoria.

Estas mitigações estão planejadas. Não há garantia de ausência de perdas ou overhead zero.

## Busca híbrida na aplicação demonstradora — issue #8

**O que foi feito:** a aplicação consumidora usa a API para gerar o vetor de consulta e combina
BM25/pg_search com pgvector por RRF ponderado. Os dois ramos aplicam tenant/publicação, desempate
numérico por identificador e limites declarados. A revisão é resolvida no snapshot da consulta;
vetores incompatíveis provocam nova geração limitada. Uma consulta já iniciada pode concluir na
revisão anterior retida. Fingerprints excluem embeddings desatualizados mesmo após limpeza da fila.

**Pontos positivos:** busca e ranking continuam pertencendo à aplicação consumidora; o LocalEmbed
não recebe API de busca. O consumidor usa acesso somente de leitura. A fusão não precisa normalizar
escores BM25 e distância. Existe comparação reproduzível com vetores na mesma tabela, planos e
resultados equivalentes para o modo exato, sem alterar o ADR-0007.

**Pontos negativos:** verificar fingerprints acrescenta leituras/cálculo por candidato. O pool
limitado pode produzir menos candidatos semânticos quando há muitos vetores desatualizados; HNSW é
aproximado e filtros podem mudar o plano/recall. Ativações podem repetir inferência de consulta, e
leitores exigem retenção/grace de destinos antigos. Filtros SQL dependem de um tenant derivado de
autorização real pela aplicação; esta CLI é uma demonstração para operador confiável.

**Medições:** 512 registros, vetores densos determinísticos de três dimensões, 5 warmups e 30
amostras pareadas em ordem alternada. Índices BM25 foram reconstruídos após a carga em ambos os
layouts. p50/p95: separado 4,72/5,52 ms; mesma tabela 4,60/6,20 ms. Isso inclui consulta, checagem
de fingerprint e fusão, mas exclui HTTP/inferência. A pequena diferença não sustenta uma conclusão
geral sobre armazenamento, sobretudo para E5 de 768 dimensões. O histórico inicialmente desigual dos
índices foi um viés identificado e corrigido antes dessas medições.

**Contenção e migração:** a escrita isolada no destino não bloqueou a origem; o protocolo real do
worker com lock de origem bloqueou, assim como escrever vetor na mesma linha. O probe DDL criou um
destino vazio de quatro dimensões em 1,28 ms; alterar a coluna da tabela experimental em 11,66 ms
tomou lock exclusivo e reconstruiu índices. São operações de escopos diferentes, sem
backfill/ativação; não são tempos de migração completa. Um trigger experimental protegido ignorou a
escrita de vetor e capturou a de conteúdo, ilustrando a prevenção de ciclos de reprocessamento.

**Evidências e limites:** cinco testes de integração cobrem BM25/pgvector reais, API HTTP com
inferência simulada, filtros, configuração concorrente, snapshot retido, freshness, layouts e
permissões. A execução com TEI real continua na #17; avaliação geral/qualidade permanece na #10.
Operação em [hybrid-search.md](hybrid-search.md); dados/planos completos em
[evaluation/hybrid-storage.json](evaluation/hybrid-storage.json).

## #9 — Implantação de referência com Compose e Helm

**O que mudou:** uma imagem Deno com dependências travadas executa worker, API, poller, snapshot e
administração. Compose inicia ParadeDB/pgvector/pg_search no mesmo banco, TEI E5 real e LGTM; Helm
reutiliza as imagens, com réplicas, recursos, PVCs, secrets e endpoints configuráveis. O bootstrap
administrativo cria o demonstrador/BM25, aplica a configuração e distribui grants mínimos antes de
liberar a execução. As credenciais administrativas não chegam aos runtimes.

**Pontos positivos:** ambiente reproduzível e testado com inferência real; inicialização não destrói
volumes existentes; consumidor SQL recebe somente leitura. A API e o modelo têm chaves separadas.
Workers renovam a posse, cada réplica recebe identidade de telemetria própria e o snapshot permanece
único. Filas persistentes e limitadas no Collector mitigam indisponibilidade do backend. Foram
provisionados alertas de freshness, saúde do Collector, pressão/rejeição de fila, amostragem de
traces e limites de CPU/memória. A implantação Helm foi exercitada em Kind, inclusive duas réplicas
de worker/API e consulta real.

**Pontos negativos:** a stack completa consome CPU/memória e precisa baixar/aquecer o modelo;
Compose usa arquivos locais de secrets, sem criptografia por secret manager. Persistência do
Collector adiciona fsync e espaço em disco; não protege o buffer ainda na aplicação nem garante
entrega quando a fila/disco esgota. SIGKILL não permite exportação final. LGTM é um demonstrador sem
alta disponibilidade; produção exige serviços externos dimensionados, TLS/autenticação e roteamento
de alertas. GPU e enforcement de NetworkPolicy não foram validados no Kind, que usa CNI sem
enforcement.

**Mitigações e pendências:** produção possui guardas para evitar usar o bundle/banco de demonstração
ou OTLP desprotegido. #27 registra validação real de CNI, TLS, storage, rotação/recuperação e GPU;
#10 mede carga/volume/overhead. Quotas/permissões por consumidor continuam na #15; preparação de
prefixo/token na #14; retenção na #12; índice online na #13; suite ampliada TEI na #17; redução de
custo de counters/snapshot na #26. O limite de concorrência TEI vale por réplica de inferência, não
como quota global. Ativação e construção HNSW atuais ainda podem bloquear escritas.

**Evidências:** check estático e dez testes comuns passaram; 34 integrações passaram em ParadeDB
PostgreSQL 18.3, pg_search 0.22.6 e vector 0.8.1. Compose e Kind processaram oito embeddings reais
de 768 dimensões e retornaram consulta API com revisão aplicada; busca híbrida usou consumidor
somente leitura. Testes com Collector real cobriram backend indisponível, reinício com dados
persistidos, fila cheia, limite de storage e disco cheio. Exportação final foi observada após
SIGTERM; SIGKILL terminou sem finalização. Quatro runtimes reais encerraram com código zero.
Autenticação Grafana foi validada inclusive em volume novo, rejeitando a senha padrão.

**Problemas encontrados na validação:** permissões entre UIDs diferentes impediam leitura dos
secrets; newline em secret utilizado como variável de ambiente invalidava a autenticação TEI;
`GF_*__FILE` não é processado pelo entrypoint do bundle LGTM. Corrigimos montagem/leitura,
normalização e inicialização explícita da senha. Esses problemas só apareceram ao executar os
ambientes reais, não no lint dos manifests. Operação e limites em [deployment.md](deployment.md).

### Mitigações operacionais após #9

Reduzir consumo começa pelas medições da #10: separar aquecimento do modelo de operação contínua,
ajustar réplicas, batches e concorrência e permitir desligar o dashboard local. A #26 trata
frequência adaptativa de snapshot/export e volume de logs, preservando freshness e os filtros de
conteúdo seguro.

SIGTERM e prazo de encerramento mitigam perdas nos buffers; monitoração de disco e rejeição de fila
revela falhas de persistência. Para eventos críticos não cobertos por admin_actions/counters
existentes, a #12 define classificação e eventual outbox transacional com confirmação/reenvio
idempotente e retenção limitada. Não há garantia universal de entrega nem intenção de persistir todo
log.

A #27 valida a substituição do LGTM por backends separados/gerenciados, persistência, retenção e
roteamento externo de alertas; TLS/auth e acessos negados precisam de testes reais com CNI que
aplique as políticas. GPU requer imagem compatível fixada e device plugin, não apenas reserva de
recurso. A #15 separa credenciais/permissões por consumidor e aplica quotas/concorrência
compartilhadas entre réplicas, evitando multiplicar limites ao escalar. A prioridade operacional é
validar isolamento, TLS e autorização antes de exposição pública, usando medições para dimensionar
quotas e recursos.

### #12 — retenção administrativa com proteção de leitores

**O que mudou:** tarefas concluídas recebem timestamp; uma política persistida controla idade e
lotes. CLI possui dry-run e limpeza efetiva; Helm oferece CronJob opcional. Destinos aposentados
respeitam idade, quantidade de revisões, prazo de execuções e leitores. O consumidor híbrido adquire
um lock compartilhado antes do snapshot e consulta do ponteiro. Falhas são preservadas, incluindo
as superseded sem mensagem de erro; limpeza das tarefas restantes retoma em novas passagens.
Counters de captura não são apagados e totais de limpeza sobrevivem à retenção opcional da auditoria.
LGTM tem retenção explícita: Prometheus 7 dias/1 GB, Loki e Tempo 168 horas.

**Positivos:** crescimento das tarefas concluídas controlável; manutenção previsível por lote;
concorrência com enqueue e workers protegida; destinos antigos não somem durante snapshots
cooperativos; métricas cumulativas e diagnóstico sobrevivem à limpeza. Defaults conservadores,
sem drop de destinos ou expiração de auditoria automática.

**Negativos:** timestamp/índice acrescentam escrita e manutenção; cada passagem consulta revisões
aposentadas, ainda sem paginação dessa listagem. Lock global de leitores pode adiar drops de outras
entidades. Habilitar drop exige atualizar todos os consumidores e reconhecer o protocolo; não é
possível detectar leitores externos que ainda não acessaram a tabela. Falhas, configurações e
metadados forenses continuam ocupando espaço. DELETE exige vacuum e não equivale a devolver disco;
retenção dos backends também é assíncrona. Retenção finita reduz o histórico disponível para análise.

**Evidência:** quatro cenários novos de integração cobrem cutoff, locks, snapshots, retomada,
enqueue concorrente e agregados após pruning. Probe sintético com 10000 tarefas: plano indexado
0,090 ms e 104 buffers contra 1,043 ms e 273 sem índice, uma amostra com cache aquecido. Não é
benchmark de produção nem teste TEI; artefato [evaluation/retention.json](evaluation/retention.json).
Operação, política, classificação de durabilidade e limites em [retention.md](retention.md).

**Mitigações restantes:** #10 mede throughput/overhead/volume antes de particionar ou mudar batch;
#26 trata custo de captura/snapshot; #27 valida backends, storage e alertas em produção. Outbox só
será necessário para um novo requisito crítico que não esteja coberto pelo estado e auditoria
transacionais; logs normais continuam sujeitos a perdas de buffer/exportação.

**Validação final:** 38 integrações e 11 testes comuns passaram; check estático e packaging
Compose/Helm também. A imagem administrativa executou dry-run/apply; os binários Loki e Tempo
da imagem fixada validaram suas configurações. O CronJob foi renderizado, não executado em
Kubernetes nesta entrega; expiração real após sete dias não foi aguardada.

### Mitigações de retenção após #12

Lotes/frequência fora de pico e autovacuum precisam de medição de backlog, WAL, latência, tuplas
mortas e espaço reutilizado (#10). Particionamento depende do volume medido; VACUUM FULL exige
janela planejada. Timeout de consultas/transações, alertas de snapshots longos e migração gradual
com DROP desabilitado integram #27. A #28 fornece helper compartilhado e proteção por destino para
não adiar limpeza de entidades independentes. A #29 define investigação/resolução, arquivamento e
retenção de falhas/metadados, preservando trabalho acionável e a janela de rollback da #24.

### #13 — construção HNSW concorrente e retomável

**O que mudou:** `build-indexes --concurrently` executa CREATE/DROP INDEX CONCURRENTLY fora de
transações explícitas, com posse administrativa na mesma sessão física até o encerramento.
Inspeciona definição, destino, coluna, métrica, parâmetros e flags de validade;
reutiliza índice correto, corrige metadados e recria somente índice inválido com definição esperada.
Ativação usa a mesma validação. Backfill enfileirado precisa terminar; fila incremental pode continuar
ocupada. O modo comum permanece para carga inicial offline. Auditoria registra início/fim por entidade.

**Positivos:** escritas continuam durante construção concorrente; retomada após cancelamento/crash;
conflitos de nome/definição não são apagados automaticamente; posse impede administradores de
concorrer com ativação/limpeza; nenhum DDL foi adicionado ao startup dos workers.

**Negativos:** construção concorrente faz mais trabalho e pode esperar transações/snapshots longos;
HNSW consome CPU, memória, I/O e WAL e pode disputar recursos com consultas. O lock administrativo
global adia outras operações, incluindo retenção. Não há prazo fixo para construir índice; timeout
fica na política do papel/banco. Uma execução com várias entidades pode terminar parcialmente,
pois DDL concorrente não oferece rollback único para toda a execução. Ativação ainda bloqueia
escritas na origem; a #23 trata esse ponto.

**Evidência:** 41 testes de integração passaram, incluindo cancelamento, índice inválido e perda
real de sessão administrativa; 11 testes comuns passaram. Probe com 10000 vetores sintéticos de
64 dimensões: construção comum ~1039 ms, escrita interrompida por timeout de 1000 ms; concorrente
~1021 ms, escrita confirmada em ~2,4 ms durante CREATE INDEX. Uma amostra por modo, sem medição de
CPU/memória/I/O nem inferência real; não demonstra superioridade de throughput/duração em produção.
Artefato [evaluation/indexes.json](evaluation/indexes.json); operação em
[online-indexes.md](online-indexes.md). Dimensionamento comparativo segue na #10; produção na #27.

**Problema encontrado:** no teste de encerramento forçado da sessão, tentar desbloquear por SQL na
conexão reservada já quebrada podia impedir a finalização do comando. A correção encerra a sessão
física com prazo de fechamento, liberando a posse sem uma nova consulta nessa conexão. O teste
verifica recuperação por uma nova execução.

**Validação final:** check estático passou; a imagem runtime foi reconstruída e executou
`admin build-indexes --concurrently` no ParadeDB real. Os testes desta entrega não acrescentam
validação TEI/GPU/Kubernetes; essas evidências permanecem nas issues específicas.

### Pesquisa de mitigações após #13

A pesquisa com fontes oficiais PostgreSQL 18 e pgvector v0.8.1 está em
[research/index-operation-mitigations.md](research/index-operation-mitigations.md). Limitar CPU e
memória do container administrativo não controla os recursos consumidos pelo backend SQL.
Memória de manutenção, paralelismo, shared memory e concorrência real devem caber no orçamento do
PostgreSQL, preservando capacidade para consultas e workers (#10/#27).

Monitorar fase do índice, lockers e idade de transações/snapshots; distinguir timeout de instrução,
lock e transação ociosa. Cancelar só o backend identificado e validar recuperação (#27). O protocolo
administrativo por recurso da #30 precisa coordenar build/activate/cancel/retention, mantendo posse
na sessão física; retirar o lock global sem esse protocolo cria corridas com DROP e ponteiros.
A #23 pré-valida e verifica delta durável sob fence final curto, incluindo deletes, dependências e
commits tardios; ID sequencial não é watermark de commit. Não há promessa de ativação sem bloqueio.

### #10 — baseline de avaliação reproduzível com TEI real

**O que mudou:** `deno task evaluate` prepara banco/TEI isolados com imagens/revisão fixadas, usa
16 fontes sintéticas, 12 registros públicos USGS arquivados e quatro fontes polling, executa nove
cenários e publica relatório JSON com amostras brutas. Registra configuração, imagens, host, hashes
do harness/dados, percentis e definição de latência, throughput de tarefas, fila, captura,
retries/falhas, leases, snapshot, consulta, HNSW, WAL observado e limpeza. Verifica fingerprints e
768 dimensões para os 31 embeddings restantes. Defaults de experimento não alteram produção.

**Positivos:** evidência real do modelo, repetição do workload sem depender de um feed público
mutável, duas falhas injetadas separadas de erros naturais, conservação de counters comprovada após
limpeza de 32 tarefas, recursos do banco/TEI medidos separadamente e artefatos auditáveis. Wrapper
recusa containers existentes e banco ocupado e remove somente seu ambiente descartável.

**Negativos:** workload pequeno, uma baseline por relatório e poucas amostras de recursos; não
estima capacidade de produção nem qualidade semântica. Admin/workers/poller/API/snapshot compartilham
um processo, sem custo por papel individual. Latência é requested-to-completed da última geração;
coalescência omite versões intermediárias e polling pré-captura não entra nessa métrica. WAL é
assíncrono/global; picos de memória são amostrados. Aquecimento/download não integram as fases.
TEI continua consumindo recursos e depende de modelo/cache/rede no preparo.

**Escopo ampliado preservado:** comparações com mais dados, amostras repetidas, carga concorrente,
recursos por papel, recall/layout 768D, cache/quotas, polling/dependências e telemetria ficam na #31,
com dependências nativas para funcionalidades ainda não implementadas. Os requisitos de medição
acumulados na #10 foram movidos integralmente para essa fase; não foram tratados como benchmarks
já executados. A baseline mede o comportamento atual, não entrega essas otimizações.

**Evidência:** nove cenários e 75 tentativas registradas, duas falhas intencionalmente injetadas e
zero falhas naturais observadas nessa execução. A avaliação verificou 31 embeddings atualizados,
renovação de lease e exclusão via reconciliação; seis consultas reais e dez snapshots foram medidos.
41 integrações e 12 testes comuns passaram, além dos checks estáticos. Dados e limites em
[artifact-evaluation.md](artifact-evaluation.md); resultados em
[evaluation/artifact-summary.md](evaluation/artifact-summary.md).

**Checagem de preparo:** o servidor PostgreSQL temporário da inicialização pode responder por
socket Unix antes de o servidor final estar pronto. O driver exige SELECT via TCP autenticado,
além da saúde do TEI. Testes de recusa preservaram container existente e uma tabela não relacionada
em banco ocupado, sem criar o schema gerenciado.
