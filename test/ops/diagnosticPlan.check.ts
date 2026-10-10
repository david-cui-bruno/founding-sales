import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const script = resolve("infra/scripts/diagnostic-plan.mjs");
const keys = generateKeyPairSync("rsa", { modulusLength: 3072 });
const publicKey = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const fingerprint = createHash("sha256")
  .update(keys.publicKey.export({ type: "spki", format: "der" }))
  .digest("hex");
const config = {
  environmentId: "11111111-2222-4333-8444-555555555555",
  databaseName: "fss_diagnostic_cap90_o10a",
  apiHostname: "cap90-o10a.rehearsal.usecallie.com",
  recipientPublicKeyPem: publicKey,
  recipientPublicKeySha256: fingerprint,
};
function runConfig(change: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fss-diag-plan-"));
  try {
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ ...config, ...change }));
    const run = spawnSync(
      process.execPath,
      [
        "--experimental-transform-types",
        script,
        "validate",
        file,
        join(dir, "out"),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: "a".repeat(40),
          GITHUB_RUN_ID: "123",
          GITHUB_RUN_ATTEMPT: "1",
          FSS_DIAGNOSTIC_RUN_SUFFIX: "cap90-o10a",
          FSS_DIAGNOSTIC_API_DIGEST: `sha256:${"1".repeat(64)}`,
          FSS_DIAGNOSTIC_WORKER_DIGEST: `sha256:${"2".repeat(64)}`,
          FSS_DIAGNOSTIC_CERTIFICATE_ARN:
            "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-4333-8444-555555555555",
          FSS_DIAGNOSTIC_API_REPOSITORY:
            "123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-rh-api",
          FSS_DIAGNOSTIC_WORKER_REPOSITORY:
            "123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-rh-worker",
          FSS_DIAGNOSTIC_ZONES: "us-east-1a,us-east-1d",
        },
      },
    );
    return {
      status: run.status,
      output: run.stdout + run.stderr,
      validated:
        run.status === 0
          ? JSON.parse(readFileSync(join(dir, "out", "validated.json"), "utf8"))
          : null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
it("prepares an exact identifier-only diagnostic proposal without a cloud command", () => {
  const run = runConfig();
  expect(run.status, run.output).toBe(0);
  expect(run.validated).toMatchObject({
    prefix: "fss-rh-cap90-o10a",
    stateKey: "fss/greenfield/rehearsal/fss-rh-cap90-o10a/terraform.tfstate",
    schema: 90,
    configuration: {
      crm_acquisition_diagnostic: {
        environment_id: config.environmentId,
        database_name: config.databaseName,
      },
      api_hostname: config.apiHostname,
      bootstrap: true,
      assume_deployment_role: false,
    },
  });
});

it("retains an authenticated encrypted plan that only the local recipient can read", () => {
  const dir = mkdtempSync(join(tmpdir(), "fss-plan-envelope-"));
  try {
    const plan = join(dir, "plan");
    writeFileSync(plan, "private-plan-fixture");
    const manifest = join(dir, "manifest.json");
    writeFileSync(
      manifest,
      JSON.stringify({
        version: "fss.diagnostic-plan.v1",
        planSha256: createHash("sha256")
          .update("private-plan-fixture")
          .digest("hex"),
        commit: "a".repeat(40),
      }),
    );
    const pub = join(dir, "public.pem"),
      priv = join(dir, "private.pem");
    writeFileSync(pub, publicKey);
    writeFileSync(
      priv,
      keys.privateKey.export({ type: "pkcs8", format: "pem" }),
    );
    const envelope = join(dir, "encrypted.json");
    writeFileSync(
      pub,
      publicKey +
        "\n-----BEGIN PRIVATE KEY-----\nfixture-secret\n-----END PRIVATE KEY-----\n",
    );
    const unsafeSeal = spawnSync(
      process.execPath,
      [
        "--experimental-transform-types",
        script,
        "seal",
        plan,
        manifest,
        pub,
        fingerprint,
        envelope,
      ],
      { encoding: "utf8" },
    );
    expect(unsafeSeal.status).toBe(1);
    expect(unsafeSeal.stdout + unsafeSeal.stderr).not.toContain(
      "fixture-secret",
    );
    writeFileSync(pub, publicKey);

    const seal = spawnSync(
      process.execPath,
      [
        "--experimental-transform-types",
        script,
        "seal",
        plan,
        manifest,
        pub,
        fingerprint,
        envelope,
      ],
      { encoding: "utf8" },
    );
    expect(seal.status, seal.stdout + seal.stderr).toBe(0);
    expect(readFileSync(envelope, "utf8")).not.toContain(
      "private-plan-fixture",
    );
    const opened = join(dir, "opened");
    const decrypt = () =>
      spawnSync(
        process.execPath,
        [
          "--experimental-transform-types",
          script,
          "decrypt",
          envelope,
          manifest,
          priv,
          opened,
        ],
        { encoding: "utf8" },
      );
    expect(decrypt().status).toBe(0);
    expect(readFileSync(opened, "utf8")).toBe("private-plan-fixture");
    rmSync(opened);
    const originalManifest = readFileSync(manifest);
    const originalEnvelope = readFileSync(envelope);
    writeFileSync(manifest, "{}");
    expect(decrypt().status).toBe(1);
    writeFileSync(manifest, originalManifest);
    const packet = JSON.parse(originalEnvelope.toString());
    packet.tag = Buffer.alloc(16).toString("base64");
    writeFileSync(envelope, JSON.stringify(packet, null, 2) + "\n");
    expect(decrypt().status).toBe(1);
    writeFileSync(envelope, originalEnvelope);
    writeFileSync(
      priv,
      generateKeyPairSync("rsa", { modulusLength: 3072 }).privateKey.export({
        type: "pkcs8",
        format: "pem",
      }),
    );
    expect(decrypt().status).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("saves only an encrypted exact fresh-state plan under verified normal role and image provenance", () => {
  const dir = mkdtempSync(join(tmpdir(), "fss-plan-command-"));
  try {
    const checkout = join(dir, "checkout");
    mkdirSync(checkout);
    cpSync(resolve("infra"), join(checkout, "infra"), {
      recursive: true,
      filter: (path) => !path.split("/").includes(".terraform"),
    });
    mkdirSync(join(checkout, "packages/domain/db"), { recursive: true });
    for (const file of ["schemaRange.ts", "migrationRunner.ts", "queryable.ts"])
      cpSync(
        resolve("packages/domain/db", file),
        join(checkout, "packages/domain/db", file),
      );
    const fixtureScript = join(checkout, "infra/scripts/diagnostic-plan.mjs");
    const root = join(checkout, "infra/roots/rehearsal");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const commit = spawnSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).stdout.trim();
    const artifact = {
      schema: "fss.image-digests.v1",
      commit,
      workflowRunId: "111",
      images: {
        api: {
          repository: "fss-rh-api",
          tag: `ci-${commit}`,
          digest: `sha256:${"1".repeat(64)}`,
          schemaRange: { minimum: 90, maximum: 90 },
        },
        worker: {
          repository: "fss-rh-worker",
          tag: `ci-${commit}`,
          digest: `sha256:${"2".repeat(64)}`,
          schemaRange: { minimum: 90, maximum: 90 },
        },
      },
    };
    const fixture = join(dir, "images.json");
    writeFileSync(fixture, JSON.stringify(artifact));
    const log = join(dir, "calls");
    const stubs: Record<string, string> = {
      gh: String.raw`#!/usr/bin/env python3
import sys,json,os,shutil
a=sys.argv[1:]
if a[:2]==['run','download']:
 d=a[a.index('--dir')+1];shutil.copyfile(os.environ['FIXTURE_IMAGES'],d+'/image-digests.json')
else:
 path='greenfield-images.yml' if 'greenfield-images.yml' in ' '.join(a) else 'greenfield.yml'
 print(json.dumps({'workflow_runs':[] if os.environ.get('PROVENANCE_FAIL')=='1' else [{'id':111 if path=='greenfield-images.yml' else 222,'path':'.github/workflows/'+path,'head_sha':os.environ['GITHUB_SHA'],'head_branch':'main','event':'push','status':'completed','conclusion':'success'}]}))
`,
      aws: String.raw`#!/usr/bin/env python3
import sys,json,os,base64,shutil,hashlib
def objectfile(key):
 return os.environ['OBJECT_STORE'] if '/diagnostic/plans/' in key else os.environ['OBJECT_STORE']+'.'+hashlib.sha256(key.encode()).hexdigest()
a=sys.argv[1:];open(os.environ['CALLS'],'a').write('aws '+ ' '.join(a)+'\n')
if a[:2]==['sts','get-caller-identity']:print(json.dumps({'Account':'326255650484','Arn':os.environ.get('IDENTITY_ARN','arn:aws:sts::326255650484:assumed-role/fss-rh-deploy/test')}))
elif a[:2]==['acm','describe-certificate']:print(json.dumps({'Certificate':{'Status':os.environ.get('CERTIFICATE_STATUS','ISSUED'),'SubjectAlternativeNames':['*.rehearsal.usecallie.com']}}))
elif a[:2]==['ecr','describe-repositories']:print(json.dumps({'repositories':[{'imageTagMutability':'IMMUTABLE'}]}))
elif a[:2]==['ecr','describe-images']:print(json.dumps({'imageDetails':[{'imageDigest':('sha256:'+'3'*64) if os.environ.get('ECR_TAG_DRIFT')=='1' else ('sha256:'+('1' if 'fss-rh-api' in a else '2')*64)}]}))
elif a[:2]==['ecr','get-login-password']:print('fixture-ephemeral-auth')
elif a[:2]==['kms','generate-data-key'] or a[:2]==['kms','decrypt']:print(json.dumps({'KeyId':a[a.index('--key-id')+1],'Plaintext':base64.b64encode(bytes([7])*32).decode(),'CiphertextBlob':base64.b64encode(b'opaque-key').decode()}))
elif a[:2]==['s3api','list-objects-v2']:print(json.dumps({'Contents':[{'Key':a[a.index('--prefix')+1]}] if os.path.exists(objectfile(a[a.index('--prefix')+1])) else []}))
elif a[:2]==['s3api','put-object']:
 if os.path.exists(objectfile(a[a.index('--key')+1])):sys.exit(1)
 shutil.copyfile(a[a.index('--body')+1],objectfile(a[a.index('--key')+1]));print('{}')
elif a[:2]==['s3api','get-object']:shutil.copyfile(objectfile(a[a.index('--key')+1]),a[a.index('--key')+2]);print('{}')
else:sys.exit(1)
`,
      docker: String.raw`#!/usr/bin/env python3
import sys,json,os
args=sys.argv[1:];open(os.environ['CALLS'],'a').write('docker '+ ' '.join(args)+'\n')
if args[0]=='login':sys.stdin.read()
elif args[:2]==['image','inspect']:
 reference=args[2];commit=os.environ['GITHUB_SHA'] if os.environ.get('IMAGE_SOURCE_DRIFT')!='1' else '0'*40
 print(json.dumps([{'Architecture':'arm64','RepoDigests':[reference],'Config':{'Labels':{'org.opencontainers.image.revision':commit},'Env':['FSS_BUILD_COMMIT='+commit]}}]))
elif args[0]!='pull':sys.exit(1)
`,
      git: String.raw`#!/usr/bin/env python3
import sys,os
args=sys.argv[1:]
if args and args[0]=='status':
 print(' M infra/modules/stack/main.tf' if os.environ.get('SOURCE_DIRTY')=='1' else '')
else:os.execv(os.environ['REAL_GIT'],['git','-C',os.environ['FIXTURE_GIT_CHECKOUT']]+args)
`,
      terraform: String.raw`#!/usr/bin/env python3
import sys,json,os,base64,shutil,hashlib
def objectfile(key):
 return os.environ['OBJECT_STORE'] if '/diagnostic/plans/' in key else os.environ['OBJECT_STORE']+'.'+hashlib.sha256(key.encode()).hexdigest()
a=sys.argv[1:];open(os.environ['CALLS'],'a').write('terraform '+ ' '.join(a)+'\n')
if a[0]=='state':
 print('No state file was found!',file=sys.stderr);sys.exit(1)
elif a[0]=='show' and len(a)==2:
 if os.environ.get('STATE_UNREADABLE')=='1':
  print('private-provider-sentinel',file=sys.stderr);sys.exit(1)
 if os.environ.get('STATE_APPEARS')=='1' and 'terraform plan' in open(os.environ['CALLS']).read():print(json.dumps({'format_version':'1.0','values':{'root_module':{'resources':[{'address':'existing-after-plan'}]}}}))
 elif os.environ.get('STATE_MALFORMED')=='1':print('{}')
 elif os.environ.get('STATE_NESTED')=='1':print(json.dumps({'format_version':'1.0','values':{'root_module':{'child_modules':[{'resources':[{'address':'module.nested.existing'}]}]}}}))
 elif os.environ.get('EXISTING_STATE'):print(json.dumps({'format_version':'1.0','values':{'root_module':{'resources':[{'address':os.environ['EXISTING_STATE']}]}}}))
 else:print(json.dumps({'format_version':'1.0'}))
elif a[0]=='plan' and os.environ.get('PLAN_FAIL')=='1':sys.exit(1)
elif a[0]=='plan':open(next(x.split('=',1)[1] for x in a if x.startswith('-out=')),'wb').write(b'private-plan-fixture')
elif a[0]=='show':
 v=json.load(open('run.auto.tfvars.json'))
 if os.environ.get('DRIFT_PLAN')=='1':v['api_hostname']='wrong.rehearsal.usecallie.com'
 print(json.dumps({'variables':{k:{'value':x} for k,x in v.items()},'resource_changes':[{'address':'module.stack.aws_example.test','change':{'actions':['create']}}]}))
elif a[0]=='version':print(json.dumps({'terraform_version':'1.15.8'}))
elif a[0]!='init':sys.exit(1)
`,
    };
    for (const [name, text] of Object.entries(stubs)) {
      writeFileSync(join(bin, name), text);
      chmodSync(join(bin, name), 0o755);
    }
    const cfg = join(dir, "config.json");
    writeFileSync(cfg, JSON.stringify(config));
    const out = join(dir, "out");
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env["PATH"]}`,
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: commit,
      GITHUB_REPOSITORY: "david-cui-bruno/founding-sales",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_RUN_ID: "333",
      GITHUB_RUN_ATTEMPT: "1",
      FSS_DIAGNOSTIC_RUN_SUFFIX: "cap90-o10a",
      FSS_DIAGNOSTIC_API_DIGEST: `sha256:${"1".repeat(64)}`,
      FSS_DIAGNOSTIC_WORKER_DIGEST: `sha256:${"2".repeat(64)}`,
      FSS_DIAGNOSTIC_CERTIFICATE_ARN:
        "arn:aws:acm:us-east-1:326255650484:certificate/11111111-2222-4333-8444-555555555555",
      FSS_DIAGNOSTIC_API_REPOSITORY:
        "326255650484.dkr.ecr.us-east-1.amazonaws.com/fss-rh-api",
      FSS_DIAGNOSTIC_WORKER_REPOSITORY:
        "326255650484.dkr.ecr.us-east-1.amazonaws.com/fss-rh-worker",
      FIXTURE_IMAGES: fixture,
      FIXTURE_GIT_CHECKOUT: resolve("."),
      REAL_GIT: spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim(),
      CALLS: log,
    };
    const run = spawnSync(
      process.execPath,
      ["--experimental-transform-types", fixtureScript, "plan", cfg, out, root],
      { encoding: "utf8", env },
    );
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).not.toContain("private-plan-fixture");
    const manifest = JSON.parse(
      readFileSync(join(out, "public", "manifest.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      commit,
      imageBuildCommit: commit,
      stateKey: "fss/greenfield/rehearsal/fss-rh-cap90-o10a/terraform.tfstate",
      activationAllowed: false,
    });
    expect(
      readFileSync(join(out, "encrypted", "plan.encrypted.json"), "utf8"),
    ).not.toContain("private-plan-fixture");
    const ordinaryPlanCalls = readFileSync(log, "utf8");
    const consumerScript = join(dir, "private-consumer.mjs");
    writeFileSync(consumerScript, `
      import { prepareDiagnosticPlan } from ${JSON.stringify(pathToFileURL(fixtureScript).href)};
      import { readFileSync, writeFileSync } from "node:fs";
      const [config, output, root, receipt] = process.argv.slice(2);
      await prepareDiagnosticPlan(config, output, root, { validatedConfigurationConsumer: async ({configuration}) => { if (process.env.CONFIGURATION_REFUSE === "1") throw new Error("configuration_approval_changed"); if (configuration.crm_acquisition_diagnostic.database_name !== "fss_diagnostic_cap90_o10a") throw new Error("wrong configuration"); }, privatePlanConsumer: async (proposal) => {
        if (readFileSync(proposal.planPath, "utf8") !== "private-plan-fixture") throw new Error("wrong bytes");
        writeFileSync(receipt, JSON.stringify({ planSha256: proposal.manifest.planSha256, configurationSha256: proposal.manifest.configurationSha256, databaseName: proposal.configuration.crm_acquisition_diagnostic.database_name }));
        if (process.env.CONSUMER_FAIL === "1") throw new Error("private-consumer-failure");
        if (process.env.CONSUMER_TAMPER === "plan") writeFileSync(proposal.planPath, "different private plan");
        if (process.env.CONSUMER_TAMPER === "manifest") writeFileSync(proposal.manifestPath, "{}");
      }});
    `);
    const privateOut = join(dir, "private-out"), receipt = join(dir, "private-receipt.json");
    const consumed = spawnSync(process.execPath, ["--experimental-transform-types", consumerScript, cfg, privateOut, root, receipt], { encoding: "utf8", env });
    expect(consumed.status, consumed.stdout + consumed.stderr).toBe(0);
    expect(JSON.parse(readFileSync(receipt, "utf8"))).toMatchObject({ databaseName: "fss_diagnostic_cap90_o10a", planSha256: "747b2af5bcdd6819c68611119dc67922ee873424fc2dadd944b2e92d4b7b0934" });
    expect(() => readFileSync(join(privateOut, "plan.tfplan"))).toThrow();
    const failedOut = join(dir, "private-failed-out");
    const failedConsumer = spawnSync(process.execPath, ["--experimental-transform-types", consumerScript, cfg, failedOut, root, receipt], { encoding: "utf8", env: { ...env, CONSUMER_FAIL: "1" } });
    expect(failedConsumer.status).toBe(1);
    expect(() => readFileSync(join(failedOut, "plan.tfplan"))).toThrow();
    for (const tamper of ["plan", "manifest"]) {
      const changedOut = join(dir, `changed-${tamper}`);
      const changed = spawnSync(process.execPath, ["--experimental-transform-types", consumerScript, cfg, changedOut, root, receipt], { encoding: "utf8", env: { ...env, CONSUMER_TAMPER: tamper } });
      expect(changed.status).toBe(1);
      expect(changed.stderr).toContain("plan_changed");
      expect(() => readFileSync(join(changedOut, "plan.tfplan"))).toThrow();
    }
    const storage = {
      schemaVersion: 1, purpose: "diagnostic_plan_storage", approvalId: "11111111-2222-4333-8444-555555555555",
      approvedAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() + 1800000).toISOString(),
      environmentId: config.environmentId, prefix: "fss-rh-cap90-o10a", databaseName: config.databaseName, apiHostname: config.apiHostname,
      state: { bucket: "callie-sourcing-tfstate-326255650484", key: "fss/greenfield/rehearsal/fss-rh-cap90-o10a/terraform.tfstate", kmsKeyArn: "arn:aws:kms:us-east-1:326255650484:key/a321a083-4058-4130-b060-b950e4aa1404" },
      sourceCommit: commit, imageBuildCommit: commit,
      images: { api: `sha256:${"1".repeat(64)}`, worker: `sha256:${"2".repeat(64)}` },
      configurationSha256: manifest.configurationSha256,
      retention: { acknowledged: true, approvalRef: "reviewed-operational-retention" },
    };
    const storagePath = join(dir, "storage-approval.json"), store = join(dir, "private-store.json"), preparedOut = join(dir, "prepared-out");
    const storageBytes = JSON.stringify(storage);
    writeFileSync(storagePath, storageBytes);
    const handoffScript = join(checkout, "infra/scripts/diagnostic-handoff.mjs");
    const prepared = spawnSync(process.execPath, ["--experimental-transform-types", handoffScript, "prepare", storagePath, createHash("sha256").update(storageBytes).digest("hex"), cfg, preparedOut, root], { encoding: "utf8", env: { ...env, OBJECT_STORE: store } });
    expect(prepared.status, prepared.stdout + prepared.stderr).toBe(0);
    const storedReceipt = JSON.parse(readFileSync(join(preparedOut, "escrow", "escrow-receipt.json"), "utf8"));
    expect(storedReceipt).toMatchObject({ applyPerformed: false, planSha256: "747b2af5bcdd6819c68611119dc67922ee873424fc2dadd944b2e92d4b7b0934", retentionErasureSupported: false });
    expect(readFileSync(store, "utf8")).not.toContain("private-plan-fixture");
    expect(prepared.stdout + prepared.stderr).not.toContain("opaque-key");
    expect(() => readFileSync(join(preparedOut, "plan.tfplan"))).toThrow();
    expect(() => readFileSync(join(preparedOut, "configuration.private.json"))).toThrow();
    const refusedPreparation = spawnSync(process.execPath, ["--experimental-transform-types", handoffScript, "prepare", storagePath, createHash("sha256").update(storageBytes).digest("hex"), cfg, join(dir, "state-refused-preparation"), root], { encoding: "utf8", env: { ...env, OBJECT_STORE: join(dir, "refused-store.json"), STATE_UNREADABLE: "1" } });
    expect(refusedPreparation.status).toBe(1);
    expect(refusedPreparation.stderr).toContain("command_failed_terraform_show");
    expect(refusedPreparation.stdout + refusedPreparation.stderr).not.toContain("private-provider-sentinel");
    const successCalls = ordinaryPlanCalls;
    writeFileSync(log, "");
    const refusedConfiguration = spawnSync(process.execPath, ["--experimental-transform-types", consumerScript, cfg, join(dir, "config-refused"), root, receipt], { encoding: "utf8", env: { ...env, CONFIGURATION_REFUSE: "1" } });
    expect(refusedConfiguration.status).toBe(1);
    expect(refusedConfiguration.stderr).toContain("configuration_approval_changed");
    expect(readFileSync(log, "utf8")).toBe("");

    writeFileSync(log, "");
    const copiedRoot = join(dir, "copied-root");
    mkdirSync(copiedRoot);
    writeFileSync(join(copiedRoot, "evil.tf.json"), "{}");
    const copied = spawnSync(
      process.execPath,
      [
        "--experimental-transform-types",
        fixtureScript,
        "plan",
        cfg,
        join(dir, "copied-out"),
        copiedRoot,
      ],
      { encoding: "utf8", env },
    );
    expect(copied.status).toBe(1);
    expect(copied.stdout + copied.stderr).toContain("root_changed");
    expect(readFileSync(log, "utf8")).toBe("");
    const calls = successCalls;
    expect(calls).toContain("terraform plan");
    expect(calls).not.toMatch(/apply|destroy|secret-value|send|gmail/);
    for (const failure of [
      { EXISTING_STATE: "module.stack.aws_db_instance.existing" },
      { IDENTITY_ARN: "arn:aws:iam::326255650484:user/admin" },
      { CERTIFICATE_STATUS: "PENDING_VALIDATION" },
      { PLAN_FAIL: "1" },
      { DRIFT_PLAN: "1" },
      { ECR_TAG_DRIFT: "1" },
      { IMAGE_SOURCE_DRIFT: "1" },
      { SOURCE_DIRTY: "1" },
      { STATE_UNREADABLE: "1" },
      { STATE_MALFORMED: "1" },
      { STATE_NESTED: "1" },
      { STATE_APPEARS: "1" },
      { PROVENANCE_FAIL: "1" },
      { FSS_DIAGNOSTIC_API_DIGEST: `sha256:${"3".repeat(64)}` },
    ]) {
      writeFileSync(log, "");
      const refused = spawnSync(
        process.execPath,
        [
          "--experimental-transform-types",
          fixtureScript,
          "plan",
          cfg,
          join(dir, `refused-${Math.random()}`),
          root,
        ],
        { encoding: "utf8", env: { ...env, ...failure } },
      );
      expect(refused.status, refused.stdout + refused.stderr).toBe(1);
      expect(refused.stdout + refused.stderr).not.toContain(
        "private-plan-fixture",
      );
      expect(refused.stdout + refused.stderr).not.toContain(
        "private-provider-sentinel",
      );
      const refusedCalls = readFileSync(log, "utf8");
      expect(refusedCalls).not.toMatch(/apply|destroy|secret-value/);
      if ("STATE_APPEARS" in failure) expect(refused.stderr).toContain("state_changed");
      if (!("PLAN_FAIL" in failure) && !("DRIFT_PLAN" in failure) && !("STATE_APPEARS" in failure))
        expect(refusedCalls).not.toContain("terraform plan");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each([
  { environmentId: "no" },
  { databaseName: "fss" },
  { apiHostname: "api.usecallie.com" },
  { recipientPublicKeySha256: "0".repeat(64) },
  { recipientPublicKeyPem: "-----BEGIN PRIVATE KEY-----" },
  { recipientPublicKeyPem: publicKey + "\nextra public text" },
  { extra: true },
])(
  "refuses malformed or unreviewed configuration before cloud access: %j",
  (change) => {
    expect(runConfig(change).status).toBe(1);
  },
);
it("keeps the diagnostic dispatch separate from every mutation and raw artifact path", () => {
  const workflow = readFileSync(
    resolve(".github/workflows/greenfield-release.yml"),
    "utf8",
  );
  expect(workflow).toContain("diagnostic_plan:");
  const job = workflow.slice(workflow.indexOf("  diagnostic_plan:"));
  expect(job).toContain("environment: rehearsal");
  expect(job).toContain("actions: read");
  expect(job).not.toMatch(
    /terraform apply|terraform destroy|rehearsal.sh teardown|put-secret-value|get-secret-value|deploy.sh/,
  );
  expect(job).toContain("/encrypted/plan.encrypted.json");
  expect(job).toContain("retention-days: 1");
  expect(job).not.toMatch(/path:.*(?:tfplan|validated|tfvars|plan.json)/);
});

it("exposes private proposal preparation without executing commands on import", () => {
  const run = spawnSync(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e",
    `const module = await import(${JSON.stringify(pathToFileURL(script).href)}); if (typeof module.prepareDiagnosticPlan !== "function") throw new Error("missing public preparation API"); console.log("ready");`
  ], { encoding: "utf8" });
  expect(run.status, run.stdout + run.stderr).toBe(0);
  expect(run.stdout.trim()).toBe("ready");
  expect(run.stderr).not.toContain("diagnostic plan refused");
});
