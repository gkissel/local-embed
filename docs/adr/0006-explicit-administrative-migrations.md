# Migrações administrativas explícitas

Criação e atualização da estrutura auxiliar, índices e triggers serão executadas
por comandos administrativos explícitos, como `localembed migrate`, e não pela
inicialização normal de workers. O ambiente de desenvolvimento poderá executar
esses comandos automaticamente pelo Compose; em implantação, isso evita DDL
concorrente e mudanças implícitas no banco. O papel administrativo é separado do
papel de runtime: somente o primeiro cria objetos e triggers; o segundo opera
com privilégios mínimos sobre origens e estrutura auxiliar.
