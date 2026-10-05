# Mitigações operacionais de índices e ativação

Pesquisa em 2026-10-05, baseada em PostgreSQL 18, pgvector **v0.8.1** e na implementação
de `services/admin/indexes.ts`, `revisions.ts` e `retention.ts`. Propostas abaixo não significam
que a funcionalidade já esteja entregue.

## Construção HNSW: reduzir competição por recursos

O pgvector constrói mais rapidamente quando o grafo cabe em `maintenance_work_mem`; quando não
cabe, emite um aviso e a construção fica mais lenta. Aumentar memória indiscriminadamente pode
esgotar o servidor. Limitar `max_parallel_maintenance_workers` reduz competição por CPU, mas pode
alongar a manutenção. `max_parallel_workers` também restringe os workers disponíveis. Em Docker,
a documentação pede shared memory compatível com a memória de manutenção para builds paralelos.
Preservar `m=16` e `ef_construction=64` como ponto inicial; aumentar `ef_construction` melhora recall
com custo de construção e inserção. Valores menores exigem validar recall.
[Fonte: README do pgvector v0.8.1](https://github.com/pgvector/pgvector/blob/v0.8.1/README.md#hnsw).

Na #10, medir duração, memória máxima, CPU, I/O, WAL, backlog e latência de escrita/consulta sob
carga, variando um orçamento por vez. Manter construção por entidade sequencial e agendar fora do
pico já é possível. O limite do container administrativo não limita os recursos consumidos pelo
backend PostgreSQL; dimensionar o banco e reservar capacidade para consultas, workers e TEI.
Isso é uma recomendação operacional derivada da arquitetura, não resultado de benchmark.

`maintenance_work_mem` não representa o RSS total do servidor. Outras operações de manutenção e
autovacuum também precisam de orçamento; `autovacuum_work_mem` pode separar o orçamento dos
workers de vacuum. Ajustes devem considerar concorrência efetiva, não só um build isolado.
[Fonte: consumo de recursos no PostgreSQL 18](https://www.postgresql.org/docs/18/runtime-config-resource.html).

## Espera por transações e snapshots

`CONCURRENTLY` permite escritas durante a construção, mas executa múltiplas fases e pode esperar
transações anteriores; falhas podem deixar índice inválido com custo de atualização. Um índice
válido é recuperado pelo comando existente; um inválido compatível é removido e reconstruído.
Essa retomada não é uma continuação física do grafo interrompido.
[Fonte: CREATE INDEX no PostgreSQL 18](https://www.postgresql.org/docs/18/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY).

Monitorar `pg_stat_progress_create_index.phase`, `lockers_total`, `lockers_done` e
`current_locker_pid`, correlacionando com `pg_stat_activity`. Percentuais de blocos representam a
fase atual, não todo o comando nem um ETA confiável. Alertar duração de `waiting for old snapshots`
e idade da transação bloqueadora, sem cancelar sessões de terceiros automaticamente.
[Fonte: relatório de progresso do PostgreSQL 18](https://www.postgresql.org/docs/18/progress-reporting.html#CREATE-INDEX-PROGRESS-REPORTING).

Aplicar `statement_timeout` e `lock_timeout` específicos à sessão/role administrativa;
`lock_timeout` vale por tentativa de aquisição, enquanto `statement_timeout` limita a instrução.
Para consumidores, `idle_in_transaction_session_timeout` combate sessões ociosas em transação,
mas não encerra consultas continuamente ativas: estas precisam de orçamento de instrução ou
transação. `transaction_timeout` termina a sessão; tratar perda de conexão e preservar a regra de
não continuar DDL numa sessão nova sem recuperar ownership. Cancelar somente o backend identificado
e retomar pelo comando existente. Validar timeouts, alertas e recuperação na #27.
[Fonte: timeouts do PostgreSQL 18](https://www.postgresql.org/docs/18/runtime-config-client.html).

## Outras operações administrativas

Hoje o lock de sessão global `78129412` permanece durante todos os índices do comando; ativação
espera e retenção rejeita a passagem concorrente. Solução imediata: janela coordenada, prazo do
comando e alerta de limpeza atrasada. Não retirar esse lock isoladamente: revisão/destino podem ser
cancelados, aposentados ou apagados entre inspeção, DDL e atualização de `backfills.indexed`.

Uma evolução separada pode usar ownership por destino/revisão durante DDL e um lock global curto
para selecionar e revalidar o trabalho. Ativação, cancelamento e DROP devem respeitar esse mesmo
protocolo; usar ordem determinística, impedir double-build e garantir fechamento da sessão em erro.
Retenção pode então trabalhar em destinos independentes, preservando os que estão em construção.
Testar seleção versus cancelamento/DROP, sessão perdida e recuperação antes de habilitar concorrência.
Locks consultivos só coordenam participantes que seguem o protocolo; locks de sessão sobrevivem ao
rollback e são liberados com o fim da sessão.
[Fonte: locks consultivos do PostgreSQL 18](https://www.postgresql.org/docs/18/explicit-locking.html#ADVISORY-LOCKS).

Recomendação: issue própria para coordenação administrativa por recurso, separada da #28, que
protege consumidores de leitura. Não usar leases com prazo fixo como única proteção contra um
CREATE INDEX ainda vivo; ownership do backend e fencing precisam impedir um segundo administrador.

## Ativação ainda bloqueia escritas

Hoje `activate()` adquire `SHARE ROW EXCLUSIVE` em origens/dependências antes de comparar todos os
fingerprints, verificar órfãos e trocar a revisão ativa. Esse lock conflita com o lock de escrita
`ROW EXCLUSIVE`; reduzir apenas o timeout pode abortar cedo, mas não reduz a validação que consegue
concluir. [Fonte: modos de lock do PostgreSQL 18](https://www.postgresql.org/docs/18/explicit-locking.html#LOCKING-TABLES).

A #23 é a mitigação estrutural: validar o snapshot grande antes da barreira final, manter captura
durável das alterações e, sob uma barreira curta, validar o delta restante e trocar o ponteiro
atomicamente. A proposta precisa cobrir deletes, alterações de dependência, polling, transações
iniciadas antes da validação e commits tardios. Um ID sequencial de evento não é automaticamente
uma fronteira de commit: uma transação pode reservar um ID e concluir depois de outra. Essa é uma
exigência de correção derivada do fluxo atual, não uma funcionalidade já implementada.

Na #23, comparar tempo efetivo de bloqueio com a validação atual e abortar/deferir se o delta ou
prazo exceder o orçamento. Antecipar backfill, reconciliação e HNSW reduz trabalho pendente, mas não
elimina a varredura atual sob lock. Não anunciar downtime zero.

## Organização das entregas

- **#10:** evidência de capacidade, latência, recall e custo sob carga, incluindo manutenção.
- **#27:** limites de sessão, alertas, cancelamento/recuperação e orçamento do PostgreSQL em produção.
- **#23:** validação por delta com barreira curta e testes de commits tardios/deletes/dependências.
- **Nova issue:** ownership administrativo por recurso e concorrência segura de destinos distintos.

