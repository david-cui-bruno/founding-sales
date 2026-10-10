import { spawnSync } from "node:child_process";
import { createHash, createCipheriv } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  cpSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

// A fixed synthetic ZIP containing index.mjs and digest.mjs, independent of the handoff.
const archiveBase64 =
  "UEsDBBQAAAAIAAAAIQBX4GbXJQAAACMAAAAJAAAAaW5kZXgubWpzS87PK87PSdXLyU/XUErOzyspys/JSU1RSCxKzsgsS1XStOYCAFBLAwQUAAAACAAAACEA8R9pmB4AAAAgAAAACgAAAGRpZ2VzdC5tanNLrSjILypRSM7PKwaTJUX5OTmpKQq2CiVFpanWXABQSwECFAMUAAAACAAAACEAV+Bm1yUAAAAjAAAACQAAAAAAAAAAAAAApIEAAAAAaW5kZXgubWpzUEsBAhQDFAAAAAgAAAAhAPEfaZgeAAAAIAAAAAoAAAAAAAAAAAAAAKSBTAAAAGRpZ2VzdC5tanNQSwUGAAAAAAIAAgBvAAAAkgAAAAAA";

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

function applicationFixture(
  options: { archive?: string; legacy?: boolean } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "fss-diagnostic-apply-"));
  const checkout = join(directory, "checkout");
  mkdirSync(checkout);
  cpSync(resolve("infra"), join(checkout, "infra"), {
    recursive: true,
    filter: (path) =>
      !path.split("/").includes(".terraform") &&
      !path.endsWith("/run.auto.tfvars.json"),
  });
  mkdirSync(join(checkout, "packages/contracts"), { recursive: true });
  cpSync(
    resolve("packages/contracts/src"),
    join(checkout, "packages/contracts/src"),
    { recursive: true },
  );
  symlinkSync(resolve("node_modules"), join(checkout, "node_modules"), "dir");
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
        ...(options.legacy
          ? {}
          : { alarmDigestArchive: options.archive ?? archiveBase64 }),
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
      secret_names: Object.fromEntries(
        [
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
        ].map((name) => [name, `${lease.prefix}/${name}`]),
      ),
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
  Object.assign(outputs, {
    cluster_arn: {
      value: `arn:aws:ecs:us-east-1:326255650484:cluster/${lease.prefix}-cluster`,
    },
    migration_task_definition_arn: {
      value: `arn:aws:ecs:us-east-1:326255650484:task-definition/${lease.prefix}-migration:1`,
    },
    operations_task_definition_arn: {
      value: `arn:aws:ecs:us-east-1:326255650484:task-definition/${lease.prefix}-operations:1`,
    },
    task_network_configuration: {
      value: {
        subnet_ids: ["subnet-controlled"],
        security_group_id: "sg-controlled",
        database_host: "controlled-db.us-east-1.rds.amazonaws.com",
      },
    },
  });
  writeFileSync(join(directory, "outputs.json"), JSON.stringify(outputs));
  const programs = {
    bash: `#!/usr/bin/env python3\nimport os,sys,json\na=sys.argv[1:];open(os.environ['CALLS'],'a').write(json.dumps({'program':'bash','args':a})+'\\n')\nif os.environ.get('FAIL_CLEANUP')=='1':print('PRIVATE_PROVIDER_ERROR');sys.exit(1)\n`,
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
 if a[a.index('--key')+1].endswith('/intent.json'):open(os.environ['STORE']+'/operation-intent-marker','w').write('consumed')
 if os.environ.get('CHANGE_ARCHIVE_AFTER_REGISTRATION')=='1' and a[a.index('--key')+1].endswith('/lease.json'):open(os.environ['ARCHIVE_PATH'],'wb').write(b'CHANGED_CONTROLLED_FILE')
 print(json.dumps({'ETag':'"controlled"'}))
elif a[:2]==['ecs','describe-tasks']:
 o=json.load(open(os.environ['OUTPUTS']));p=o['name_prefix']['value'];ts=a[a.index('--tasks')+1:];ts=ts[:2];print(json.dumps({'tasks':[{'taskArn':t,'clusterArn':o['cluster_arn']['value'],'lastStatus':'RUNNING','taskDefinitionArn':'arn:aws:ecs:us-east-1:326255650484:task-definition/'+p+'-'+n+':1','containers':[{'name':n,'imageDigest':'sha256:'+('f' if os.environ.get('CHANGE_TASK_AFTER_INTENT')=='1' and os.path.exists(os.environ['STORE']+'/operation-intent-marker') else d)*64}]} for t,n,d in zip(ts,['api','worker'],['1','2'])]}))
else:sys.exit(1)
`,
    git: `#!/usr/bin/env python3
import os,sys
if sys.argv[1]=='status':
 p=os.environ['STORE']+'/git-count';n=int(open(p).read())+1 if os.path.exists(p) else 1;open(p,'w').write(str(n));print(' M infra/roots/rehearsal/backend.hcl' if os.environ.get('DIRTY_AFTER_WAIT')=='1' and n>1 else (' M infra/roots/rehearsal/backend.hcl' if n>int(os.environ.get('DIRTY_THRESHOLD','999999')) else ''))
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
  programs["bash"] += `
if os.environ.get('FSS_RELEASE_CAPTURE'):
 json.dump({'workspaceId':'44444444-4444-4444-8444-444444444444','mailboxId':'55555555-5555-4555-8555-555555555555','ownerUserId':'66666666-6666-4666-8666-666666666666','providerAccountId':'david@usecallie.com','generation':1,'accountBinding':'a'*64,'oauthGrantObservationId':'77777777-7777-4777-8777-777777777777','databaseName':'fss_diagnostic_cap90_o10a','schemaVersion':90,'disclosureVersion':'crm-mail-body-acquisition-v1','disclosureSha256':'b'*64,'readOnly':True,'productionActivationAllowed':False,**({'body':'CONTROLLED_PRIVATE_ORIGINAL'} if os.environ.get('PRIVATE_RESULT')=='1' else {})},open(os.environ['FSS_RELEASE_CAPTURE'],'w'))
`;
  programs["bash"] += `
if os.environ.get('FSS_RELEASE_CAPTURE') and 'revoke' in a:json.dump({'authorizationId':a[a.index('--authorization')+1]},open(os.environ['FSS_RELEASE_CAPTURE'],'w'))
if os.environ.get('FSS_RELEASE_CAPTURE') and 'provision' in a:
 import base64
 g=json.loads(base64.b64decode(a[a.index('--json-base64')+1]));json.dump({'authorizationId':g['id'],'sha256':a[a.index('--sha256')+1]},open(os.environ['FSS_RELEASE_CAPTURE'],'w'))
`;
  const gh = `#!/usr/bin/env python3
import json,os,sys
a=sys.argv[1:]
if 'workflows' in a[-1]:print(json.dumps({'id':1,'path':'.github/workflows/crm-acquisition-diagnostic.yml'}))
else:print(json.dumps({'id':123,'run_attempt':1,'status':os.environ.get('ORIGIN_STATUS','in_progress'),'head_sha':os.environ['GITHUB_SHA'],'head_branch':'main','event':'workflow_dispatch','repository':{'full_name':'david-cui-bruno/founding-sales'},'head_repository':{'full_name':'david-cui-bruno/founding-sales'},'workflow_id':1}))
`;
  writeFileSync(join(bin, "gh"), gh);
  chmodSync(join(bin, "gh"), 0o755);
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
    ARCHIVE_PATH: join(
      checkout,
      "infra/roots/rehearsal/.terraform/alarm-digest/fss-rh-cap90-o10a.zip",
    ),
    ARCHIVE_HASH: createHash("sha256")
      .update(Buffer.from(archiveBase64, "base64"))
      .digest("base64"),
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
function operationFixture() {
  const fixture = applicationFixture();
  expect(fixture.invoke("apply").status).toBe(0);
  const sha = (value: string | Buffer) =>
    createHash("sha256").update(value).digest("hex");
  const input: Record<string, unknown> = {
    workspaceId: "44444444-4444-4444-8444-444444444444",
    mailboxId: "55555555-5555-4555-8555-555555555555",
    ownerUserId: "66666666-6666-4666-8666-666666666666",
  };
  const action = {
    version: 1,
    purpose: "acquisition_diagnostic_operation",
    operationId: "33333333-3333-4333-8333-333333333333",
    action: "bindings",
    origin: { runId: "123", attempt: "1" },
    leaseSha256: fixture.expectedHash,
    sourceCommit: fixture.lease.sourceCommit,
    environmentId: fixture.lease.environmentId,
    workerImageDigest: fixture.lease.images.worker,
    approvedAt: fixture.lease.approvedAt,
    validUntil: fixture.lease.cleanupAt,
    reviewReference: "controlled independent action review",
    input,
  };
  fixture.env["GITHUB_RUN_ID"] = "456";
  let hash = "";
  const retain = () => {
    const raw = JSON.stringify(action);
    hash = sha(raw);
    const key = `fss/greenfield/rehearsal/${fixture.lease.prefix}/diagnostic/operations/reviews/${hash}.json`;
    writeFileSync(join(fixture.env["STORE"]!, sha(key)), raw);
  };
  retain();
  const execute = (name = "operation") =>
    spawnSync(
      process.execPath,
      [
        join(fixture.checkout, "infra/scripts/diagnostic-operation.mjs"),
        "execute",
        "123",
        "1",
        fixture.expectedHash,
        hash,
        join(fixture.directory, name),
      ],
      { env: fixture.env, encoding: "utf8" },
    );
  return { ...fixture, action, retain, execute };
}
it("executes only the independently reviewed owned bindings read and retains output privately", () => {
  const f = operationFixture();
  try {
    const result = f.execute();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      action: "bindings",
      activationAllowed: false,
    });
    expect(result.stdout + result.stderr).not.toContain(
      "controlled@example.test",
    );
    expect(f.execute("retry").status).toBe(1);
    const calls = readFileSync(f.calls, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      calls.filter((c) => c.program === "bash" && c.args.includes("run-task")),
    ).toHaveLength(1);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});
