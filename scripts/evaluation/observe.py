#!/usr/bin/env python3
"""Sample only explicitly named evaluation containers; keep raw Docker units."""
import json
import subprocess
import sys
import time

output = sys.argv[1]
containers = sys.argv[2:]
if not containers:
    raise SystemExit('Specify the evaluation containers')
with open(output, 'w') as stream:
    while True:
        result = subprocess.run(
            ['docker', 'stats', '--no-stream', '--format', '{{json .}}', *containers],
            capture_output=True, text=True, check=False,
        )
        if result.returncode:
            break
        for line in result.stdout.splitlines():
            stream.write(json.dumps({'time': time.time(), 'docker': json.loads(line)}) + '\n')
        stream.flush()
        time.sleep(0.25)
