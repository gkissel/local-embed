# Detecção incremental configurável por trigger ou polling

O LocalEmbed suportará os modos `TRIGGER` e `POLLING` por entidade configurada,
com um padrão global. No modo `TRIGGER`, objetos da estrutura auxiliar registram
uma tarefa persistente durante a transação que altera um dado de origem; no modo
`POLLING`, o serviço identifica periodicamente os dados que exigem
processamento. A escolha preserva o objetivo de integração agnóstica, porque
ambientes que não podem usar triggers continuam suportados, sem que o
processamento de embeddings ocorra de forma síncrona na transação da aplicação.
