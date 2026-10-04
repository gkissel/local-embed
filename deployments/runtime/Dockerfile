FROM denoland/deno:2.9.7@sha256:fa335acdf6b72106eda2cb6a8cb5f4187e7630e357467489db4b2e7352d5e432
WORKDIR /app
COPY deno.json deno.lock ./
COPY services services
COPY contracts contracts
COPY docs/site/deno.json docs/site/deno.json
COPY deployments/localembed.reference.json deployments/localembed.reference.json
COPY examples/hybrid-search examples/hybrid-search
COPY deployments/runtime deployments/runtime
RUN deno cache --frozen services/admin/main.ts services/worker/main.ts services/api/main.ts services/poller/main.ts services/telemetry/main.ts deployments/runtime/bootstrap.ts deployments/runtime/probe.ts examples/hybrid-search/main.ts
USER deno
ENTRYPOINT ["/app/deployments/runtime/entrypoint.sh"]
CMD ["worker"]
