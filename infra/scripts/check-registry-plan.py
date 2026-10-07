#!/usr/bin/env python3
"""Refuse a retention repair plan that writes anything except its two ECR policies."""
import json
import sys


def check(plan, prefix):
    if prefix not in {'fss-prod', 'fss-rh'}:
        raise ValueError('unknown registry namespace')
    module = 'module.stack.module.registry[0]' if prefix == 'fss-prod' else 'module.registry'
    expected = {f'{module}.aws_ecr_lifecycle_policy.this["{name}"]': f'{prefix}-{name}'
                for name in ['api', 'worker']}
    if not set(expected) <= {r['address'] for r in plan.get('resource_changes', [])}:
        raise ValueError('both targeted lifecycle policies must be present in the plan')
    changes = []
    for resource in plan.get('resource_changes', []):
        change = resource['change']
        if change['actions'] == ['no-op'] and resource['address'] not in expected:
            continue
        if resource['address'] not in expected or change['actions'] not in [['no-op'], ['update'], ['delete', 'create']]:
            raise ValueError('unexpected resource/action: ' + resource['address'])
        after = change['after']
        if after.get('repository') != expected[resource['address']]:
            raise ValueError('unexpected repository')
        rules = json.loads(after['policy'])['rules']
        if len(rules) != 1 or rules[0]['selection'] != {
                'tagStatus': 'untagged', 'countType': 'sinceImagePushed',
                'countUnit': 'days', 'countNumber': 7} or rules[0]['action'] != {'type': 'expire'}:
            raise ValueError('unexpected retention policy')
        if change['actions'] != ['no-op']:
            changes.append({'repository': after['repository'], 'actions': change['actions']})
    return {'namespace': prefix, 'changes': changes}


if __name__ == '__main__':
    try:
        print(json.dumps(check(json.load(sys.stdin), sys.argv[1])))
    except (ValueError, KeyError, TypeError, IndexError) as error:
        sys.exit('FAIL: registry-only plan refused: ' + str(error))