it.each(["scope", "expiry", "origin", "arbitrary", "extra", "image"])(
  "refuses %s drift before consuming task authority",
  (kind) => {
    const f = operationFixture();
    try {
      if (kind === "scope")
        f.action.environmentId = "99999999-9999-4999-8999-999999999999";
      if (kind === "expiry")
        f.action.validUntil = new Date(Date.now() + 60000).toISOString();
      if (kind === "origin") f.env["ORIGIN_STATUS"] = "completed";
      if (kind === "arbitrary") f.action.action = "send";
      if (kind === "extra")
        Object.assign(f.action.input, { body: "PRIVATE_BODY" });
      if (kind === "image")
        f.action.workerImageDigest = "sha256:" + "f".repeat(64);
      f.retain();
      const result = f.execute();
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).not.toMatch(
        /PRIVATE_BODY|CONTROLLED_PRIVATE/,
      );
      const calls = readFileSync(f.calls, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        calls.filter(
          (c) => c.program === "bash" && c.args.includes("run-task"),
        ),
      ).toHaveLength(0);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  },
);
it("does not erase an existing working directory when initialization refuses", () => {
  const f = operationFixture();
  try {
    mkdirSync(join(f.directory, "existing"));
    writeFileSync(join(f.directory, "existing", "keep"), "retained");
    expect(f.execute("existing").status).toBe(1);
    expect(readFileSync(join(f.directory, "existing", "keep"), "utf8")).toBe(
      "retained",
    );
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});
it("refuses source drift after intent retention and conserves the consumed attempt", () => {
  const f = operationFixture();
  try {
    const count = Number(
      readFileSync(join(f.env["STORE"]!, "git-count"), "utf8"),
    );
    f.env["DIRTY_THRESHOLD"] = String(count + 2);
    const result = f.execute();
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).intentConsumed).toBe(true);
    const calls = readFileSync(f.calls, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      calls.filter((c) => c.program === "bash" && c.args.includes("run-task")),
    ).toHaveLength(0);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});
