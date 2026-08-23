# Contratos públicos iniciais

## Configuração

O contrato é JSON Schema versionado, iniciado em `localembed/v1`. Ele contém:

- `providers`: catálogo de provedores com tipo, endpoint, modelo, dimensão,
  métrica, limites e referência de segredo;
- `entities`: tabela raiz, identificador, modo de detecção, `updated_at`,
  destino, template e dependências declaradas;
- opções de HNSW, backfill, retries e reconciliação.

Configuração aceita somente JSON e uma DSL declarativa. Templates têm apenas
placeholders de campos/relações declarados; SQL, condicionais, loops e segredos
literais são proibidos. Uma transferência de dados para API externa exige
aceite explícito.

## API de consulta

`POST /v1/embeddings` recebe texto e identificador de entidade. A chamada usa a
configuração aplicada dessa entidade e devolve o vetor, dimensão, modelo e
metadados de geração. Ela não executa busca. OpenAPI é a fonte pública desse
contrato e a chave de serviço é um segredo de 32 bytes aleatórios, fornecido por
variável de ambiente.

## Operação

Comandos administrativos validam e aplicam configuração, executam migrações,
iniciam reconciliação e reenfileiram tarefas com falha. Eles usam um papel de
banco distinto do papel de runtime, que opera com privilégio mínimo.
