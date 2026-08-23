# Compose e Kubernetes executam os mesmos papéis

O LocalEmbed fornecerá implantação de referência em Docker Compose e Kubernetes.
Ambas usam as mesmas imagens e contratos para worker, query API, servidor de
inferência e telemetria; Compose atende desenvolvimento e avaliação local,
enquanto Kubernetes demonstra a implantação escalável dos mesmos papéis.

O alvo Kubernetes será fornecido como Helm chart único, com values para réplicas,
recursos CPU/GPU, secrets e endpoints dos papéis de implantação.
