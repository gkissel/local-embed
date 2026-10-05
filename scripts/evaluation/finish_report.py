#!/usr/bin/env python3
"""Attach Docker/host provenance without recording credentials or connection URLs."""
import json
import os
import platform
import re
import subprocess
import sys
from pathlib import Path

report_path, trace_path, startup_seconds, *containers = sys.argv[1:]
report = json.loads(Path(report_path).read_text())

def byte_value(text):
    match = re.fullmatch(r'([0-9.]+)\s*(B|[KMGT]i?B)', text.strip())
    if not match:
        raise ValueError('Unexpected Docker byte unit: ' + text)
    units = {'B': 1, 'kB': 1000, 'KB': 1000, 'MB': 1000**2, 'GB': 1000**3,
             'TB': 1000**4, 'KiB': 1024, 'MiB': 1024**2, 'GiB': 1024**3, 'TiB': 1024**4}
    return int(float(match[1]) * units[match[2]])

samples = [json.loads(line) for line in Path(trace_path).read_text().splitlines() if line.strip()]
resources = {}
for container in containers:
    records = [sample for sample in samples if sample['docker']['Name'] == container]
    if not records:
        raise ValueError('No resource samples for ' + container)
    memory = [byte_value(row['docker']['MemUsage'].split('/')[0]) for row in records]
    cpu = [float(row['docker']['CPUPerc'].rstrip('%')) for row in records]
    host_config = json.loads(subprocess.check_output(['docker', 'inspect', '--format', '{{json .HostConfig}}', container]))
    image_id = subprocess.check_output(['docker', 'inspect', '--format', '{{.Image}}', container], text=True).strip()
    digests = json.loads(subprocess.check_output(['docker', 'image', 'inspect', '--format', '{{json .RepoDigests}}', image_id]))
    resources[container] = {'sample_count': len(records), 'sampled_peak_memory_bytes': max(memory),
        'mean_sampled_cpu_percent': sum(cpu)/len(cpu), 'peak_sampled_cpu_percent': max(cpu),
        'first_block_io': records[0]['docker']['BlockIO'], 'last_block_io': records[-1]['docker']['BlockIO'],
        'first_network_io': records[0]['docker']['NetIO'], 'last_network_io': records[-1]['docker']['NetIO'],
        'limits': {key: host_config[key] for key in ['Memory', 'NanoCpus', 'ShmSize']},
        'image_id': image_id, 'repo_digests': digests}

cpu_name = next((line.split(':',1)[1].strip() for line in Path('/proc/cpuinfo').read_text().splitlines() if line.startswith('model name')), 'unknown')
report['host'] = {'platform': platform.platform(), 'cpu_model': cpu_name, 'logical_cpus': os.cpu_count(),
    'memory_bytes': os.sysconf('SC_PAGE_SIZE')*os.sysconf('SC_PHYS_PAGES'),
    'load_average_at_finish': list(os.getloadavg()),
    'cgroup_cpu_max': Path('/sys/fs/cgroup/cpu.max').read_text().strip() if Path('/sys/fs/cgroup/cpu.max').exists() else None,
    'cgroup_memory_max': Path('/sys/fs/cgroup/memory.max').read_text().strip() if Path('/sys/fs/cgroup/memory.max').exists() else None}
report['resources']['containers'] = resources
report['resources']['method'] = 'Docker stats --no-stream samples, raw units preserved. CPU % is Docker core-relative; sampled memory is not an exact peak. Block/network I/O are cumulative container counters, not phase-attributed PostgreSQL reads.'
report['inference']['container_readiness_seconds'] = float(startup_seconds)
report['inference']['model_cache_volume_existed_before_start'] = os.environ.get('EVALUATION_CACHE_VOLUME_EXISTED') == 'true'
report['resource_trace'] = trace_path
Path(report_path).write_text(json.dumps(report, indent=2) + '\n')
