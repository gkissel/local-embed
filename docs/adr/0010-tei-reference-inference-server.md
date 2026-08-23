# TEI como servidor local de inferência de referência

O ambiente de referência executará Hugging Face Text Embeddings Inference (TEI)
em um contêiner separado, com variantes CPU e GPU quando aplicável. Workers Deno
o acessam pela API de embeddings compatível com OpenAI através da Vercel AI SDK;
o modelo local usado na demonstração será `intfloat/multilingual-e5-base`,
compatível com TEI, de 768 dimensões e fixado por revisão imutável.
