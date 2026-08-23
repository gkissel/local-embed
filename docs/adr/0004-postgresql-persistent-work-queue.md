# Fila de trabalho persistida no PostgreSQL

As tarefas de embedding serão persistidas na estrutura auxiliar do PostgreSQL.
Workers concorrentes as adquirirão transacionalmente, com lock que não bloqueia
outras tarefas, lease e recuperação após falha. A solução fornece processamento
ao menos uma vez e idempotência por fingerprint, permitindo escala horizontal
sem exigir um broker de mensagens externo. Depois do limite configurado de
tentativas, uma tarefa permanece em estado de falha com seu contexto preservado
e é reenfileirada somente por ação administrativa explícita.

Backfills utilizam a mesma fila em lotes. O modo `POLLING` depende de
`updated_at` nas origens e dependências; uma reconciliação periódica detecta
referências órfãs que exclusões físicas não conseguem sinalizar incrementalmente.
