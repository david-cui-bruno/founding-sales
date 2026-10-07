#!/usr/bin/env python3
"""Read-only compact production status; never a replacement for release smoke/readback."""
import argparse
import concurrent.futures
import datetime
import json
import re
import subprocess
import urllib.request
from pathlib import Path


def command(*args):
    return json.loads(subprocess.check_output(args, text=True, timeout=30))


def summarize(health, services, definitions, images, expected_commit=None):
    failures = []
    commit = health.get('build', {}).get('commit')
    if health.get('status') != 'serving' or health.get('schema', {}).get('accepted') is not True:
        failures.append('health_or_schema_refused')
    if expected_commit and commit != expected_commit:
        failures.append('commit_mismatch')
    if services.get('failures') or len(services.get('services', [])) != 2:
        failures.append('services_unavailable')
    rows = []
    for service in services.get('services', []):
        name = service['serviceName']
        deployments = service.get('deployments', [])
        stable = (service.get('desiredCount', 0) > 0
                  and service.get('runningCount') == service.get('desiredCount')
                  and service.get('pendingCount') == 0 and len(deployments) == 1
                  and deployments[0].get('rolloutState') == 'COMPLETED')
        if not stable:
            failures.append(name + ':rollout_unsettled')
        rows.append({'service': name, 'taskDefinition': service.get('taskDefinition'),
                     'running': service.get('runningCount'), 'desired': service.get('desiredCount'),
                     'stable': stable})
    held = []
    for name, definition in definitions.items():
        containers = definition.get('containerDefinitions', [])
        if len(containers) != 1:
            failures.append(name + ':definition_unavailable')
            continue
        image = containers[0].get('image', '')
        info = images.get(image, {})
        digest = image.partition('@')[2]
        details = info.get('imageDetails', [])
        present = len(details) == 1 and details[0].get('imageDigest') == digest
        tagged = present and bool(details[0].get('imageTags'))
        if not present:
            failures.append(name + ':image_missing')
        elif not tagged:
            failures.append(name + ':image_untagged')
        elif expected_commit and name in {'api', 'worker'} and not ({expected_commit, 'ci-' + expected_commit} & set(details[0]['imageTags'])):
            failures.append(name + ':image_commit_mismatch')
        held.append({'task': name, 'image': image, 'present': present, 'tagged': tagged})
    if set(definitions) != {'api', 'worker', 'operations'}:
        failures.append('definitions_incomplete')
    return {'commit': commit, 'schema': health.get('schema', {}).get('databaseVersion'),
            'services': rows, 'images': held, 'failures': failures,
            'mailboxControls': 'not_inspected', 'releaseSmokeAndRecord': 'use_normal_release_evidence'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expected-commit')
    parser.add_argument('--deploy-run')
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    if args.expected_commit and not re.fullmatch(r'[0-9a-f]{40}', args.expected_commit):
        parser.error('--expected-commit must be a full commit SHA')
    if args.deploy_run and (not args.expected_commit or not args.deploy_run.isdigit()):
        parser.error('--deploy-run requires a numeric run ID and --expected-commit')

    def aws(*options):
        return command('aws', '--region', 'us-east-1', *options, '--output', 'json')

    with urllib.request.urlopen('https://api.usecallie.com/health', timeout=15) as response:
        health = json.load(response)
    services = aws('ecs', 'describe-services', '--cluster', 'fss-prod-cluster',
                   '--services', 'fss-prod-api', 'fss-prod-worker')
    definitions = {}
    for service in services.get('services', []):
        key = service['serviceName'].removeprefix('fss-prod-')
        definitions[key] = aws('ecs', 'describe-task-definition', '--task-definition',
                               service['taskDefinition'])['taskDefinition']
    definitions['operations'] = aws('ecs', 'describe-task-definition', '--task-definition',
                                    'fss-prod-operations')['taskDefinition']
    images = {}
    def read_image(image):
        match = re.fullmatch(r'326255650484\.dkr\.ecr\.us-east-1\.amazonaws\.com/(fss-prod-(?:api|worker))@(sha256:[0-9a-f]{64})', image)
        if not match:
            return image, {}
        try:
            return image, aws('ecr', 'describe-images', '--repository-name', match[1],
                              '--image-ids', 'imageDigest=' + match[2])
        except subprocess.CalledProcessError:
            return image, {}
    wanted = {container.get('image', '') for definition in definitions.values()
              for container in definition.get('containerDefinitions', [])}
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        images.update(pool.map(read_image, wanted))
    report = summarize(health, services, definitions, images, args.expected_commit)
    if args.deploy_run:
        run = command('gh', 'run', 'view', args.deploy_run, '--repo',
                      'david-cui-bruno/founding-sales', '--json', 'headSha,status,conclusion,jobs,url')
        required = ['Deploy an app-only', 'Production smoke', 'Read the release record']
        passed = (run['headSha'] == args.expected_commit and run['status'] == 'completed'
                  and run['conclusion'] == 'success' and all(
                      any(job['name'].startswith(prefix) and job['conclusion'] == 'success'
                          for job in run['jobs']) for prefix in required))
        report['workflow'] = {'url': run['url'], 'passed': passed}
        if not passed:
            report['failures'].append('workflow_evidence_incomplete')
    report['verifiedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    report['passed'] = not report['failures']
    content = json.dumps(report, indent=2) + '\n'
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(content)
    print(content, end='')
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