it("rejects private fields returned by a task without logging or retrying them", () => {
  const f = operationFixture();
  try {
    f.env["PRIVATE_RESULT"] = "1";
    const result = f.execute();
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).intentConsumed).toBe(true);
    expect(result.stdout + result.stderr).not.toContain(
      "CONTROLLED_PRIVATE_ORIGINAL",
    );
    expect(f.execute("retry").status).toBe(1);
    const calls = readFileSync(f.calls, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      calls.filter((c) => c.program === "bash" && c.args.includes("run-task")),
    ).toHaveLength(1);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});
it("runs the exact reviewed revocation through the migration task only", () => {
  const f = operationFixture();
  try {
    f.action.action = "revoke";
    for (const key of Object.keys(f.action.input)) delete f.action.input[key];
    Object.assign(f.action.input, {
      workspaceId: "44444444-4444-4444-8444-444444444444",
      authorizationId: "88888888-8888-4888-8888-888888888888",
      reference: "controlled scoped revocation",
    });
    f.retain();
    const result = f.execute();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).action).toBe("revoke");
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});
it("provisions only the two frozen originals using the reviewed image and actual owned task witnesses", () => {
  const f = operationFixture();
  try {
    const g = {
      id: "88888888-8888-4888-8888-888888888888",
      purpose: "acquisition_acceptance",
      workspaceId: "44444444-4444-4444-8444-444444444444",
      mailboxId: "55555555-5555-4555-8555-555555555555",
      ownerUserId: "66666666-6666-4666-8666-666666666666",
      providerAccountId: f.lease.bootstrapAdminEmail,
      accountBinding: "a".repeat(64),
      generation: 1,
      oauthGrantObservationId: "77777777-7777-4777-8777-777777777777",
      databaseInstanceArn: `arn:aws:rds:us-east-1:326255650484:db:${f.lease.prefix}-pg`,
      databaseSecretArn: `arn:aws:secretsmanager:us-east-1:326255650484:secret:${f.lease.prefix}/app-runtime-database-controlled`,
      databaseEndpoint: "controlled-db.us-east-1.rds.amazonaws.com",
      ecsClusterArn: `arn:aws:ecs:us-east-1:326255650484:cluster/${f.lease.prefix}-cluster`,
      deploymentIdentity: `arn:aws:ecs:us-east-1:326255650484:task/${f.lease.prefix}-cluster/api-task`,
      workerDeploymentIdentity: `arn:aws:ecs:us-east-1:326255650484:task/${f.lease.prefix}-cluster/worker-task`,
      environmentId: f.lease.environmentId,
      databaseName: f.lease.databaseName,
      implementationCommit: f.lease.imageBuildCommit,
      apiImageDigest: f.lease.images.api,
      workerImageDigest: f.lease.images.worker,
      schemaVersion: 90,
      releaseReference: "controlled-ci-gate",
      disclosureVersion: "crm-mail-body-acquisition-v1",
      disclosureSha256: "b".repeat(64),
      consentReference: "controlled actual readonly consent",
      providerPolicyReference: "controlled policy",
      reviewedBy: "66666666-6666-4666-8666-666666666666",
      reviewReference: "controlled independent review",
      verifiedAt: f.lease.approvedAt,
      validUntil: new Date(
        Date.parse(f.lease.cleanupAt) - 360000,
      ).toISOString(),
      maxReads: 8,
      maxUnits: 160,
      metadataUnits: 20,
      bodyUnits: 20,
      messages: [
        {
          messageId: "1a11cef279246619",
          threadId: "1a11c079cb7273b8",
          origin: "received",
          fromAt: "2026-10-08T00:00:00Z",
          toAt: "2026-10-09T00:00:00Z",
        },
        {
          messageId: "1a11ddf7ccdb1bac",
          threadId: "1a11c0797273b8",
          origin: "sent",
          fromAt: "2026-10-08T00:00:00Z",
          toAt: "2026-10-09T00:00:00Z",
        },
      ],
    };
    // First reject a genuinely different scope before task dispatch, then use the exact approved scope.
    f.action.action = "provision";
    for (const key of Object.keys(f.action.input)) delete f.action.input[key];
    const configure = () => {
      Object.assign(f.action.input, {
        authorization: g,
        authorizationSha256: createHash("sha256")
          .update(JSON.stringify(g))
          .digest("hex"),
      });
      f.retain();
    };
    configure();
    expect(f.execute("wrong-scope").status).toBe(1);
    g.messages[1]!.threadId = "1a11c079cb7273b8";
    configure();
    f.env["CHANGE_TASK_AFTER_INTENT"] = "1";
    const stale = f.execute("stale-after-wait");
    expect(stale.status).toBe(1);
    expect(JSON.parse(stale.stdout).intentConsumed).toBe(true);
    delete f.env["CHANGE_TASK_AFTER_INTENT"];
    f.action.operationId = "99999999-9999-4999-8999-999999999999";
    configure();
    const result = f.execute();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).action).toBe("provision");
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});
