# PostgreSQL 18 como baseline suportado

A primeira versão do LocalEmbed requer PostgreSQL 18 ou superior com pgvector.
Limitar explicitamente a matriz de suporte permite validar as imagens Docker,
DDL, triggers e comportamento dos índices, em vez de prometer compatibilidade
com versões indeterminadas do PostgreSQL.
