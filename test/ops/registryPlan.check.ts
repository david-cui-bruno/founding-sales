import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
import {repositoryPath} from './support/repository.ts';

it('registry retention validation accepts only the fixed policy repair, refusing repositories and broader expiry',()=>{
 const run=spawnSync('python3',['-c',`
import importlib.util,sys,json
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('plan',${JSON.stringify(repositoryPath('infra/scripts/check-registry-plan.py'))})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
r={'address':'module.registry.aws_ecr_lifecycle_policy.this["worker"]','change':{'actions':['delete','create'],'after':{'repository':'fss-rh-worker','policy':json.dumps({'rules':[{'selection':{'tagStatus':'untagged','countType':'sinceImagePushed','countUnit':'days','countNumber':7},'action':{'type':'expire'}}]})}}}
a=json.loads(json.dumps(r));a['address']=a['address'].replace('worker','api');a['change']['after']['repository']='fss-rh-api'
p={'resource_changes':[r,a]}
assert len(m.check(p,'fss-rh')['changes'])==2
for change in ['address','policy','repository']:
 q=json.loads(json.dumps(p)); c=q['resource_changes'][0]
 if change=='address':c['address']='module.registry.aws_ecr_repository.this["worker"]'
 elif change=='repository':c['change']['after']['repository']='fss-prod-worker'
 else:c['change']['after']['policy']=json.dumps({'rules':[{'selection':{'tagStatus':'any'},'action':{'type':'expire'}}]})
 try:m.check(q,'fss-rh')
 except ValueError:pass
 else:raise AssertionError('accepted unsafe '+change)
`],{encoding:'utf8'});
 expect(run.status,run.stderr).toBe(0);
});
