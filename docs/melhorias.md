# Melhorias do LocalEmbed: registro para o artigo

Este arquivo reúne decisões, evidências e limitações das issues #3, #11, #4, #5 e #6. É um registro
técnico para apoiar a redação do artigo; as medições abaixo não constituem uma avaliação geral de
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
deve comparar as duas alternativas, registrar planos e medições e fundamentar qualquer revisão dessa
decisão. Nenhuma superioridade de desempenho foi demonstrada até aqui.

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
- [#7](https://github.com/gkissel/local-embed/issues/7): métricas que separem alterações capturadas,
  estados reunidos, inferências e eventos de lease. A contagem de linhas da fila reutilizável não
  representa histórico acumulado.
- [#8](https://github.com/gkissel/local-embed/issues/8): demonstração híbrida e comparação entre
  vetor na origem e destino separado.

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
