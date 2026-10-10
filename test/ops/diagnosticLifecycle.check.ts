import { spawnSync, spawn } from "node:child_process";
import { createHash, createCipheriv } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  existsSync,
  cpSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const script = resolve("infra/scripts/diagnostic-lifecycle.mjs");
// A fixed synthetic ZIP containing index.mjs and digest.mjs, independent of the handoff.
const archiveBase64 = "UEsDBBQAAAAIAAAAIQBX4GbXJQAAACMAAAAJAAAAaW5kZXgubWpzS87PK87PSdXLyU/XUErOzyspys/JSU1RSCxKzsgsS1XStOYCAFBLAwQUAAAACAAAACEA8R9pmB4AAAAgAAAACgAAAGRpZ2VzdC5tanNLrSjILypRSM7PKwaTJUX5OTmpKQq2CiVFpanWXABQSwECFAMUAAAACAAAACEAV+Bm1yUAAAAjAAAACQAAAAAAAAAAAAAApIEAAAAAaW5kZXgubWpzUEsBAhQDFAAAAAgAAAAhAPEfaZgeAAAAIAAAAAoAAAAAAAAAAAAAAKSBTAAAAGRpZ2VzdC5tanNQSwUGAAAAAAIAAgBvAAAAkgAAAAAA";

function leaseFixture() {
  const now = Date.now();
  return {
    schemaVersion: 1,
    purpose: "acquisition_acceptance_lifecycle",
    leaseId: "11111111-1111-4111-8111-111111111111",
    environmentId: "22222222-2222-4222-8222-222222222222",
    prefix: "fss-rh-cap90-o10a",
    databaseName: "fss_diagnostic_cap90_o10a",
    apiHostname: "cap90-o10a.rehearsal.usecallie.com",
    state: {
      bucket: "callie-sourcing-tfstate-326255650484",
      key: "fss/greenfield/rehearsal/fss-rh-cap90-o10a/terraform.tfstate",
      kmsKeyArn:
        "arn:aws:kms:us-east-1:326255650484:key/a321a083-4058-4130-b060-b950e4aa1404",
    },
    sourceCommit: "a".repeat(40),
    imageBuildCommit: "b".repeat(40),
    images: {
      api: `sha256:${"1".repeat(64)}`,
      worker: `sha256:${"2".repeat(64)}`,
    },
    configurationSha256: "3".repeat(64),
    manifestSha256: "4".repeat(64),
    planSha256: "5".repeat(64),
    envelopeSha256: "6".repeat(64),
    objectKey: `fss/greenfield/rehearsal/fss-rh-cap90-o10a/diagnostic/plans/${"5".repeat(64)}/envelope.json`,
    approvedAt: new Date(now - 10000).toISOString(),
    startDeadline: new Date(now + 60000).toISOString(),
    cleanupAt: new Date(now + 7200000).toISOString(),
    hardDeadline: new Date(now + 10800000).toISOString(),
    bootstrapAdminEmail: "david@usecallie.com",
    owner: "David Cui",
    fallbackOwner: "Test Operator",
    proposedMaxUsd: 5,
    retention: {
      acknowledged: true,
      approvalRef: "controlled-retention-review",
    },
    google: {
      projectId: "callie-diagnostic-test",
      oidcClientId: "123456-oidc.apps.googleusercontent.com",
      gmailClientId: "123456-gmail.apps.googleusercontent.com",
      redirectUris: {
        oidc: "https://cap90-o10a.rehearsal.usecallie.com/auth/google/callback",
        gmail:
          "https://cap90-o10a.rehearsal.usecallie.com/oauth/gmail/callback",
      },
      inputsReviewRef: "controlled-google-review",
      workspacePolicyReviewRef: "controlled-policy-review",
    },
    requiredSecretEntries: ["google-oidc-client", "google-gmail-oauth-client"],
  };
}

