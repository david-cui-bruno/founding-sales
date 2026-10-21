// Controlled AWS process for the real reviewed execute integration. No live SDK.
export const reviewedSafetyCloud = `
const fs=require('fs'), args=process.argv.slice(2), a=args.join(' '), mode=process.env.MODE;
const log=process.env.LOG, flag=n=>fs.existsSync(log+'.'+n), value=k=>args[args.indexOf(k)+1];
fs.appendFileSync(log,'aws '+args.slice(0,2).join(' ')+'\\n');
const arn=n=>'arn:aws:ecs:us-east-1:326255650484:task-definition/fss-prod-'+n+':1';
const cluster='arn:aws:ecs:us-east-1:326255650484:cluster/fss-prod-cluster';
const registry='326255650484.dkr.ecr.us-east-1.amazonaws.com';
const image=(candidate=false)=>registry+'/fss-prod-worker@sha256:'+(candidate?'2':'3').repeat(64);
const tags=[{key:'NamePrefix',value:'fss-prod'}];
const definition=(name,candidate=false)=>({taskDefinitionArn:arn(name),status:'ACTIVE',family:'fss-prod-'+name,
 taskRoleArn:mode==='schema-reader-role'&&name==='operations'?'foreign-role':'arn:aws:iam::326255650484:role/fss-prod-worker-task',executionRoleArn:'arn:aws:iam::326255650484:role/fss-prod-worker-exec',
 containerDefinitions:[{name,image:mode==='schema-reader-image'&&name==='operations'?image(true):image(candidate),environment:[{name:'FSS_DATABASE_HOST',value:'private.invalid'},{name:'FSS_SENDING_ENABLED',value:'false'}],
 secrets:[{name:'DATABASE_SECRET_ARN',valueFrom:'arn:aws:secretsmanager:us-east-1:326255650484:secret:fss-prod/app-runtime-database-test'},{name:'google-gmail-oauth-client',valueFrom:'arn:aws:secretsmanager:us-east-1:326255650484:secret:fss-prod/google-gmail-oauth-client-test'},...(mode==='schema-reader-credential'&&name==='operations'?[{name:'MIGRATION_DATABASE_SECRET',valueFrom:'foreign-credential'}]:[])],
 logConfiguration:{options:{'awslogs-group':'/fss/fss-prod/worker','awslogs-stream-prefix':'operations'}}}]});
const db={DBInstanceIdentifier:'fss-prod-pg',DBInstanceArn:mode==='schema-database-binding'?'foreign-database':'arn:aws:rds:us-east-1:326255650484:db:fss-prod-pg',DbiResourceId:'db-identifier',Endpoint:{Address:'private.invalid'},DBInstanceStatus:'available',BackupRetentionPeriod:35,LatestRestorableTime:new Date().toISOString()};
let out;
if(a.startsWith('sts ')) out={Account:'326255650484',Arn:'arn:aws:sts::326255650484:assumed-role/fss-prod-deploy/controlled'};
else if(a.startsWith('ecs update-service')) {
 const service=value('--service');if(!['fss-prod-api','fss-prod-worker'].includes(service)||value('--desired-count')!=='0'||value('--cluster')!==cluster)process.exit(98);
 fs.appendFileSync(log,'contain stop '+service+' desired=0\\n');fs.writeFileSync(log+'.contain-attempt','yes');
 if(mode==='schema-containment-unknown'&&service==='fss-prod-worker')process.exit(1);
 if(mode!=='schema-containment-stuck')fs.writeFileSync(log+'.contained-'+service,'yes');out={};
} else if(a.startsWith('ecs describe-services')) {
 if(flag('contain-attempt')&&mode==='schema-containment-unknown')process.exit(1);
 if(flag('contain-attempt'))fs.appendFileSync(log,'contain verify services\\n');
 out={services:['api','worker'].map(n=>{const zero=flag('contained-fss-prod-'+n)||flag('stopped')&&!flag('migrated');return {serviceName:'fss-prod-'+n,status:'ACTIVE',desiredCount:zero?0:1,runningCount:zero?0:1,pendingCount:0,taskDefinition:n+':1',networkConfiguration:{awsvpcConfiguration:{subnets:['subnet-11111111','subnet-22222222'],securityGroups:[mode==='schema-network'?'sg-22222222':'sg-11111111'],assignPublicIp:'ENABLED'}}};})};
}
else if(a.startsWith('ec2 ')) out={SecurityGroups:[{GroupId:'sg-11111111',GroupName:'fss-prod-worker-task',IpPermissions:[]}]};
else if(a.startsWith('ecs register-task-definition')) {
 const d=JSON.parse(value('--cli-input-json'));d.taskDefinitionArn=arn('operations').replace(':1',':99');
 fs.writeFileSync(log+'.reader',JSON.stringify(d));out={taskDefinition:d};
} else if(a.startsWith('ecs deregister-task-definition')) out={};
else if(a.startsWith('ecs describe-task-definition')) {
 const id=value('--task-definition');let d;
 if(id.endsWith(':99'))d=JSON.parse(fs.readFileSync(log+'.reader','utf8'));
 else d=definition(id.startsWith('api')?'api':id.startsWith('worker')?'worker':'operations',flag('applied'));
 out={taskDefinition:d,tags};
} else if(a.startsWith('ecs run-task')) {
 const count=flag('off-count')?Number(fs.readFileSync(log+'.off-count','utf8'))+1:1;
 fs.writeFileSync(log+'.off-count',String(count));
 fs.writeFileSync(log+'.owner',value('--started-by'));out={tasks:[{taskArn:cluster.replace(':cluster/',':task/')+'/reader'}]};
} else if(a.startsWith('ecs describe-tasks')&&args.includes(cluster.replace(':cluster/',':task/')+'/retired-writer')) {
 out={tasks:[{taskArn:cluster.replace(':cluster/',':task/')+'/retired-writer',clusterArn:cluster,desiredStatus:'STOPPED',lastStatus:mode==='schema-stopping-writer'?'STOPPING':'STOPPED'}]};
} else if(a.startsWith('ecs describe-tasks')) {
 if(mode==='schema-postrestart-unknown'&&flag('migrated')){out={failures:[{reason:'unknown'}]};console.log(JSON.stringify(out));process.exit(0);}
 const d=JSON.parse(fs.readFileSync(log+'.reader','utf8'));
 out={tasks:[{taskArn:cluster.replace(':cluster/',':task/')+'/reader',clusterArn:cluster,startedBy:fs.readFileSync(log+'.owner','utf8'),taskDefinitionArn:d.taskDefinitionArn,lastStatus:'STOPPED',containers:[{name:'operations',exitCode:0,imageDigest:d.containerDefinitions[0].image.split('@')[1]}]}]};
} else if(a.startsWith('ecs list-tasks')) {
 const stopped=value('--desired-status')==='STOPPED';
 if(mode==='schema-stale-quiescence'&&stopped&&flag('off-count')&&Number(fs.readFileSync(log+'.off-count','utf8'))===3){fs.writeFileSync(log+'.clock',String(Date.now()+181000));fs.appendFileSync(log,'final-quiescence advanced 181s\\n');}
 out={taskArns:mode==='schema-writer'?['foreign-writer']:stopped&&['schema-stopping-writer','schema-terminal-writer'].includes(mode)?[cluster.replace(':cluster/',':task/')+'/retired-writer']:mode==='schema-postrestart-unknown'&&flag('migrated')&& !stopped?[cluster.replace(':cluster/',':task/')+'/reader']:[],...(stopped&&mode==='schema-stopped-page'?{nextToken:'more'}:{})};
}
else if(a.startsWith('logs ')) {
 const count=Number(fs.readFileSync(log+'.off-count','utf8'));
 const fault=mode==='schema-off-initial'&&count===1||mode==='schema-off-poststop'&&count===2||mode==='schema-off-premigrate'&&count===3||mode==='schema-off-postrestart'&&count===4||['schema-containment-unknown','schema-containment-stuck'].includes(mode)&&count===4;
 out={events:[{message:JSON.stringify({releaseOff:!fault,storedOff:!fault,effectiveOff:!fault,finishing:mode==='schema-postrestart-finishing'&&count===4?1:0,schema:flag('migrated')&&mode.startsWith('schema-')?89:88,versions:(mode==='schema-setting-change'&&count===3||mode==='schema-postrestart-setting'&&count===4)?[5]:[4],observedAt:new Date().toISOString()})}]};
} else if(a.startsWith('rds describe-db-instance-automated-backups')) out={DBInstanceAutomatedBackups:[{...db,Status:mode==='schema-backup-inactive'?'retained':'active',RestoreWindow:{EarliestTime:new Date(Date.now()-3600000).toISOString(),LatestTime:new Date(Date.now()+60000).toISOString()}}]};
else if(a.startsWith('rds ')) out={DBInstances:[db]};
else process.exit(99);
console.log(JSON.stringify(out));
`;
