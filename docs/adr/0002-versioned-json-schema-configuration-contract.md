# JSON Schema versionado como contrato de configuração

O contrato público de configuração do LocalEmbed será um JSON Schema versionado,
contendo um array `entities`. Validações e modelos específicos de linguagem são
consumidores ou derivados desse contrato, para que a configuração permaneça
independente da linguagem escolhida para implementar o núcleo. A configuração
usará uma DSL declarativa de entidades, relações e templates; não aceitará SQL
livre nem segredos literais. Uma versão só passa a operar após um comando
administrativo que a valida, persiste e reconcilia as entidades afetadas; workers
sempre usam uma versão aplicada imutável.

Templates usam somente placeholders de campos e relações declaradas, sem
expressões, condicionais ou SQL. Remover uma entidade de uma configuração apenas
a desativa: apagar seus destinos exige um comando administrativo explícito.