function applicationFixture(options: {archive?:string;legacy?:boolean} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "fss-diagnostic-apply-"));
  const checkout = join(directory, "checkout");
  mkdirSync(checkout);
  cpSync(resolve("infra"), join(checkout, "infra"), {
    recursive: true,
    filter: (path) =>
      !path.split("/").includes(".terraform") &&
      !path.endsWith("/run.auto.tfvars.json"),
  });
  const lease = leaseFixture();
  const configuration = {
    assume_deployment_role: false,
    bootstrap: true,
    name_prefix: lease.prefix,
    availability_zones: ["us-east-1a", "us-east-1b"],
    api_image: `326255650484.dkr.ecr.us-east-1.amazonaws.com/fss-rh-api@${lease.images.api}`,
    worker_image: `326255650484.dkr.ecr.us-east-1.amazonaws.com/fss-rh-worker@${lease.images.worker}`,
    certificate_arn:
      "arn:aws:acm:us-east-1:326255650484:certificate/11111111-1111-4111-8111-111111111111",
    api_hostname: lease.apiHostname,
    api_schema_range: { min: 90, max: 90 },
    worker_schema_range: { min: 90, max: 90 },
    crm_acquisition_diagnostic: {
      environment_id: lease.environmentId,
      database_name: lease.databaseName,
    },
  };
  const sha = (value: string | Buffer) =>
    createHash("sha256").update(value).digest("hex");
  lease.configurationSha256 = sha(JSON.stringify(configuration));
  const plan = Buffer.from("EXACT_REVIEWED_PRIVATE_PLAN");
  lease.planSha256 = sha(plan);
  const manifest = {
    workflowRunId: "122",
    workflowRunAttempt: "1",
    commit: lease.sourceCommit,
    imageBuildCommit: lease.imageBuildCommit,
    apiDigest: lease.images.api,
    workerDigest: lease.images.worker,
    stateKey: lease.state.key,
    configurationSha256: lease.configurationSha256,
    providerLockSha256: sha(
      readFileSync(join(checkout, "infra/roots/rehearsal/.terraform.lock.hcl")),
    ),
    terraformVersion: "1.15.8",
    planSha256: lease.planSha256,
    applySupported: false,
    diagnostic: {
      environmentId: lease.environmentId,
      prefix: lease.prefix,
      databaseName: lease.databaseName,
      apiHostname: lease.apiHostname,
      schema: 90,
      sendingEnabled: false,
    },
    activationAllowed: false,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  lease.manifestSha256 = sha(manifestBytes);
  const metadata = {
    schemaVersion: 1,
    purpose: "diagnostic_plan_storage",
    approvalId: lease.leaseId,
    approvedAt: lease.approvedAt,
    expiresAt: lease.hardDeadline,
    environmentId: lease.environmentId,
    prefix: lease.prefix,
    databaseName: lease.databaseName,
    apiHostname: lease.apiHostname,
    state: lease.state,
    sourceCommit: lease.sourceCommit,
    imageBuildCommit: lease.imageBuildCommit,
    images: lease.images,
    configurationSha256: lease.configurationSha256,
    retention: lease.retention,
    observedProposal: { runId: "122", attempt: "1" },
    storageApprovalSha256: "7".repeat(64),
    planSha256: lease.planSha256,
    manifestSha256: lease.manifestSha256,
  };
  const key = Buffer.alloc(32, 7),
    nonce = Buffer.alloc(12, 8);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(metadata)));
  const encrypted = Buffer.concat([
    cipher.update(
      JSON.stringify({
        plan: plan.toString("base64"),
        manifestBytes: manifestBytes.toString("base64"),
        configuration,
        ...(options.legacy ? {} : {alarmDigestArchive: options.archive ?? archiveBase64}),
      }),
    ),
    cipher.final(),
  ]);
  const packet = JSON.stringify({
    version: options.legacy ? "fss.private-plan.v1" : "fss.private-plan.v2",
    metadata,
    encryptedDataKey: Buffer.from("CONTROLLED_WRAPPED_KEY").toString("base64"),
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: encrypted.toString("base64"),
  });
  lease.envelopeSha256 = sha(packet);
  lease.objectKey = `fss/greenfield/rehearsal/${lease.prefix}/diagnostic/plans/${lease.planSha256}/envelope.json`;
  const leasePath = join(directory, "lease.json"),
    packetPath = join(directory, "packet.json"),
    calls = join(directory, "calls.jsonl");
  writeFileSync(leasePath, JSON.stringify(lease));
  writeFileSync(packetPath, packet);
  const expectedHash = sha(readFileSync(leasePath));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const outputs = Object.fromEntries(
    Object.entries({
      environment: "rehearsal",
      destroyable: true,
      name_prefix: lease.prefix,
      database_name: lease.databaseName,
      database_endpoint: "controlled-db.us-east-1.rds.amazonaws.com:5432",
      database_master_secret_arn:
        "arn:aws:secretsmanager:us-east-1:326255650484:secret:rds!db-controlled",
      migration_database_secret_arn: `arn:aws:secretsmanager:us-east-1:326255650484:secret:${lease.prefix}/migration-database-controlled`,
      app_runtime_database_secret_arn: `arn:aws:secretsmanager:us-east-1:326255650484:secret:${lease.prefix}/app-runtime-database-controlled`,
      secret_names: Object.fromEntries([
        "migration-database",
        "app-runtime-database",
        "google-oidc-client",
        "google-gmail-oauth-client",
        "session-signing-key",
        "device-credential-pepper",
        "sourcing-search",
        "llm-classifier-api-key",
        "twilio-voice",
        "calcom",
        "transcription",
        "zoom-meetings",
      ].map(name=>[name,`${lease.prefix}/${name}`])),
      crm_acquisition_diagnostic: {
        environment_id: lease.environmentId,
        database_name: lease.databaseName,
        tags: {
          CalliePurpose: "acquisition_acceptance",
          CallieDiagnosticEnvironment: lease.environmentId,
        },
      },
    }).map(([name, value]) => [name, { value }]),
  );
  writeFileSync(join(directory, "outputs.json"), JSON.stringify(outputs));
  const programs = {
    bash: `#!/usr/bin/env python3
import os,sys,json
a=sys.argv[1:];open(os.environ['CALLS'],'a').write(json.dumps({'program':'bash','args':a})+'\\n')
if os.environ.get('FAIL_CLEANUP')=='1':print('PRIVATE_PROVIDER_ERROR');sys.exit(1)
if a[1]=='bootstrap':
 p=os.environ['FSS_REHEARSAL_REPORTS'];os.makedirs(p,exist_ok=True)
 report={'workspace':{'id':'33333333-3333-4333-8333-333333333333','slug':a[a.index('--slug')+1],'displayName':a[a.index('--display-name')+1],'businessTimeZone':'America/New_York','outcome':'created'},'admin':{'userId':'44444444-4444-4444-8444-444444444444','email':a[a.index('--admin-email')+1],'outcome':'provisional_created'},'membership':{'role':'admin','outcome':'created'},'sendingDomain':None}
 variant=os.environ.get('BAD_BOOTSTRAP')
 if variant=='workspace':report['workspace']['slug']='unreviewed-workspace'
 if variant=='owner':report['admin']['email']='other@example.test'
 if variant=='membership':report['membership']['role']='viewer'
 if variant=='malformed':report={'private':'PRIVATE_BOOTSTRAP_CANARY'}
 open(p+'/bootstrap-workspace.json','w').write(json.dumps(report))
if a[0].endswith('/record.sh'):
 if a[1]=='from-ci':os.execv('/bin/bash',['bash']+a)
 if os.environ.get('FAIL_RECORD_STAGE')==a[1]:print('PRIVATE_RECORD_ERROR');sys.exit(1)
 print(json.dumps({'outcome':'created' if a[1]=='put' else 'existing'}))
`,
    gh: `#!/usr/bin/env python3
import os,sys,json
a=sys.argv[1:];open(os.environ['CALLS'],'a').write(json.dumps({'program':'gh','args':a})+'\\n')
repo='david-cui-bruno/founding-sales';commit='b'*40
if a[0]=='api':
 path=a[1];images='greenfield-images' in path or path.endswith('/202');id=202 if images else 201
 r={'id':id,'path':'.github/workflows/'+('greenfield-images.yml' if images else 'greenfield.yml'),'head_sha':commit,'event':'push','head_branch':'main','head_repository':{'full_name':repo},'status':'completed','conclusion':'failure' if os.environ.get('FAIL_RECORD_PROVENANCE')=='1' else 'success','created_at':'2026-10-10T00:00:00Z','updated_at':'2026-10-10T00:01:00Z','run_started_at':'2026-10-10T00:00:00Z','html_url':'https://github.com/'+repo+'/actions/runs/'+str(id)}
 print(json.dumps({'workflow_runs':[r]} if '/workflows/' in path else r))
elif a[:2]==['run','download']:
 destination=a[a.index('--dir')+1]
 value={'schema':'fss.image-digests.v1','commit':commit,'workflowRunId':'202','images':{k:{'repository':'fss-rh-'+k,'tag':'ci-'+commit,'digest':'sha256:'+n*64} for k,n in [('api','1'),('worker','2')]}}
 open(destination+'/image-digests.json','w').write(json.dumps(value))
else:sys.exit(1)
`,
    aws: `#!/usr/bin/env python3
import os,sys,json,shutil,hashlib
a=sys.argv[1:];open(os.environ['CALLS'],'a').write(json.dumps({'program':'aws','args':a})+'\\n')
if a[:2]==['sts','get-caller-identity']:print(json.dumps({'Account':'326255650484','Arn':'arn:aws:sts::326255650484:assumed-role/fss-rh-deploy/controlled'}))
elif a[:2]==['rds','describe-db-instances']:\n o=json.load(open(os.environ['OUTPUTS']));p=o['name_prefix']['value'];print(json.dumps({'DBInstances':[{'DBInstanceIdentifier':p+'-pg','DBInstanceArn':'arn:aws:rds:us-east-1:326255650484:db:'+p+'-pg','DBName':o['database_name']['value'],'Endpoint':{'Address':os.environ.get('WRONG_ENDPOINT','controlled-db.us-east-1.rds.amazonaws.com'),'Port':5432},'MasterUserSecret':{'SecretArn':os.environ.get('WRONG_MASTER',o['database_master_secret_arn']['value'])}}]}))\nelif a[:2]==['rds','list-tags-for-resource']:\n o=json.load(open(os.environ['OUTPUTS']));print(json.dumps({'TagList':[{'Key':k,'Value':v} for k,v in {'Environment':'rehearsal','NamePrefix':os.environ.get('WRONG_TAG',o['name_prefix']['value']),'CalliePurpose':'acquisition_acceptance','CallieDiagnosticEnvironment':o['crm_acquisition_diagnostic']['value']['environment_id']}.items()]}))\nelif a[:2]==['secretsmanager','get-secret-value']:print(json.dumps({'SecretString':json.dumps({'username':'postgres','password':'CONTROLLED_MASTER_PRIVATE'})}))\nelif a[:2]==['secretsmanager','put-secret-value']:\n v=open(a[a.index('--secret-string')+1][7:]).read();open(os.environ['SECRET_CAPTURE'],'a').write(v+'\\n');print('{}')\nelif a[:2]==['kms','decrypt']:print(json.dumps({'KeyId':os.environ['KMS_KEY'],'Plaintext':os.environ['DATA_KEY']}))
elif a[:2]==['s3api','get-object']:
 k=a[a.index('--key')+1];p=os.environ['PACKET'] if k.endswith('/envelope.json') else os.environ['STORE']+'/'+hashlib.sha256(k.encode()).hexdigest()
 shutil.copyfile(p,a[a.index('--key')+2]);print('{}')
elif a[:2]==['s3api','put-object']:
 p=os.environ['STORE']+'/'+hashlib.sha256(a[a.index('--key')+1].encode()).hexdigest()
 if os.path.exists(p):sys.exit(1)
 shutil.copyfile(a[a.index('--body')+1],p)
 if os.environ.get('CHANGE_ARCHIVE_AFTER_REGISTRATION')=='1' and a[a.index('--key')+1].endswith('/lease.json'):open(os.environ['ARCHIVE_PATH'],'wb').write(b'CHANGED_CONTROLLED_FILE')
 print(json.dumps({'ETag':'"controlled"'}))
else:sys.exit(1)
`,
    git: `#!/usr/bin/env python3
import os,sys
if sys.argv[1]=='status':
 p=os.environ['STORE']+'/git-count';n=int(open(p).read())+1 if os.path.exists(p) else 1;open(p,'w').write(str(n));print(' M infra/roots/rehearsal/backend.hcl' if os.environ.get('DIRTY_AFTER_WAIT')=='1' and n>1 else '')
else:print(os.environ['GITHUB_SHA'])
`,
    terraform: `#!/usr/bin/env python3
import os,sys,json
a=sys.argv[1:];open(os.environ['CALLS'],'a').write(json.dumps({'program':'terraform','args':a})+'\\n')
if a[0]=='version':print(json.dumps({'terraform_version':'1.15.8'}))
elif a[:2]==['state','list']:print('No state file was found!',file=sys.stderr);sys.exit(1)\nelif a[:2]==['show','-json'] and len(a)==3:print(json.dumps({'format_version':'1.2','resource_changes':[{'mode':'managed','type':'aws_lambda_function','address':'module.stack.module.alerts.aws_lambda_function.digest','change':{'after':{'filename':os.environ.get('ARCHIVE_FILENAME','./.terraform/alarm-digest/fss-rh-cap90-o10a.zip'),'source_code_hash':os.environ['ARCHIVE_HASH']}}}]+json.loads(os.environ.get('EXTRA_PLAN_CHANGES','[]'))}))\nelif a[:2]==['show','-json']:\n if os.environ.get('FAIL_STATE_READ')=='1':print('PRIVATE_PROVIDER_ERROR',file=sys.stderr);sys.exit(1)\n count=os.environ['STORE']+'/state-read-count';n=int(open(count).read())+1 if os.path.exists(count) else 1;open(count,'w').write(str(n))\n print(os.environ.get('STATE_AFTER_REGISTRATION') if n>1 and os.environ.get('STATE_AFTER_REGISTRATION') else os.environ.get('STATE_JSON',json.dumps({'format_version':'1.0'})))\nelif a[0]=='output':print(open(os.environ['OUTPUTS']).read())
elif a[0]=='apply':\n if os.environ.get('FAIL_APPLY')=='1':print('PRIVATE_PROVIDER_ERROR',file=sys.stderr);sys.exit(1)\n archive='.terraform/alarm-digest/fss-rh-cap90-o10a.zip'\n if not os.path.isfile(archive):print('PRIVATE_PROVIDER_ARCHIVE_MISSING',file=sys.stderr);sys.exit(1)\n import base64\n if open(archive,'rb').read()!=base64.b64decode(os.environ['ARCHIVE_BASE64']):sys.exit(1)\n open(os.environ['APPLIED_ARCHIVE'],'wb').write(open(archive,'rb').read())\n open(os.environ['APPLIED'],'wb').write(open(a[-1],'rb').read())
elif a[0]!='init':sys.exit(1)
`,
  };
  for (const [name, body] of Object.entries(programs)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  mkdirSync(join(directory, "store"));
  const privateInputs = JSON.stringify({
    oidc: {
      client_id: lease.google.oidcClientId,
      client_secret: "CONTROLLED_PRIVATE_OIDC",
      project_id: lease.google.projectId,
      redirect_uris: [lease.google.redirectUris.oidc],
    },
    gmail: {
      client_id: lease.google.gmailClientId,
      client_secret: "CONTROLLED_PRIVATE_GMAIL",
      project_id: lease.google.projectId,
      redirect_uris: [lease.google.redirectUris.gmail],
    },
  });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env["PATH"]}`,
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: lease.sourceCommit,
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: "david-cui-bruno/founding-sales",
    CALLS: calls,
    PACKET: packetPath,
    DATA_KEY: key.toString("base64"),
    KMS_KEY: lease.state.kmsKeyArn,
    STORE: join(directory, "store"),
    APPLIED: join(directory, "applied"),
    ARCHIVE_BASE64: archiveBase64,
    ARCHIVE_PATH: join(checkout,"infra/roots/rehearsal/.terraform/alarm-digest/fss-rh-cap90-o10a.zip"),
    ARCHIVE_HASH: createHash("sha256").update(Buffer.from(archiveBase64,"base64")).digest("base64"),
    APPLIED_ARCHIVE: join(directory, "applied-archive.zip"),
    OUTPUTS: join(directory, "outputs.json"),
    SECRET_CAPTURE: join(directory, "secret-capture"),
  };
  const invoke = (stage: string, privateDirectory = "private") =>
    spawnSync(
      process.execPath,
      [
        join(checkout, "infra/scripts/diagnostic-lifecycle.mjs"),
        stage,
        leasePath,
        expectedHash,
        join(directory, privateDirectory),
      ],
      { input: privateInputs, encoding: "utf8", env },
    );
  return {
    directory,
    calls,
    lease,
    invoke,
    env,
    checkout,
    leasePath,
    expectedHash,
  };
}

it("applies a reviewed plan in a fresh checkout with its exact file artifact and never replans", () => {
  const fixture = applicationFixture();
  try {
    const result = fixture.invoke("apply");
    expect(
      result.status,
      result.stdout +
        result.stderr +
        (existsSync(fixture.calls) ? readFileSync(fixture.calls, "utf8") : ""),
    ).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      stage: "applied",
      applyPerformed: true,
      activationAllowed: false,
    });
    expect(readFileSync(join(fixture.directory, "applied"), "utf8")).toBe(
      "EXACT_REVIEWED_PRIVATE_PLAN",
    );
    expect(readFileSync(join(fixture.directory, "applied-archive.zip")).toString("base64")).toBe(archiveBase64);
    const calls = readFileSync(fixture.calls, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const registration = calls.findIndex(
      (call) =>
        call.program === "aws" &&
        call.args[0] === "s3api" &&
        call.args[1] === "put-object",
    );
    const application = calls.findIndex(
      (call) => call.program === "terraform" && call.args[0] === "apply",
    );
    expect(registration).toBeGreaterThanOrEqual(0);
    expect(application).toBeGreaterThan(registration);
    expect(
      calls.some(
        (call) => call.program === "terraform" && call.args[0] === "plan",
      ),
    ).toBe(false);
    expect(result.stdout + result.stderr).not.toMatch(
      /CONTROLLED_PRIVATE|EXACT_REVIEWED_PRIVATE_PLAN/,
    );
    const retry = fixture.invoke("apply", "retry-private");
    expect(retry.status).toBe(1);
    const finalCalls = readFileSync(fixture.calls, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      finalCalls.filter(
        (call) => call.program === "terraform" && call.args[0] === "apply",
      ),
    ).toHaveLength(1);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

it("refuses a retained archive whose hash differs from the reviewed plan before registering application", () => {
  const fixture = applicationFixture();
  try {
    fixture.env["ARCHIVE_HASH"] = Buffer.alloc(32,0).toString("base64");
    const result = fixture.invoke("apply");
    expect(result.status).toBe(1);
    const calls = readFileSync(fixture.calls,"utf8").trim().split("\n").map(line=>JSON.parse(line));
    expect(calls.some(call=>call.program === "aws" && call.args[1] === "put-object")).toBe(false);
    expect(calls.some(call=>call.program === "terraform" && call.args[0] === "apply")).toBe(false);
    expect(result.stdout+result.stderr).not.toContain("PRIVATE_PROVIDER");
  } finally {rmSync(fixture.directory,{recursive:true,force:true});}
});

it("refuses unsupported saved-plan file dependencies before registering or applying", () => {
  const fixture = applicationFixture();
  try {
    fixture.env["EXTRA_PLAN_CHANGES"] = JSON.stringify([{
      mode: "managed", type: "aws_s3_object", address: "aws_s3_object.other",
      change: {after: {source: "PRIVATE_UNSUPPORTED_FILE.zip"}},
    }]);
    const result = fixture.invoke("apply");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ok:false,reason:"local_artifact_unsupported"});
    const calls = readFileSync(fixture.calls,"utf8").trim().split("\n").map(line=>JSON.parse(line));
    expect(calls.some(call=>call.program === "aws" && call.args[1] === "put-object")).toBe(false);
    expect(calls.some(call=>call.program === "terraform" && call.args[0] === "apply")).toBe(false);
    expect(result.stdout+result.stderr).not.toContain("PRIVATE_UNSUPPORTED_FILE");
  } finally {rmSync(fixture.directory,{recursive:true,force:true});}
});

it.each([
  {after: {filename: "PRIVATE_UNSUPPORTED_FILE.zip"}},
  {after: {}, after_unknown: {source: true}},
])("refuses file dependencies even on a normally file-free managed type", change => {
  const fixture = applicationFixture();
  try {
    fixture.env["EXTRA_PLAN_CHANGES"] = JSON.stringify([{
      mode: "managed", type: "aws_s3_bucket", address: "aws_s3_bucket.other", change,
    }]);
    const result = fixture.invoke("apply");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ok:false,reason:"local_artifact_unsupported"});
    const calls = readFileSync(fixture.calls,"utf8").trim().split("\n").map(line=>JSON.parse(line));
    expect(calls.some(call=>call.program === "aws" && call.args[1] === "put-object")).toBe(false);
    expect(calls.some(call=>call.program === "terraform" && call.args[0] === "apply")).toBe(false);
  } finally {rmSync(fixture.directory,{recursive:true,force:true});}
});

it("preserves normal inline source-related attributes in the reviewed type set", () => {
  const fixture = applicationFixture();
  try {
    fixture.env["EXTRA_PLAN_CHANGES"] = JSON.stringify([{
      mode: "managed", type: "aws_security_group", address: "aws_security_group.other",
      change: {after: {source_security_group_id: "sg-controlled"}},
    }]);
    const result = fixture.invoke("apply");
    expect(result.status,result.stdout+result.stderr).toBe(0);
  } finally {rmSync(fixture.directory,{recursive:true,force:true});}
});

it("refuses application of a legacy handoff without its required local artifact", () => {
  const fixture = applicationFixture({legacy:true});
  try {
    const result = fixture.invoke("apply");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ok:false,reason:"local_artifact_missing"});
    const calls = readFileSync(fixture.calls,"utf8").trim().split("\n").map(line=>JSON.parse(line));
    expect(calls.some(call=>call.program === "aws" && call.args[1] === "put-object")).toBe(false);
    expect(calls.some(call=>call.program === "terraform" && call.args[0] === "apply")).toBe(false);
  } finally {rmSync(fixture.directory,{recursive:true,force:true});}
});

it.each(["./.terraform/alarm-digest/fss-rh-other.zip", "../outside.zip"])("refuses an artifact path outside the reviewed diagnostic prefix", (filename) => {
  const fixture=applicationFixture();
  try {
    fixture.env["ARCHIVE_FILENAME"]=filename;
    const result=fixture.invoke("apply");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ok:false,reason:"local_artifact_binding_changed"});
    const calls=readFileSync(fixture.calls,"utf8").trim().split("\n").map(line=>JSON.parse(line));
    expect(calls.some(call=>call.program==="aws" && call.args[1]==="put-object")).toBe(false);
    expect(calls.some(call=>call.program==="terraform" && call.args[0]==="apply")).toBe(false);
  } finally {rmSync(fixture.directory,{recursive:true,force:true});}
});

it("refuses a symlinked artifact directory without writing outside the application checkout", () => {
  const fixture=applicationFixture();
  try {
    const terraformRoot=join(fixture.checkout,"infra/roots/rehearsal/.terraform");
    const outside=join(fixture.directory,"outside");
    mkdirSync(terraformRoot);mkdirSync(outside);
    symlinkSync(outside,join(terraformRoot,"alarm-digest"),'dir');
    const result=fixture.invoke("apply");
    expect(result.status).toBe(1);
    expect(existsSync(join(outside,"fss-rh-cap90-o10a.zip"))).toBe(false);
    const calls=readFileSync(fixture.calls,"utf8").trim().split("\n").map(line=>JSON.parse(line));
    expect(calls.some(call=>call.program==="aws" && call.args[1]==="put-object")).toBe(false);
    expect(calls.some(call=>call.program==="terraform" && call.args[0]==="apply")).toBe(false);
  } finally {rmSync(fixture.directory,{recursive:true,force:true});}
});

it("stops before Terraform apply if the restored artifact changes during durable registration", () => {
  const fixture = applicationFixture();
  try {
    fixture.env["CHANGE_ARCHIVE_AFTER_REGISTRATION"]="1";
    const result=fixture.invoke("apply");
    expect(result.status).toBe(1);
    const calls=readFileSync(fixture.calls,"utf8").trim().split("\n").map(line=>JSON.parse(line));
    expect(calls.some(call=>call.program==="aws" && call.args[1]==="put-object")).toBe(true);
    expect(calls.some(call=>call.program==="terraform" && call.args[0]==="apply")).toBe(false);
    expect(result.stdout+result.stderr).not.toMatch(/PRIVATE_PROVIDER|CHANGED_CONTROLLED_FILE/);
  } finally {rmSync(fixture.directory,{recursive:true,force:true});}
});

it.each(["PRIVATE_ARCHIVE_SENTINEL", Buffer.alloc(1048577).toString("base64")])("refuses malformed or oversized retained artifacts before application", (archive) => {
  const fixture = applicationFixture({archive});
  try {
    const result = fixture.invoke("apply");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ok:false,reason:"local_artifact_invalid"});
    expect(result.stdout+result.stderr).not.toContain("PRIVATE_ARCHIVE_SENTINEL");
    const calls = readFileSync(fixture.calls,"utf8").trim().split("\n").map(line=>JSON.parse(line));
    expect(calls.some(call=>call.program === "aws" && call.args[1] === "put-object")).toBe(false);
    expect(calls.some(call=>call.program === "terraform" && call.args[0] === "apply")).toBe(false);
  } finally {rmSync(fixture.directory,{recursive:true,force:true});}
});

it("still cleans an independently registered legacy handoff without restoring its missing artifact", () => {
  const fixture = applicationFixture({legacy:true});
  try {
    const registered = spawnSync(process.execPath,[join(fixture.checkout,"infra/scripts/diagnostic-handoff.mjs"),"register",fixture.leasePath,fixture.expectedHash,join(fixture.directory,"legacy-registration")],{encoding:"utf8",env:fixture.env});
    expect(registered.status,registered.stdout+registered.stderr).toBe(0);
    const result = fixture.invoke("cleanup");
    expect(result.status,result.stdout+result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ok:true,stage:"cleaned",absenceVerified:true,activationAllowed:false});
    expect(existsSync(join(fixture.checkout,"infra/roots/rehearsal/.terraform/alarm-digest/fss-rh-cap90-o10a.zip"))).toBe(false);
  } finally {rmSync(fixture.directory,{recursive:true,force:true});}
});

it.each([
  ["unreadable", undefined, true],
  ["malformed", "private malformed state", false],
  ["null", "null", false],
  ["unsupported format", '{"format_version":"2.0"}', false],
  ["invalid values", '{"format_version":"1.0","values":[]}', false],
  ["invalid resources", '{"format_version":"1.0","values":{"root_module":{"resources":{}}}}', false],
  ["nested resources", '{"format_version":"1.0","values":{"root_module":{"child_modules":[{"resources":[{"address":"owned-resource"}]}]}}}', false],
] as const)("refuses %s state before exact application without treating errors as absence", (_name, state, failed) => {
  const fixture = applicationFixture();
  try {
    if (failed) fixture.env["FAIL_STATE_READ"] = "1";
    if (state !== undefined) fixture.env["STATE_JSON"] = state;
    const result = fixture.invoke("apply");
    expect(result.status).toBe(1);
    expect(existsSync(join(fixture.directory, "applied"))).toBe(false);
    expect(result.stdout + result.stderr).not.toMatch(/PRIVATE_PROVIDER_ERROR|private malformed state/);
  } finally {
    rmSync(fixture.directory, {recursive: true, force: true});
  }
});
it("refuses resources appearing after registration and never applies the saved plan", () => {
  const fixture = applicationFixture();
  try {
    fixture.env["STATE_AFTER_REGISTRATION"] = '{"format_version":"1.0","values":{"root_module":{"resources":[{"address":"new-resource"}]}}}';
    const result = fixture.invoke("apply");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ok:false,reason:"application_preflight_changed"});
    expect(existsSync(join(fixture.directory, "applied"))).toBe(false);
    expect(existsSync(join(fixture.directory, "private/plan/reviewed.tfplan"))).toBe(false);
  } finally {
    rmSync(fixture.directory, {recursive: true, force: true});
  }
});

it("binds both private Google clients to the reviewed lease before accepting local validation", () => {
  const directory = mkdtempSync(join(tmpdir(), "fss-diagnostic-validate-"));
  try {
    const lease = leaseFixture();
    const path = join(directory, "lease.json");
    const raw = JSON.stringify(lease);
    writeFileSync(path, raw);
    const hash = createHash("sha256").update(raw).digest("hex");
    const input = {
      oidc: {
        client_id: lease.google.oidcClientId,
        client_secret: "CONTROLLED_PRIVATE_OIDC",
        project_id: lease.google.projectId,
        redirect_uris: [lease.google.redirectUris.oidc],
      },
      gmail: {
        client_id: lease.google.gmailClientId,
        client_secret: "CONTROLLED_PRIVATE_GMAIL",
        project_id: lease.google.projectId,
        redirect_uris: [lease.google.redirectUris.gmail],
      },
    };
    const invoke = (value: unknown) =>
      spawnSync(
        process.execPath,
        [script, "validate", path, hash, join(directory, "private")],
        {
          input: JSON.stringify(value),
          encoding: "utf8",
          env: {
            ...process.env,
            GITHUB_REF: "refs/heads/main",
            GITHUB_SHA: lease.sourceCommit,
            GITHUB_RUN_ID: "123",
            GITHUB_RUN_ATTEMPT: "1",
          },
        },
      );
    const mismatch = invoke({
      ...input,
      gmail: {
        ...input.gmail,
        client_id: "123456-other.apps.googleusercontent.com",
      },
    });
    expect(mismatch.status).toBe(1);
    expect(mismatch.stdout.trim()).toBe(
      '{"ok":false,"reason":"private_google_client_mismatch"}',
    );
    const accepted = invoke(input);
    expect(accepted.status, accepted.stdout + accepted.stderr).toBe(0);
    expect(JSON.parse(accepted.stdout)).toEqual({
      ok: true,
      stage: "validated",
      applyPerformed: false,
      activationAllowed: false,
    });
    expect(accepted.stdout + accepted.stderr).not.toContain(
      "CONTROLLED_PRIVATE",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("refuses application without private isolated Google inputs before any external operation", () => {
  const directory = mkdtempSync(join(tmpdir(), "fss-diagnostic-lifecycle-"));
  try {
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const calls = join(directory, "calls");
    for (const name of ["aws", "terraform", "gh", "docker"]) {
      const path = join(bin, name);
      writeFileSync(
        path,
        '#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.CALLS,"unexpected external operation\\n");process.exit(1);\n',
      );
      chmodSync(path, 0o755);
    }
    const leasePath = join(directory, "lease.json");
    writeFileSync(leasePath, "{}");
    const result = spawnSync(
      process.execPath,
      [script, "apply", leasePath, "a".repeat(64), join(directory, "private")],
      {
        input: "",
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env["PATH"]}`,
          CALLS: calls,
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe(
      '{"ok":false,"reason":"private_google_inputs_required"}',
    );
    expect(result.stderr).toBe("");
    expect(existsSync(calls) ? readFileSync(calls, "utf8") : "").toBe("");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("does not expose or accept rehearsal OAuth filler as real private inputs", () => {
  const result = spawnSync(
    process.execPath,
    [
      script,
      "apply",
      "/unavailable/lease.json",
      "a".repeat(64),
      "/unavailable/private",
    ],
    {
      input: JSON.stringify({
        oidc: {
          client_id: "rehearsal-fake.apps.googleusercontent.com",
          client_secret: "PRIVATE_SENTINEL_NOT_REAL",
        },
        gmail: {},
      }),
      encoding: "utf8",
    },
  );
  expect(result.status).toBe(1);
  expect(result.stdout.trim()).toBe(
    '{"ok":false,"reason":"private_google_inputs_invalid"}',
  );
  expect(result.stdout + result.stderr).not.toContain(
    "PRIVATE_SENTINEL_NOT_REAL",
  );
});

