# Fingerprint combina conteúdo e perfil de geração

O LocalEmbed calculará um fingerprint SHA-256 a partir de uma representação
canônica do conteúdo e da configuração de geração, incluindo template,
provedor, modelo e dimensão. Um embedding é atualizado apenas quando seu
fingerprint corresponde ao atual; por isso uma alteração de configuração também solicita
reprocessamento, mesmo que os dados de origem não tenham mudado.
