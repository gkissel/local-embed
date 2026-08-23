# Fluxo Git

O repositório usa `master` como linha de entrega e `development` como linha de
integração.

```text
master → development → feature-#/<titulo-curto> → master → development
```

1. Atualize `development` a partir de `master` antes de abrir trabalho novo.
2. Crie a branch da issue a partir de `development`, no formato
   `feature-#<issue>/<titulo-curto>`.
3. Entregue a feature em `master` depois de revisão e validação.
4. Sincronize `master` de volta em `development` para iniciar o próximo ciclo.

Cada feature deve referenciar a issue GitHub correspondente. `development` não
é uma segunda origem de verdade: ela existe para preparar a próxima feature e é
sempre reconciliada após uma entrega em `master`.
