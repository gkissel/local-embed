# Deno e TypeScript para os serviços LocalEmbed

Os serviços LocalEmbed serão implementados em Deno e TypeScript. A decisão
prioriza a produtividade e familiaridade do autor, a proximidade com os
contratos JSON Schema e OpenAPI e uma base única para worker, API e ferramentas;
a inferência local ficará em um contêiner escalável separado, evitando que a
escolha exija execução ONNX no processo do serviço.

O monorepo usará workspaces e tasks nativas do Deno. A documentação será gerada
com Lume; Turborepo não será introduzido, pois não acrescenta uma necessidade
ao ecossistema definido.
