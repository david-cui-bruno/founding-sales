import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
import {repositoryPath} from './support/repository.ts';

it('production status refuses wrong commits, unsettled rollouts and missing or untagged operations images',()=>{
 const result=spawnSync('python3',['-c',`
import importlib.util, sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('status',${JSON.stringify(repositoryPath('scripts/productionStatus.py'))})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
health={'status':'serving','schema':{'accepted':True,'databaseVersion':61},'build':{'commit':'a'*40}}
services={'services':[{'serviceName':'fss-prod-'+n,'desiredCount':1,'runningCount':1,'pendingCount':0,'deployments':[{'rolloutState':'COMPLETED'}]} for n in ['api','worker']]}
defs={n:{'containerDefinitions':[{'image':n+'@sha256:'+n}]} for n in ['api','worker','operations']}
images={n+'@sha256:'+n:{'imageDetails':[{'imageDigest':'sha256:'+n,'imageTags':['a'*40]}]} for n in defs}
assert m.summarize(health,services,defs,images,'a'*40)['failures']==[]
images['worker@sha256:worker']['imageDetails'][0]['imageTags']=['b'*40]
assert 'worker:image_commit_mismatch' in m.summarize(health,services,defs,images,'a'*40)['failures']
assert 'commit_mismatch' in m.summarize(health,services,defs,images,'b'*40)['failures']
services['services'][0]['deployments'][0]['rolloutState']='IN_PROGRESS'
assert 'fss-prod-api:rollout_unsettled' in m.summarize(health,services,defs,images)['failures']
images['operations@sha256:operations']['imageDetails'][0]['imageTags']=[]
assert 'operations:image_untagged' in m.summarize(health,services,defs,images)['failures']
del images['operations@sha256:operations']
assert 'operations:image_missing' in m.summarize(health,services,defs,images)['failures']
`],{encoding:'utf8'});
 expect(result.status,result.stderr).toBe(0);
});
