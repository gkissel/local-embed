#!/usr/bin/env python3
"""Verify configured authentication and reject the bundled default credential."""
import base64
import os
import pathlib
import time
import urllib.error
import urllib.request

root = pathlib.Path(__file__).resolve().parents[2]
secret = (root / 'deployments/.secrets/grafana_password').read_text().strip()
port = os.environ.get('LOCAL_EMBED_GRAFANA_PORT', '3000')


def status(password):
    authorization = base64.b64encode(('admin:' + password).encode()).decode()
    request = urllib.request.Request(f'http://127.0.0.1:{port}/api/user',
                                     headers={'Authorization': 'Basic ' + authorization})
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


deadline = time.monotonic() + 60
while True:
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/health', timeout=3) as response:
            if response.status == 200:
                break
    except (OSError, urllib.error.URLError):
        pass
    if time.monotonic() > deadline:
        raise AssertionError('Grafana readiness timed out')
    time.sleep(0.5)
assert status(secret) == 200, 'Configured Grafana credential rejected'
assert status('admin') == 401, 'Default Grafana credential still accepted'
print('Grafana configured credential verified; default credential rejected.')