it("refuses changed approval and an expired or different originating lifecycle during local validation", () => {
  const directory = mkdtempSync(join(tmpdir(), "fss-diagnostic-authority-"));
  try {
    const lease = leaseFixture();
    const input = {
      oidc: {
        client_id: lease.google.oidcClientId,
        client_secret: "CONTROLLED_PRIVATE_OIDC",
        project_id: lease.google.projectId,
        redirect_uris: [lease.google.redirectUris.oidc],
      },
      gmail: {
        client_id: lease.google.gmailClientId,
        client_secret: "CONTROLLED_PRIVATE_GMAIL",
        project_id: lease.google.projectId,
        redirect_uris: [lease.google.redirectUris.gmail],
      },
    };
    const path = join(directory, "lease.json");
    const invoke = (
      value: typeof lease,
      changedHash = false,
      changedRun = false,
    ) => {
      const raw = JSON.stringify(value);
      writeFileSync(path, raw);
      return spawnSync(
        process.execPath,
        [
          script,
          "validate",
          path,
          changedHash
            ? "0".repeat(64)
            : createHash("sha256").update(raw).digest("hex"),
          join(directory, "private"),
        ],
        {
          input: JSON.stringify(input),
          encoding: "utf8",
          env: {
            ...process.env,
            GITHUB_REF: "refs/heads/main",
            GITHUB_SHA: changedRun ? "c".repeat(40) : lease.sourceCommit,
            GITHUB_RUN_ID: "123",
            GITHUB_RUN_ATTEMPT: "1",
          },
        },
      );
    };
    expect(JSON.parse(invoke(lease, true).stdout)).toEqual({
      ok: false,
      reason: "lease_hash_changed",
    });
    expect(JSON.parse(invoke(lease, false, true).stdout)).toEqual({
      ok: false,
      reason: "lifecycle_run_changed",
    });
    const approvedAt = new Date(Date.now() - 3600000).toISOString();
    const startDeadline = new Date(Date.now() - 1000).toISOString();
    expect(
      JSON.parse(invoke({ ...lease, approvedAt, startDeadline }).stdout),
    ).toEqual({ ok: false, reason: "lease_start_expired" });
    expect(existsSync(join(directory, "private"))).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("refuses unregistered cleanup and reuses exact registered configuration for teardown and guard", () => {
  const fixture = applicationFixture();
  try {
    const unowned = fixture.invoke("cleanup", "unowned");
    expect(unowned.status).toBe(1);
    expect(
      existsSync(fixture.calls) ? readFileSync(fixture.calls, "utf8") : "",
    ).not.toContain('"program": "bash"');
    expect(fixture.invoke("apply").status).toBe(0);
    const cleaned = fixture.invoke("cleanup", "cleanup");
    expect(cleaned.status, cleaned.stdout + cleaned.stderr).toBe(0);
    expect(JSON.parse(cleaned.stdout)).toEqual({
      ok: true,
      stage: "cleaned",
      absenceVerified: true,
      activationAllowed: false,
      retentionErasureSupported: false,
    });
    const calls = readFileSync(fixture.calls, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      calls
        .filter((call) => call.program === "bash")
        .map((call) => call.args.slice(1)),
    ).toEqual([
      ["teardown", fixture.lease.prefix],
      ["guard", fixture.lease.prefix],
    ]);
    expect(cleaned.stdout + cleaned.stderr).not.toContain("PRIVATE");
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

it.each(["array", "wrong-prefix", "swapped", "missing", "extra"])(
  "refuses an invalid secret-name map before credential writes or migration: %s", variant => {
    const fixture = applicationFixture();
    try {
      expect(fixture.invoke("apply").status).toBe(0);
      const outputPath = fixture.env["OUTPUTS"];
      if (outputPath === undefined) throw new Error("Terraform adapter output path is missing");
      const outputs = JSON.parse(readFileSync(outputPath,"utf8"));
      const names = outputs.secret_names.value;
      if (variant === "array") outputs.secret_names.value = Object.keys(names);
      if (variant === "wrong-prefix") names["google-gmail-oauth-client"] = "fss-rh-other/google-gmail-oauth-client";
      if (variant === "swapped") names["google-gmail-oauth-client"] = names["google-oidc-client"];
      if (variant === "missing") delete names["calcom"];
      if (variant === "extra") names["unreviewed"] = `${fixture.lease.prefix}/unreviewed`;
      writeFileSync(outputPath, JSON.stringify(outputs));
      const result = fixture.invoke("prepare");
      expect(result.status).toBe(1);
      const calls = readFileSync(fixture.calls,"utf8").trim().split("\n").map(line=>JSON.parse(line));
      expect(calls.some(call => call.program === "aws" && call.args[0] === "secretsmanager" && ["get-secret-value","put-secret-value"].includes(call.args[1]))).toBe(false);
      expect(calls.some(call => call.program === "bash")).toBe(false);
      expect(result.stdout+result.stderr).not.toMatch(/CONTROLLED_PRIVATE|CONTROLLED_MASTER|fss-rh-other/);
    } finally {rmSync(fixture.directory,{recursive:true,force:true});}
  },
);

it("prepares only the applied owned stack with private clients, then migrates and bootstraps without sending authority", () => {
  const fixture = applicationFixture();
  try {
    expect(fixture.invoke("prepare", "unapplied").status).toBe(1);
    expect(fixture.invoke("apply").status).toBe(0);
    const result = fixture.invoke("prepare");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      stage: "prepared",
      activationAllowed: false,
      consentRequired: true,
      dnsVerified: false,
      workspaceId: "33333333-3333-4333-8333-333333333333",
      ownerUserId: "44444444-4444-4444-8444-444444444444",
      releaseRecordReference: `ci-gate-201-${fixture.lease.imageBuildCommit.slice(0,12)}`,
      releaseRecordSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      gateRunId: "201",
      imagesRunId: "202",
    });
    const calls = readFileSync(fixture.calls, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const scripts = calls.filter((call) => call.program === "bash");
    const deployments=scripts.filter(call=>call.args[0].endsWith("/deploy.sh"));
    expect(deployments[0].args.slice(1, 3)).toEqual([
      "release",
      expect.stringContaining("infra/roots/rehearsal"),
    ]);
    expect(deployments[1].args).toContain("bootstrap");
    expect(deployments[1].args).toContain(fixture.lease.bootstrapAdminEmail);
    expect(scripts.flatMap((call) => call.args)).not.toContain(
      "--sending-domain",
    );
    expect(
      readFileSync(join(fixture.directory, "secret-capture"), "utf8"),
    ).toContain("CONTROLLED_PRIVATE_GMAIL");
    expect(result.stdout + result.stderr).not.toMatch(
      /CONTROLLED_PRIVATE|CONTROLLED_MASTER/,
    );
    expect(
      calls.some((call) =>
        JSON.stringify(call.args).includes("CONTROLLED_PRIVATE"),
      ),
    ).toBe(false);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

it("requires a CI-bound non-sending release record and durable readback before preparing the fresh database", () => {
  const fixture = applicationFixture();
  try {
    expect(fixture.invoke("apply").status).toBe(0);
    const prepared=fixture.invoke("prepare");
    expect(prepared.status).toBe(0);
    expect(JSON.parse(prepared.stdout)).toMatchObject({releaseRecordReference:`ci-gate-201-${fixture.lease.imageBuildCommit.slice(0,12)}`,gateRunId:"201",imagesRunId:"202",releaseRecordSha256:expect.stringMatching(/^[a-f0-9]{64}$/u)});
    const receipt = JSON.parse(readFileSync(join(fixture.directory,"private/prepared-receipt.json"),"utf8"));
    expect(receipt.releaseRecord).toMatchObject({gateRunId:"201",imagesRunId:"202",enablesSending:false,readBackVerified:true});
    const record = JSON.parse(readFileSync(join(fixture.directory,"private/preparation/release-record.private.json"),"utf8"));
    expect(record).toMatchObject({source:"ci-gate",commit:fixture.lease.imageBuildCommit,enablesSending:false,artifacts:{api:fixture.lease.images.api,worker:fixture.lease.images.worker,desktopCommitStamp:fixture.lease.imageBuildCommit}});
  } finally {rmSync(fixture.directory,{recursive:true,force:true});}
});

it("returns only the actual bootstrap workspace and owner IDs for fresh sign-in", () => {
 const fixture=applicationFixture();
 try{
  expect(fixture.invoke('apply').status).toBe(0);
  const prepared=fixture.invoke('prepare');
  expect(prepared.status).toBe(0);
  expect(JSON.parse(prepared.stdout)).toMatchObject({workspaceId:'33333333-3333-4333-8333-333333333333',ownerUserId:'44444444-4444-4444-8444-444444444444'});
  expect(prepared.stdout+prepared.stderr).not.toContain(fixture.lease.bootstrapAdminEmail);
 }finally{rmSync(fixture.directory,{recursive:true,force:true});}
});

it.each(['malformed','workspace','owner','membership'])("refuses a bootstrap %s mismatch before publishing sign-in bindings", variant => {
 const fixture=applicationFixture();
 try{
  expect(fixture.invoke('apply').status).toBe(0);
  fixture.env['BAD_BOOTSTRAP']=variant;
  const prepared=fixture.invoke('prepare');
  expect(prepared.status).toBe(1);
  expect(existsSync(join(fixture.directory,'private/prepared-receipt.json'))).toBe(false);
  expect(prepared.stdout+prepared.stderr).not.toMatch(/PRIVATE_BOOTSTRAP_CANARY|other@example.test|unreviewed-workspace/);
 }finally{rmSync(fixture.directory,{recursive:true,force:true});}
});

it.each(["provenance","put","read-back"])("refuses preparation when authentic release record %s cannot be verified", stage => {
 const fixture=applicationFixture();
 try {
  expect(fixture.invoke("apply").status).toBe(0);
  if(stage==='provenance')fixture.env['FAIL_RECORD_PROVENANCE']='1';
  else fixture.env['FAIL_RECORD_STAGE']=stage;
  const result=fixture.invoke("prepare");
  expect(result.status).toBe(1);
  expect(existsSync(join(fixture.directory,'private/prepared-receipt.json'))).toBe(false);
  expect(result.stdout+result.stderr).not.toContain('PRIVATE_RECORD_ERROR');
 }finally{rmSync(fixture.directory,{recursive:true,force:true});}
});

it("refuses hold if the prepared authentic release record has changed", () => {
 const fixture=applicationFixture();
 try {
  expect(fixture.invoke('apply').status).toBe(0);
  expect(fixture.invoke('prepare').status).toBe(0);
  writeFileSync(join(fixture.directory,'private/preparation/release-record.private.json'), '{}');
  const result=fixture.invoke('hold');
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout).reason).toBe('operation_refused_or_uncertain');
 }finally{rmSync(fixture.directory,{recursive:true,force:true});}
});

it("holds without provider operations and reports interrupted cleanup as unknown with a named fallback", async () => {
  const fixture = applicationFixture();
  try {
    expect(fixture.invoke("apply").status).toBe(0);
    expect(fixture.invoke("prepare").status).toBe(0);
    const before = readFileSync(fixture.calls, "utf8");
    const child = spawn(
      process.execPath,
      [
        join(fixture.checkout, "infra/scripts/diagnostic-lifecycle.mjs"),
        "hold",
        fixture.leasePath,
        fixture.expectedHash,
        join(fixture.directory, "private"),
      ],
      { env: fixture.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let error = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      error += data;
    });
    const ended = new Promise((resolveExit) =>
      child.on("exit", (code) => resolveExit(code)),
    );
    const timer = setTimeout(() => child.kill("SIGTERM"), 150);
    expect(await ended).toBe(1);
    clearTimeout(timer);
    const receipt = JSON.parse(output);
    expect(receipt).toMatchObject({
      ok: false,
      reason: "hold_interrupted",
      cleanupRequired: true,
      absenceVerified: false,
      fallbackOwner: fixture.lease.fallbackOwner,
      activationAllowed: false,
    });
    expect(error).toBe("");
    expect(readFileSync(fixture.calls, "utf8")).toBe(before);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

it("never reports absence or retries an uncertain apply or failed cleanup, and deletes decrypted plans", () => {
  const fixture = applicationFixture();
  try {
    fixture.env["FAIL_APPLY"] = "1";
    const applied = fixture.invoke("apply");
    expect(applied.status).toBe(1);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      ok: false,
      reason: "application_unknown",
      cleanupRequired: true,
      absenceVerified: false,
      fallbackOwner: fixture.lease.fallbackOwner,
      activationAllowed: false,
    });
    expect(
      existsSync(join(fixture.directory, "private/plan/reviewed.tfplan")),
    ).toBe(false);
    expect(fixture.invoke("apply", "retry").status).toBe(1);
    fixture.env["FAIL_CLEANUP"] = "1";
    const cleanup = fixture.invoke("cleanup", "cleanup");
    expect(cleanup.status).toBe(1);
    expect(JSON.parse(cleanup.stdout)).toMatchObject({
      ok: false,
      reason: "cleanup_unknown",
      cleanupRequired: true,
      absenceVerified: false,
      fallbackOwner: fixture.lease.fallbackOwner,
      activationAllowed: false,
    });
    expect(
      applied.stdout + applied.stderr + cleanup.stdout + cleanup.stderr,
    ).not.toContain("PRIVATE_PROVIDER_ERROR");
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

it.each(["WRONG_MASTER", "WRONG_ENDPOINT", "WRONG_TAG"])(
  "refuses another rehearsal resource through %s before reading any credential or writing a secret",
  (wrong) => {
    const fixture = applicationFixture();
    try {
      expect(fixture.invoke("apply").status).toBe(0);
      fixture.env[wrong] =
        wrong === "WRONG_MASTER"
          ? "arn:aws:secretsmanager:us-east-1:326255650484:secret:rds!db-other"
          : "other-rehearsal";
      const result = fixture.invoke("prepare");
      expect(result.status).toBe(1);
      expect(readFileSync(fixture.calls, "utf8")).not.toContain(
        "get-secret-value",
      );
      expect(existsSync(fixture.env["SECRET_CAPTURE"] ?? "")).toBe(false);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  },
);

it("rejects private Google project mismatch and additional production redirects before cloud access", () => {
  const fixture = applicationFixture();
  try {
    const input = {
      oidc: {
        client_id: fixture.lease.google.oidcClientId,
        client_secret: "CONTROLLED_PRIVATE_OIDC",
        project_id: fixture.lease.google.projectId,
        redirect_uris: [fixture.lease.google.redirectUris.oidc],
      },
      gmail: {
        client_id: fixture.lease.google.gmailClientId,
        client_secret: "CONTROLLED_PRIVATE_GMAIL",
        project_id: "different-google-project",
        redirect_uris: [fixture.lease.google.redirectUris.gmail],
      },
    };
    const invoke = () =>
      spawnSync(
        process.execPath,
        [
          join(fixture.checkout, "infra/scripts/diagnostic-lifecycle.mjs"),
          "apply",
          fixture.leasePath,
          fixture.expectedHash,
          join(fixture.directory, "private"),
        ],
        { input: JSON.stringify(input), encoding: "utf8", env: fixture.env },
      );
    expect(JSON.parse(invoke().stdout)).toEqual({
      ok: false,
      reason: "private_google_client_mismatch",
    });
    input.gmail.project_id = fixture.lease.google.projectId;
    input.gmail.redirect_uris.push(
      "https://app.usecallie.com/oauth/gmail/callback",
    );
    expect(JSON.parse(invoke().stdout)).toEqual({
      ok: false,
      reason: "private_google_inputs_invalid",
    });
    expect(existsSync(fixture.calls)).toBe(false);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

it("rechecks changed source after private external waits and refuses creation with decrypted bytes removed", () => {
  const fixture = applicationFixture();
  try {
    fixture.env["DIRTY_AFTER_WAIT"] = "1";
    const result = fixture.invoke("apply");
    expect(result.status).toBe(1);
    const calls = readFileSync(fixture.calls, "utf8");
    expect(calls).not.toContain('"apply"');
    expect(calls).not.toContain("put-object");
    expect(
      existsSync(join(fixture.directory, "private/plan/reviewed.tfplan")),
    ).toBe(false);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
