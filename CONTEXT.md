# LocalEmbed

LocalEmbed é uma solução independente da aplicação consumidora para gerar e
manter embeddings locais derivados de dados armazenados no PostgreSQL.

## Language

**Aplicação consumidora**:
A aplicação existente que é proprietária dos dados de origem e que usa os
embeddings produzidos pelo LocalEmbed. Pode usar qualquer linguagem, framework
ou ORM.
_Avoid_: aplicação cliente, sistema monitorado

**Dado de origem**:
Um registro pertencente à aplicação consumidora, configurado como entrada para
geração de embeddings.
_Avoid_: documento, entidade monitorada

**Embedding atualizado**:
O vetor que corresponde ao fingerprint da versão processada do conteúdo de um
dado de origem e da configuração de geração aplicável, incluindo o modelo.
_Avoid_: embedding válido, embedding sincronizado

**Ciclo de vida de embeddings**:
A identificação de dados de origem que exigem processamento, a geração,
armazenamento, atualização, falha e reprocessamento dos seus embeddings.
_Avoid_: busca vetorial, recuperação de informação

**Estrutura auxiliar**:
As tabelas, funções e demais objetos PostgreSQL pertencentes ao LocalEmbed e
separados das tabelas que pertencem à aplicação consumidora.
_Avoid_: tabelas da aplicação, esquema de origem

**Destino gerenciado**:
A tabela de embeddings no schema `localembed`, proprietária dos vetores,
fingerprints e referências às chaves dos dados de origem.
_Avoid_: coluna de vetor da aplicação, tabela de origem

**Destino da entidade**:
A tabela de vetores de dimensão fixa criada no schema gerenciado para uma única
entidade configurada. Cada destino pode ter índices pgvector adequados à sua
dimensão.
_Avoid_: tabela global de vetores, coluna da origem

**Aplicação LocalEmbed**:
Uma instância do LocalEmbed conectada a um único banco PostgreSQL 18 ou superior
e responsável pelas entidades declaradas em uma versão aplicada de configuração.
_Avoid_: serviço multi-banco, instalação global

**Geração de consulta**:
A produção de um embedding a partir de texto avulso fornecido por uma aplicação
consumidora, para que ela própria o empregue em uma consulta por similaridade.
_Avoid_: busca, ranking, recuperação

**Tarefa de embedding**:
Uma unidade persistente de trabalho que registra a geração ou atualização de um
embedding para um dado de origem.
_Avoid_: evento, mensagem

**Processamento ao menos uma vez**:
Garantia de que uma tarefa pode ser executada repetidamente, exigindo operações
idempotentes para que o estado final do embedding seja correto.
_Avoid_: exactly once, processamento único

**Provedor de embeddings**:
O componente configurável que transforma textos em vetores, por meio de um
modelo local ou de uma API externa.
_Avoid_: modelo, LLM

**Servidor de inferência local**:
O contêiner escalável que hospeda um modelo local e atende requisições de
geração de embeddings dos workers LocalEmbed.
_Avoid_: worker, provedor externo

**Modelo de referência**:
O modelo local fixado por identificação e revisão para demonstração e avaliação
reproduzíveis. A referência inicial é `intfloat/multilingual-e5-base`, com 768
dimensões.
_Avoid_: melhor modelo, modelo avaliado

**Contrato de configuração**:
O JSON Schema versionado que descreve de forma pública as fontes, conteúdos e
parâmetros que o LocalEmbed aceita para operar.
_Avoid_: arquivo de ambiente, configuração interna

**Versão aplicada da configuração**:
Uma versão validada e persistida do contrato de configuração, sobre a qual os
workers executam até que uma nova versão seja aplicada administrativamente.
_Avoid_: hot reload, configuração corrente implícita

**Perfil de implantação**:
Uma composição de imagem e responsabilidades escolhida para executar o
LocalEmbed em um contexto operacional específico.
_Avoid_: microserviço, produto separado

**Modo de detecção**:
A estratégia configurável que identifica alterações em dados de origem: `TRIGGER`
registra tarefas durante a transação da alteração e `POLLING` as identifica
periodicamente.
_Avoid_: modo de sincronização, pooling

**Entidade configurada**:
Uma definição no array `entities` do contrato de configuração que associa uma
tabela de origem à sua chave, conteúdo, destino e provedor de embedding.
_Avoid_: tabela monitorada, fonte genérica

**Identificador de origem**:
A chave escalar estável de um dado de origem. O suporte inicial abrange `uuid`,
`bigint`, `text` e ULID representado como `text`; chaves compostas não são
suportadas.
_Avoid_: chave genérica, identificador composto

**Dependência de conteúdo**:
Um dado, potencialmente em tabela relacionada, cujo valor participa do conteúdo
de embedding de uma entidade configurada.
_Avoid_: join, campo externo

**Fingerprint de embedding**:
O hash determinístico usado para verificar se um embedding está atualizado,
derivado do conteúdo e de todos os parâmetros de geração relevantes.
_Avoid_: hash de conteúdo, checksum

**Chave de serviço**:
O segredo compartilhado que autentica chamadas à API de geração de consulta em
uma implantação confiável.
_Avoid_: chave de usuário, token de acesso

**Configuração de geração**:
O conjunto versionado de parâmetros aplicável a uma entidade, que inclui
template de conteúdo, provedor, modelo e dimensão. Cada dado de origem possui
no máximo um embedding atual para sua entidade.
_Avoid_: perfil, variante de vetor

**Preflight de provedor**:
A verificação executada ao aplicar uma configuração que testa conexão e
autorização do provedor e confirma o tipo e a dimensão do embedding produzido.
_Avoid_: teste implícito do worker, validação tardia

**Falha transitória de provedor**:
Erro de limite de taxa, timeout ou resposta 5xx que pode ser tentado novamente
conforme a política da tarefa.
_Avoid_: falha terminal, erro de configuração

**Falha terminal de provedor**:
Erro não transitório, como configuração inválida, dimensão incompatível ou 4xx
não recuperável, que encerra tentativas automáticas da tarefa.
_Avoid_: retryável, erro temporário

**Template de conteúdo**:
A regra determinística que compõe o texto enviado ao provedor de embeddings a
partir dos campos e dependências de conteúdo configurados.
_Avoid_: peso de campo, prompt

**Tarefa em processamento**:
Uma tarefa de embedding adquirida temporariamente por uma réplica de worker;
caso ela não seja concluída dentro do lease, volta a poder ser processada.
_Avoid_: tarefa bloqueada, tarefa exclusiva

**Tarefa com falha**:
Uma tarefa cujo limite configurado de tentativas se esgotou e cujo contexto de
erro é preservado até reprocessamento administrativo explícito.
_Avoid_: retry infinito, tarefa descartada

**Backfill**:
O enfileiramento inicial, em lotes, de todos os dados de origem de uma entidade
recém-aplicada. Ele usa a mesma fila e as mesmas garantias do processamento
incremental.
_Avoid_: importação especial, carga manual

**Reconciliação**:
O processo administrativo ou periódico que verifica a correspondência entre
dados de origem e destino gerenciado, incluindo referências órfãs após exclusões
físicas em modo `POLLING`.
_Avoid_: polling, limpeza imediata

**Relação declarada**:
O vínculo configurado entre uma entidade raiz e uma dependência de conteúdo que
permite ao LocalEmbed localizar entidades afetadas por uma alteração.
_Avoid_: join implícito, SQL livre
