#!/usr/bin/env python3
"""Verify native Deno final export and contrast forced termination (running reference stack)."""
import json
import subprocess
import time
import urllib.parse
import uuid

IMAGE = 'localembed:0.1.0'


def docker(*args):
    return subprocess.run(['docker', *args], check=True, capture_output=True, text=True).stdout


def exported(service, event):
    query = urllib.parse.quote('{service_name="' + service + '"} |= "' + event + '"')
    response = docker('exec', 'localembed-dashboard-1', 'curl', '-fsS',
        'http://127.0.0.1:3100/loki/api/v1/query_range?limit=100&query=' + query)
    return bool(json.loads(response)['data']['result'])


code = '''import {event} from "./services/shared/telemetry.ts";
const keepalive=setInterval(()=>{},1000);
let finish;
await new Promise(resolve=>{
  finish=()=>resolve();
  Deno.addSignalListener("SIGTERM",finish);
  event("shutdown_probe_started",{service:"query-api"});
});
event("shutdown_probe_final",{service:"query-api"});
Deno.removeSignalListener("SIGTERM",finish);
clearInterval(keepalive);'''
for signal in ['SIGTERM', 'SIGKILL']:
    name = 'localembed-shutdown-' + uuid.uuid4().hex[:12]
    try:
        docker('run', '-d', '--name', name, '--network', 'localembed_default',
               '-e', 'OTEL_DENO=true', '-e', 'OTEL_SERVICE_NAME=' + name,
               '-e', 'OTEL_RESOURCE_ATTRIBUTES=service.instance.id=' + name,
               '-e', 'OTEL_EXPORTER_OTLP_ENDPOINT=http://dashboard:4318',
               '-e', 'OTEL_METRIC_EXPORT_INTERVAL=60000', '--entrypoint', 'deno',
               IMAGE, 'eval', '--cached-only', code)
        deadline = time.monotonic() + 10
        while 'shutdown_probe_started' not in docker('logs', name):
            if time.monotonic() > deadline:
                raise AssertionError('Fixture did not start')
            time.sleep(0.1)
        docker('kill', '--signal', signal, name)
        docker('wait', name)
        status = int(docker('inspect', name, '--format', '{{.State.ExitCode}}'))
        assert status == (0 if signal == 'SIGTERM' else 137), (signal, status)
        if signal == 'SIGTERM':
            deadline = time.monotonic() + 15
            while not exported(name, 'shutdown_probe_final'):
                if time.monotonic() > deadline:
                    raise AssertionError('Final graceful-shutdown log not exported')
                time.sleep(0.5)
        else:
            time.sleep(3)
            assert not exported(name, 'shutdown_probe_final'), 'Forced kill ran finalization'
        print(json.dumps({'signal': signal, 'exit_code': status,
                          'final_event_exported': signal == 'SIGTERM'}), flush=True)
    finally:
        subprocess.run(['docker', 'rm', '-f', name], capture_output=True)
