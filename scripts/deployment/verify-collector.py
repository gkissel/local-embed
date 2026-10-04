#!/usr/bin/env python3
"""Linux/Docker fault injection against the pinned Collector, not a mock Collector."""
import gzip
import http.server
import json
import pathlib
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid

IMAGE = 'grafana/otel-lgtm:0.35.0@sha256:2de1094c593c671cbfca878a28ffcd7e46ff5e32f2ce966c0cf33003f6cf4266'
BINARY = '/otel-lgtm/otelcol-contrib/otelcol-contrib'
ROOT = pathlib.Path(__file__).resolve().parents[2]


def docker(*args):
    return subprocess.run(['docker', *args], check=True, capture_output=True, text=True).stdout


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class Backend(http.server.BaseHTTPRequestHandler):
    available = False
    received = []
    attempts = 0

    def do_POST(self):
        data = self.rfile.read(int(self.headers['Content-Length']))
        if self.headers.get('Content-Encoding') == 'gzip':
            data = gzip.decompress(data)
        Backend.attempts += 1
        if Backend.available:
            Backend.received.append(data)
        self.send_response(200 if Backend.available else 503)
        self.end_headers()
        self.wfile.write(b'{}')

    def log_message(self, *_):
        pass


def wait_for(predicate, message, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if predicate():
                return
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(0.2)
    raise AssertionError(message)


def post(port, body):
    data = json.dumps({'resourceLogs': [{'scopeLogs': [{'scope': {'name': 'localembed'},
        'logRecords': [{'timeUnixNano': str(time.time_ns()), 'body': {'stringValue': body}}]}]}]}).encode()
    req = urllib.request.Request(f'http://127.0.0.1:{port}/v1/logs', data,
                                 {'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Backend)
threading.Thread(target=server.serve_forever, daemon=True).start()
with tempfile.TemporaryDirectory(prefix='localembed-collector-') as directory:
    base = pathlib.Path(directory)
    for scenario in ['restart', 'queue-full', 'storage-full', 'disk-full']:
        name = 'localembed-collector-' + uuid.uuid4().hex[:12]
        port, health = free_port(), free_port()
        config = (ROOT / 'deployments/telemetry/collector.yaml').read_text()
        config = config.replace('0.0.0.0:4318', f'127.0.0.1:{port}')
        config = config.replace('0.0.0.0:13133', f'127.0.0.1:{health}')
        for target in ['9090/api/v1/otlp', '4418', '3100/otlp']:
            config = config.replace('http://127.0.0.1:' + target,
                                    f'http://127.0.0.1:{server.server_port}')
        # Remove asynchronous batching ONLY in overflow probes so receiver failures
        # surface synchronously; restart scenario uses the shipped full pipeline.
        if scenario != 'restart':
            config = config.replace('memory_limiter, filter/localembed, batch',
                                    'memory_limiter, filter/localembed')
        if scenario == 'queue-full':
            config = config.replace('queue_size: 256', 'queue_size: 2').replace('num_consumers: 2', 'num_consumers: 1')
        if scenario == 'storage-full':
            config = config.replace('max_size: 67108864', 'max_size: 262144')
        path = base / (scenario + '.yaml')
        path.write_text(config)
        storage = base / scenario
        storage.mkdir()
        mount = ['--tmpfs', '/data:size=1m'] if scenario == 'disk-full' else ['-v', f'{storage}:/data']
        Backend.available = False
        Backend.received = []
        Backend.attempts = 0
        try:
            docker('run', '-d', '--name', name, '--network', 'host', '--user', '1000:1000', *mount,
                   '-v', f'{path}:/config.yaml:ro', '--entrypoint', BINARY,
                   IMAGE, '--config=/config.yaml')
            wait_for(lambda: urllib.request.urlopen(f'http://127.0.0.1:{health}/ready', timeout=1).status == 200,
                     'Collector not ready')
            if scenario == 'disk-full':
                # Fill its dedicated ephemeral filesystem after queues have opened.
                docker('exec', name, 'sh', '-c', 'dd if=/dev/zero of=/data/fill bs=4096 2>/dev/null || true')
            if scenario == 'restart':
                assert post(port, '{"event":"fault_probe","marker":"persisted-marker"}') == 200
                wait_for(lambda: Backend.attempts > 0, 'Backend outage not exercised')
                docker('kill', name)
                docker('start', name)
                Backend.available = True
                wait_for(lambda: any(b'persisted-marker' in body for body in Backend.received),
                         'Persisted event not recovered after SIGKILL/restart')
                before = len(Backend.received)
                assert post(port, 'PRIVATE_UNSTRUCTURED_LOG') == 200
                time.sleep(2)
                assert len(Backend.received) == before, 'Unsafe log escaped filter'
            else:
                overflow = False
                payload = '{"event":"fault_probe","padding":"' + 'x' * 500000 + '"}'
                for _ in range(12):
                    if post(port, payload if scenario != 'queue-full' else '{"event":"fault_probe"}') >= 400:
                        overflow = True
                        break
                assert overflow, f'{scenario} did not exert receiver backpressure'
                # docker logs emits application diagnostics to stderr as well.
                proc = subprocess.run(['docker', 'logs', name], capture_output=True, text=True, check=True)
                logs = proc.stdout + proc.stderr
                assert any(term in logs.lower() for term in ['full', 'no space', 'failed']), 'Missing failure diagnostic'
            print(json.dumps({'scenario': scenario, 'result': 'passed'}), flush=True)
        finally:
            subprocess.run(['docker', 'rm', '-f', name], capture_output=True)
server.shutdown()
