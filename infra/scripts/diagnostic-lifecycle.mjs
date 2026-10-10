#!/usr/bin/env node
/** Default-off isolated lifecycle. Private Google inputs are supplied on stdin. */
import {
  readFileSync,
  writeFileSync,
  realpathSync,
  readdirSync,
  mkdirSync,
  lstatSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  parseLease,
  loadReviewedPlan,
  registerLifecycleLease,
  loadReviewedConfigurationForCleanup,
  loadRegisteredLifecycleLeaseForCleanup,
} from "./diagnostic-handoff.mjs";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const root = realpathSync(resolve(repository, "infra/roots/rehearsal"));
const sha = (value) => createHash("sha256").update(value).digest("hex");
let uncertainStage = null;
let activeLease = null;
let mutationDeadline = null;
function command(
  program,
  args,
  cwd = root,
  timeout = 60000,
  input,
  additions = {},
) {
  if (
    activeLease &&
    ((program === "terraform" && ["init", "apply"].includes(args[0])) ||
      (program === "aws" &&
        args[0] === "secretsmanager" &&
        args[1] === "put-secret-value") ||
      (program === "bash" && args[1] === "release") ||
      (program === "bash" && args[1] === "bootstrap") ||
      (program === "bash" && args[0]?.endsWith("/record.sh")))
  )
    sourceBinding(activeLease);
  if (mutationDeadline !== null) {
    const remaining = mutationDeadline - Date.now();
    if (remaining <= 0) throw new Error("cleanup_due");
    timeout = Math.min(timeout, remaining);
  }
  if (program === "aws" && !args.includes("--region"))
    args = [...args, "--region", "us-east-1"];
  try {
    return execFileSync(program, args, {
      cwd,
      encoding: "utf8",
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      input,
      env: { ...process.env, ...additions },
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
  } catch {
    throw new Error("external_operation_refused_or_uncertain");
  }
}
function sourceBinding(lease) {
  if (
    realpathSync(root) !== root ||
    Object.keys(process.env).some(
      (name) =>
        name.startsWith("TF_CLI_ARGS") ||
        name.startsWith("TF_VAR_") ||
        name === "TF_WORKSPACE",
    )
  )
    throw new Error("source_binding_changed");
  const allowed = new Set([
    "main.tf",
    "variables.tf",
    "providers.tf",
    "versions.tf",
    "outputs.tf",
    "backend.hcl",
    ".terraform.lock.hcl",
    "run.auto.tfvars.json",
  ]);
  for (const entry of readdirSync(root, { withFileTypes: true }))
    if (
      entry.isSymbolicLink() ||
      (!entry.isDirectory() &&
        /(?:\.tf(?:\.json)?|\.hcl|\.tfvars(?:\.json)?)$/u.test(entry.name) &&
        !allowed.has(entry.name))
    )
      throw new Error("source_binding_changed");
  if (
    command("git", ["rev-parse", "HEAD"], repository).trim() !==
      lease.sourceCommit ||
    command(
      "git",
      [
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        "infra",
        ".github/workflows",
      ],
      repository,
    ).trim() !== ""
  )
    throw new Error("source_binding_changed");
}
function requireEmptyState(nonemptyCode = "nonempty_state") {
  // A fresh backend has no state file: state list exits1, while show succeeds.
  // Only a successful structured read establishes that no resources exist.
  const state = JSON.parse(command("terraform", ["show", "-json"]));
  const object = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (!object(state) || state.format_version !== "1.0" ||
      (state.values !== undefined && !object(state.values)))
    throw new Error("invalid_state_read");
  function inspect(module) {
    if (!object(module) ||
        (module.resources !== undefined && !Array.isArray(module.resources)) ||
        (module.child_modules !== undefined && !Array.isArray(module.child_modules)))
      throw new Error("invalid_state_read");
    if (module.resources?.length) throw new Error(nonemptyCode);
    for (const child of module.child_modules ?? []) inspect(child);
  }
  if (state.values?.root_module !== undefined) inspect(state.values.root_module);
}
// Closed application boundary: these pinned infrastructure types have no local
// file inputs. A new type needs an explicit artifact review before it can apply.
const fileFreeManagedTypes = new Set([
  'aws_cloudfront_distribution',
  'aws_cloudfront_origin_access_control',
  'aws_cloudwatch_composite_alarm',
  'aws_cloudwatch_log_group',
  'aws_cloudwatch_log_metric_filter',
  'aws_cloudwatch_metric_alarm',
  'aws_db_instance',
  'aws_db_parameter_group',
  'aws_db_subnet_group',
  'aws_default_security_group',
  'aws_ecr_lifecycle_policy',
  'aws_ecr_repository',
  'aws_ecs_cluster',
  'aws_ecs_cluster_capacity_providers',
  'aws_ecs_service',
  'aws_ecs_task_definition',
  'aws_iam_role',
  'aws_iam_role_policy',
  'aws_iam_role_policy_attachment',
  'aws_internet_gateway',
  'aws_kms_alias',
  'aws_kms_key',
  'aws_lb',
  'aws_lb_listener',
  'aws_lb_target_group',
  'aws_route',
  'aws_route_table',
  'aws_route_table_association',
  'aws_s3_bucket',
  'aws_s3_bucket_lifecycle_configuration',
  'aws_s3_bucket_object_lock_configuration',
  'aws_s3_bucket_ownership_controls',
  'aws_s3_bucket_policy',
  'aws_s3_bucket_public_access_block',
  'aws_s3_bucket_server_side_encryption_configuration',
  'aws_s3_bucket_versioning',
  'aws_scheduler_schedule',
  'aws_secretsmanager_secret',
  'aws_security_group',
  'aws_sns_topic',
  'aws_sns_topic_policy',
  'aws_sns_topic_subscription',
  'aws_subnet',
  'aws_vpc',
  'aws_vpc_security_group_egress_rule',
  'aws_vpc_security_group_ingress_rule',
  'terraform_data',
]);
function requireSupportedArtifacts(plan) {
  if (!Array.isArray(plan.resource_changes)) throw new Error("local_artifact_binding_changed");
  for (const change of plan.resource_changes) {
    if (change.mode !== "managed") continue;
    if (change.type === "aws_lambda_function") continue; // Exact binding checked below.
    if (!fileFreeManagedTypes.has(change.type) ||
        [change.change?.after, change.change?.after_unknown].some(values =>
          values && ["filename", "source"].some(key => Object.hasOwn(values, key))))
      throw new Error("local_artifact_unsupported");
  }
}
function restoreReviewedArtifact(reviewed, lease) {
  if (!Buffer.isBuffer(reviewed.alarmDigestArchive)) throw new Error("local_artifact_missing");
  const plan = JSON.parse(command("terraform", ["show", "-json", reviewed.privatePlanPath]));
  requireSupportedArtifacts(plan);
  const lambdas = Array.isArray(plan.resource_changes) ? plan.resource_changes.filter((change) => change.mode === "managed" && change.type === "aws_lambda_function") : [];
  const filename = `./.terraform/alarm-digest/${lease.prefix}.zip`;
  if (!Array.isArray(lambdas) || lambdas.length !== 1 ||
      lambdas[0].address !== "module.stack.module.alerts.aws_lambda_function.digest" ||
      lambdas[0].change?.after?.filename !== filename ||
      lambdas[0].change?.after?.source_code_hash !== createHash("sha256").update(reviewed.alarmDigestArchive).digest("base64"))
    throw new Error("local_artifact_binding_changed");
  const directory = resolve(root, ".terraform/alarm-digest");
  mkdirSync(directory, {recursive:true, mode:0o700});
  if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory)
    throw new Error("local_artifact_binding_changed");
  const path = resolve(directory, `${lease.prefix}.zip`);
  writeFileSync(path, reviewed.alarmDigestArchive, {mode:0o600, flag:"wx"});
  return path;
}
function requireUnchangedArtifact(path, expected) {
  try {
    if (!lstatSync(path).isFile() || realpathSync(path) !== path || !readFileSync(path).equals(expected))
      throw new Error("changed");
  } catch {throw new Error("local_artifact_binding_changed");}
}

function applyReviewedPlan(leasePath, expectedHash, directory, lease) {
  sourceBinding(lease);
  const reviewed = loadReviewedPlan({
    leasePath,
    expectedLeaseSha256: expectedHash,
    outDirectory: resolve(directory, "plan"),
  });
  try {
    if (
      reviewed.manifest.providerLockSha256 !==
        sha(readFileSync(resolve(root, ".terraform.lock.hcl"))) ||
      JSON.parse(command("terraform", ["version", "-json"]))
        .terraform_version !== "1.15.8" ||
      sha(readFileSync(reviewed.privatePlanPath)) !== lease.planSha256
    )
      throw new Error("source_binding_changed");
    sourceBinding(lease);
    writeFileSync(
      resolve(root, "run.auto.tfvars.json"),
      JSON.stringify(reviewed.configuration),
      { mode: 0o600 },
    );
    command(
      "terraform",
      [
        "init",
        "-reconfigure",
        "-input=false",
        "-lockfile=readonly",
        "-backend-config=backend.hcl",
        `-backend-config=key=${lease.state.key}`,
      ],
      root,
      300000,
    );
    const artifactPath = restoreReviewedArtifact(reviewed, lease);
    requireEmptyState();
    registerLifecycleLease({
      leasePath,
      expectedLeaseSha256: expectedHash,
      outDirectory: resolve(directory, "registration"),
    });
    if (Date.now() >= Date.parse(lease.startDeadline))
      throw new Error("application_preflight_changed");
    requireEmptyState("application_preflight_changed");
    requireUnchangedArtifact(artifactPath, reviewed.alarmDigestArchive);
    uncertainStage = "application";
    mutationDeadline = Date.parse(lease.cleanupAt);
    command(
      "terraform",
      ["apply", "-input=false", reviewed.privatePlanPath],
      root,
      2100000,
    );
    writeFileSync(
      resolve(directory, "applied-receipt.json"),
      JSON.stringify({
        leaseSha256: expectedHash,
        sourceCommit: lease.sourceCommit,
        runId: process.env.GITHUB_RUN_ID,
        attempt: process.env.GITHUB_RUN_ATTEMPT,
      }),
      { mode: 0o600, flag: "wx" },
    );
    return {
      ok: true,
      stage: "applied",
      applyPerformed: true,
      activationAllowed: false,
    };
  } finally {
    rmSync(reviewed.privatePlanPath, { force: true });
  }
}

function ownedConfiguration(
  leasePath,
  expectedHash,
  directory,
  lease,
  sameOrigin,
) {
  sourceBinding(lease);
  const reviewed = loadReviewedConfigurationForCleanup({
    leasePath,
    expectedLeaseSha256: expectedHash,
    outDirectory: resolve(directory, "owned"),
  });
  if (
    sameOrigin &&
    (reviewed.execution?.runId !== process.env.GITHUB_RUN_ID ||
      reviewed.execution?.attempt !== process.env.GITHUB_RUN_ATTEMPT)
  )
    throw new Error("lifecycle_run_changed");
  if (
    reviewed.manifest.providerLockSha256 !==
    sha(readFileSync(resolve(root, ".terraform.lock.hcl")))
  )
    throw new Error("source_binding_changed");
  sourceBinding(lease);
  writeFileSync(
    resolve(root, "run.auto.tfvars.json"),
    JSON.stringify(reviewed.configuration),
    { mode: 0o600 },
  );
  command(
    "terraform",
    [
      "init",
      "-reconfigure",
      "-input=false",
      "-lockfile=readonly",
      "-backend-config=backend.hcl",
      `-backend-config=key=${lease.state.key}`,
    ],
    root,
    300000,
  );
  return reviewed;
}
function cleanup(leasePath, expectedHash, directory, lease) {
  uncertainStage = "cleanup";
  ownedConfiguration(leasePath, expectedHash, directory, lease, false);
  const environment = {
    FSS_REHEARSAL_ROOT: root,
    FSS_REHEARSAL_STATE_BUCKET: lease.state.bucket,
    FSS_REHEARSAL_STATE_KEY: lease.state.key,
  };
  command(
    "bash",
    [
      resolve(repository, "infra/scripts/rehearsal.sh"),
      "teardown",
      lease.prefix,
    ],
    root,
    3300000,
    undefined,
    environment,
  );
  command(
    "bash",
    [resolve(repository, "infra/scripts/rehearsal.sh"), "guard", lease.prefix],
    root,
    300000,
    undefined,
    environment,
  );
  return {
    ok: true,
    stage: "cleaned",
    absenceVerified: true,
    activationAllowed: false,
    retentionErasureSupported: false,
  };
}
function assertApplied(directory, expectedHash, lease) {
  const receipt = JSON.parse(
    readFileSync(resolve(directory, "applied-receipt.json"), "utf8"),
  );
  if (
    receipt.leaseSha256 !== expectedHash ||
    receipt.sourceCommit !== lease.sourceCommit ||
    receipt.runId !== process.env.GITHUB_RUN_ID ||
    receipt.attempt !== process.env.GITHUB_RUN_ATTEMPT
  )
    throw new Error("application_receipt_changed");
}
function prepareReleaseRecord(directory, lease, environment) {
  const selectRun = (workflow) => {
    const listed = JSON.parse(command("gh", ["api", `repos/david-cui-bruno/founding-sales/actions/workflows/${workflow}/runs?head_sha=${lease.imageBuildCommit}&event=push&branch=main&per_page=100`]));
    if (!Array.isArray(listed.workflow_runs)) throw new Error("release_provenance_unavailable");
    const candidates = listed.workflow_runs.filter(run =>
      run.head_sha === lease.imageBuildCommit && run.event === "push" && run.head_branch === "main" &&
      run.path === `.github/workflows/${workflow}` && run.head_repository?.full_name === "david-cui-bruno/founding-sales" &&
      run.status === "completed" && run.conclusion === "success" && /^[1-9][0-9]*$/u.test(String(run.id)));
    candidates.sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)) || (BigInt(b.id)>BigInt(a.id)?1:-1));
    if (!candidates.length) throw new Error("release_provenance_unavailable");
    return String(candidates[0].id);
  };
  const gateRunId=selectRun("greenfield.yml"), imagesRunId=selectRun("greenfield-images.yml");
  const recordPath=resolve(directory,"preparation","release-record.private.json");
  if (lstatExists(recordPath)) throw new Error("release_record_destination_exists");
  command("bash",[resolve(repository,"infra/scripts/record.sh"),"from-ci",gateRunId,lease.imageBuildCommit,lease.images.api,lease.images.worker,"--images-run",imagesRunId,"--out",recordPath],root,180000,undefined,environment);
  const recordStat=lstatSync(recordPath);
  if (!recordStat.isFile() || recordStat.isSymbolicLink()) throw new Error("release_record_binding_changed");
  chmodSync(recordPath,0o600);
  const raw=readFileSync(recordPath), record=JSON.parse(raw);
  if (record.schema!=="fss.release-record.v1" || record.source!=="ci-gate" || record.suite!=="pass" || record.commit!==lease.imageBuildCommit || record.gateRunId!==gateRunId || record.imagesRunId!==imagesRunId || record.enablesSending!==false || record.artifacts?.api!==lease.images.api || record.artifacts?.worker!==lease.images.worker || record.artifacts?.desktopCommitStamp!==lease.imageBuildCommit || record.releaseGateReference!==`ci-gate-${gateRunId}-${lease.imageBuildCommit.slice(0,12)}`)
    throw new Error("release_record_binding_changed");
  return {path:recordPath,sha256:sha(raw),reference:record.releaseGateReference,gateRunId,imagesRunId,enablesSending:false};
}
function lstatExists(path) {try {lstatSync(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
function verifyPreparedReleaseRecord(directory, receipt, lease) {
  const record=receipt.releaseRecord;
  if (!record || record.readBackVerified!==true || record.enablesSending!==false || record.path!==resolve(directory,"preparation","release-record.private.json") || sha(readFileSync(record.path))!==record.sha256)
    throw new Error("release_record_binding_changed");
  const current=JSON.parse(readFileSync(record.path));
  if(current.commit!==lease.imageBuildCommit || current.enablesSending!==false || current.artifacts?.api!==lease.images.api || current.artifacts?.worker!==lease.images.worker || current.releaseGateReference!==record.reference)
    throw new Error("release_record_binding_changed");
}
function readBootstrapBindings(directory, lease) {
  const path=resolve(directory,"reports","bootstrap-workspace.json"), stat=lstatSync(path);
  if(!stat.isFile() || stat.isSymbolicLink() || stat.size>16384) throw new Error("bootstrap_bindings_unavailable");
  const raw=readFileSync(path), report=JSON.parse(raw);
  const keys=(value,names)=>value!==null && typeof value==='object' && !Array.isArray(value) && Object.keys(value).sort().join()===names.sort().join();
  const uuid=value=>typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
  if(!keys(report,['workspace','admin','membership','sendingDomain']) || !keys(report.workspace,['id','slug','displayName','businessTimeZone','outcome']) || !keys(report.admin,['userId','email','outcome']) || !keys(report.membership,['role','outcome']) ||
    !uuid(report.workspace.id) || !uuid(report.admin.userId) || report.workspace.slug!==`diagnostic-${lease.prefix.slice(7)}` || report.workspace.displayName!==`Acquisition diagnostic ${lease.prefix}` || typeof report.workspace.businessTimeZone!=='string' || !['created','existing'].includes(report.workspace.outcome) || report.admin.email!==lease.bootstrapAdminEmail.toLowerCase() || !['provisional_created','provisional_existing','adopted_user'].includes(report.admin.outcome) || report.membership.role!=='admin' || !['created','existing','reactivated'].includes(report.membership.outcome) || report.sendingDomain!==null)
    throw new Error("bootstrap_bindings_unavailable");
  return {workspaceId:report.workspace.id,ownerUserId:report.admin.userId,bootstrapReportSha256:sha(raw)};
}
function prepare(leasePath, expectedHash, directory, lease, inputs) {
  assertApplied(directory, expectedHash, lease);
  uncertainStage = "preparation";
  if (Date.now() >= Date.parse(lease.cleanupAt)) throw new Error("cleanup_due");
  mutationDeadline = Date.parse(lease.cleanupAt);
  ownedConfiguration(
    leasePath,
    expectedHash,
    resolve(directory, "preparation"),
    lease,
    true,
  );
  const outputs = JSON.parse(command("terraform", ["output", "-json"]));
  const value = (name) => outputs[name]?.value;
  const diagnostic = value("crm_acquisition_diagnostic");
  if (
    value("environment") !== "rehearsal" ||
    value("destroyable") !== true ||
    value("name_prefix") !== lease.prefix ||
    value("database_name") !== lease.databaseName ||
    diagnostic?.environment_id !== lease.environmentId ||
    diagnostic.database_name !== lease.databaseName ||
    diagnostic.tags?.CalliePurpose !== "acquisition_acceptance" ||
    diagnostic.tags?.CallieDiagnosticEnvironment !== lease.environmentId
  )
    throw new Error("applied_outputs_changed");
  const secretArn = (name) => {
    const arn = value(name);
    if (
      typeof arn !== "string" ||
      !arn.startsWith(
        `arn:aws:secretsmanager:us-east-1:326255650484:secret:${lease.prefix}/`,
      )
    )
      throw new Error("applied_outputs_changed");
    return arn;
  };
  const migrationArn = secretArn("migration_database_secret_arn"),
    runtimeArn = secretArn("app_runtime_database_secret_arn");
  const masterArn = value("database_master_secret_arn"),
    endpoint = value("database_endpoint");
  if (
    typeof masterArn !== "string" ||
    !/^arn:aws:secretsmanager:us-east-1:326255650484:secret:rds!db-[A-Za-z0-9-]+$/u.test(
      masterArn,
    ) ||
    typeof endpoint !== "string" ||
    !/^[-a-z0-9.]+\.rds\.amazonaws\.com:5432$/u.test(endpoint)
  )
    throw new Error("applied_outputs_changed");
  const secretNames = value("secret_names");
  const names = secretNames && typeof secretNames === "object" && !Array.isArray(secretNames)
    ? Object.keys(secretNames) : [];
  const expected = [
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
  ];
  if (
    names.length !== expected.length ||
    [...names].sort().join() !== expected.sort().join() ||
    names.some(name => secretNames[name] !== `${lease.prefix}/${name}`)
  )
    throw new Error("applied_outputs_changed");
  const instanceArn = `arn:aws:rds:us-east-1:326255650484:db:${lease.prefix}-pg`;
  const instances = JSON.parse(
    command("aws", [
      "rds",
      "describe-db-instances",
      "--db-instance-identifier",
      `${lease.prefix}-pg`,
    ]),
  ).DBInstances;
  const instance = instances?.[0];
  if (
    !Array.isArray(instances) ||
    instances.length !== 1 ||
    instance.DBInstanceIdentifier !== `${lease.prefix}-pg` ||
    instance.DBInstanceArn !== instanceArn ||
    instance.DBName !== lease.databaseName ||
    instance.Endpoint?.Address !== endpoint.split(":")[0] ||
    instance.Endpoint?.Port !== 5432 ||
    instance.MasterUserSecret?.SecretArn !== masterArn
  )
    throw new Error("applied_outputs_changed");
  const tagList = JSON.parse(
    command("aws", [
      "rds",
      "list-tags-for-resource",
      "--resource-name",
      instanceArn,
    ]),
  ).TagList;
  if (!Array.isArray(tagList)) throw new Error("applied_outputs_changed");
  const tags = Object.fromEntries(tagList.map((tag) => [tag.Key, tag.Value]));
  if (
    tags.Environment !== "rehearsal" ||
    tags.NamePrefix !== lease.prefix ||
    tags.CalliePurpose !== "acquisition_acceptance" ||
    tags.CallieDiagnosticEnvironment !== lease.environmentId ||
    new Set(tagList.map((tag) => tag.Key)).size !== tagList.length
  )
    throw new Error("applied_outputs_changed");
  const environment = { FSS_REHEARSAL_REPORTS: resolve(directory, "reports") };
  const releaseRecord = prepareReleaseRecord(directory, lease, environment);
  const master = JSON.parse(
    JSON.parse(
      command("aws", [
        "secretsmanager",
        "get-secret-value",
        "--secret-id",
        masterArn,
        "--output",
        "json",
      ]),
    ).SecretString,
  );
  if (
    typeof master.username !== "string" ||
    typeof master.password !== "string" ||
    !master.username ||
    !master.password
  )
    throw new Error("private_database_inputs_invalid");
  const base = {
    host: endpoint.split(":")[0],
    port: 5432,
    dbname: lease.databaseName,
  };
  const values = {
    "migration-database": JSON.stringify({
      ...base,
      username: master.username,
      password: master.password,
    }),
    "app-runtime-database": JSON.stringify({
      ...base,
      username: "app_runtime_login",
      password: randomBytes(48).toString("base64"),
    }),
    "google-oidc-client": JSON.stringify(inputs.oidc),
    "google-gmail-oauth-client": JSON.stringify(inputs.gmail),
    "session-signing-key": randomBytes(48).toString("base64"),
    "device-credential-pepper": randomBytes(48).toString("base64"),
    "sourcing-search": "unconfigured",
    "llm-classifier-api-key": "unconfigured",
    "twilio-voice": "{}",
    calcom: "{}",
    transcription: "{}",
    "zoom-meetings": "{}",
  };
  for (const name of names) {
    const file = resolve(directory, "preparation", `${name}.private.txt`);
    try {
      writeFileSync(file, values[name], { mode: 0o600, flag: "wx" });
      command("aws", [
        "secretsmanager",
        "put-secret-value",
        "--secret-id",
        name === "migration-database"
          ? migrationArn
          : name === "app-runtime-database"
            ? runtimeArn
            : secretNames[name],
        "--secret-string",
        `file://${file}`,
        "--output",
        "json",
      ]);
    } finally {
      rmSync(file, { force: true });
    }
  }
  command(
    "bash",
    [
      resolve(repository, "infra/scripts/deploy.sh"),
      "release",
      root,
      lease.prefix,
      "--schema-change",
      "--api-digest",
      lease.images.api,
      "--worker-digest",
      lease.images.worker,
    ],
    root,
    2100000,
    undefined,
    environment,
  );
  command(
    "bash",
    [
      resolve(repository, "infra/scripts/deploy.sh"),
      "bootstrap",
      root,
      lease.prefix,
      "--worker-digest",
      lease.images.worker,
      "--slug",
      `diagnostic-${lease.prefix.slice(7)}`,
      "--display-name",
      `Acquisition diagnostic ${lease.prefix}`,
      "--admin-email",
      lease.bootstrapAdminEmail,
    ],
    root,
    600000,
    undefined,
    environment,
  );
  const bootstrapBindings=readBootstrapBindings(directory,lease);
  // A fresh isolated database has no release table before migration. Store the authentic
  // CI record after its first migration/rollout, then require normal existing readback.
  for (const stage of ["put", "read-back"]) {
    if (sha(readFileSync(releaseRecord.path)) !== releaseRecord.sha256) throw new Error("release_record_binding_changed");
    command("bash",[resolve(repository,"infra/scripts/record.sh"),stage,root,lease.prefix,"--api-digest",lease.images.api,"--worker-digest",lease.images.worker,"--release-record",releaseRecord.path],root,600000,undefined,environment);
  }
  if (Date.now() >= Date.parse(lease.cleanupAt)) throw new Error("cleanup_due");
  writeFileSync(
    resolve(directory, "prepared-receipt.json"),
    JSON.stringify({
      leaseSha256: expectedHash,
      sourceCommit: lease.sourceCommit,
      imageBuildCommit: lease.imageBuildCommit,
      releaseRecord: {...releaseRecord,readBackVerified:true},
      bootstrapBindings,
      runId: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
    }),
    { mode: 0o600, flag: "wx" },
  );
  return {
    ok: true,
    stage: "prepared",
    activationAllowed: false,
    consentRequired: true,
    dnsVerified: false,
    workspaceId: bootstrapBindings.workspaceId,
    ownerUserId: bootstrapBindings.ownerUserId,
    releaseRecordReference: releaseRecord.reference,
    releaseRecordSha256: releaseRecord.sha256,
    gateRunId: releaseRecord.gateRunId,
    imagesRunId: releaseRecord.imagesRunId,
  };
}
async function hold(directory, expectedHash, lease) {
  assertApplied(directory, expectedHash, lease);
  const receipt = JSON.parse(
    readFileSync(resolve(directory, "prepared-receipt.json"), "utf8"),
  );
  if (
    receipt.leaseSha256 !== expectedHash ||
    receipt.sourceCommit !== lease.sourceCommit ||
    receipt.imageBuildCommit !== lease.imageBuildCommit ||
    receipt.runId !== process.env.GITHUB_RUN_ID ||
    receipt.attempt !== process.env.GITHUB_RUN_ATTEMPT
  )
    throw new Error("application_receipt_changed");
  if (
    process.env.GITHUB_REF !== "refs/heads/main" ||
    process.env.GITHUB_SHA !== lease.sourceCommit
  )
    throw new Error("lifecycle_run_changed");
  verifyPreparedReleaseRecord(directory, receipt, lease);
  if(JSON.stringify(readBootstrapBindings(directory,lease))!==JSON.stringify(receipt.bootstrapBindings)) throw new Error("bootstrap_bindings_unavailable");
  await new Promise((resolveWait) => {
    let timer;
    const interrupted = () => {
      clearTimeout(timer);
      console.log(
        JSON.stringify({
          ok: false,
          reason: "hold_interrupted",
          cleanupRequired: true,
          absenceVerified: false,
          fallbackOwner: lease.fallbackOwner,
          activationAllowed: false,
        }),
      );
      process.exit(1);
    };
    process.once("SIGTERM", interrupted);
    process.once("SIGINT", interrupted);
    const tick = () => {
      const remaining = Date.parse(lease.cleanupAt) - Date.now();
      if (remaining <= 0) {
        process.removeListener("SIGTERM", interrupted);
        process.removeListener("SIGINT", interrupted);
        resolveWait();
      } else timer = setTimeout(tick, Math.min(remaining, 60000));
    };
    tick();
  });
  return {
    ok: true,
    stage: "cleanup_due",
    cleanupRequired: true,
    absenceVerified: false,
    fallbackOwner: lease.fallbackOwner,
    activationAllowed: false,
  };
}

function privateGoogleInputs() {
  const text = readFileSync(0, "utf8");
  if (text.trim() === "") throw new Error("private_google_inputs_required");
  if (Buffer.byteLength(text) > 16384)
    throw new Error("private_google_inputs_invalid");
  try {
    const value = JSON.parse(text);
    if (Object.keys(value).sort().join() !== "gmail,oidc") throw new Error();
    for (const name of ["oidc", "gmail"]) {
      const client = value[name];
      if (
        Object.keys(client).sort().join() !==
          "client_id,client_secret,project_id,redirect_uris" ||
        typeof client.client_id !== "string" ||
        !/^[A-Za-z0-9_-]{1,180}\.apps\.googleusercontent\.com$/u.test(
          client.client_id,
        ) ||
        /rehearsal|fixture|placeholder|fake/iu.test(client.client_id) ||
        typeof client.client_secret !== "string" ||
        client.client_secret.length < 16 ||
        client.client_secret.length > 1024 ||
        typeof client.project_id !== "string" ||
        !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/u.test(client.project_id) ||
        !Array.isArray(client.redirect_uris) ||
        client.redirect_uris.length !== 1 ||
        typeof client.redirect_uris[0] !== "string" ||
        !client.redirect_uris[0].startsWith("https://")
      )
        throw new Error();
    }
    return value;
  } catch {
    throw new Error("private_google_inputs_invalid");
  }
}

try {
  const [stage, ...args] = process.argv.slice(2);
  if (
    Object.keys(process.env).some(
      (name) =>
        name.startsWith("FSS_RELEASE_") ||
        name.startsWith("FSS_REHEARSAL_") ||
        name.startsWith("AWS_ENDPOINT_URL") ||
        name === "TERRAFORM",
    )
  )
    throw new Error("operational_override_refused");
  if (stage === "backup-cleanup" && args.length === 4) {
    const [originRunId, originAttempt, originSourceCommit, directory] = args;
    const recovered = loadRegisteredLifecycleLeaseForCleanup({
      originRunId,
      originAttempt,
      originSourceCommit,
      outDirectory: resolve(directory, "recovery"),
    });
    activeLease = recovered.lease;
    console.log(
      JSON.stringify(
        cleanup(
          recovered.leasePath,
          recovered.leaseSha256,
          resolve(directory, "cleanup"),
          recovered.lease,
        ),
      ),
    );
    process.exit(0);
  }
  if (
    !["validate", "apply", "prepare", "hold", "cleanup"].includes(stage) ||
    args.length !== 3
  )
    throw new Error("invalid_command");
  const inputs = ["validate", "apply", "prepare"].includes(stage)
    ? privateGoogleInputs()
    : null;
  const [leasePath, expectedHash, directory] = args;
  const rawLease = readFileSync(leasePath);
  if (
    !/^[a-f0-9]{64}$/u.test(expectedHash) ||
    createHash("sha256").update(rawLease).digest("hex") !== expectedHash
  )
    throw new Error("lease_hash_changed");
  const lease = parseLease(JSON.parse(rawLease.toString("utf8")));
  activeLease = lease;
  if (
    inputs &&
    (inputs.oidc.client_id !== lease.google.oidcClientId ||
      inputs.gmail.client_id !== lease.google.gmailClientId ||
      inputs.oidc.project_id !== lease.google.projectId ||
      inputs.gmail.project_id !== lease.google.projectId ||
      inputs.oidc.redirect_uris[0] !== lease.google.redirectUris.oidc ||
      inputs.gmail.redirect_uris[0] !== lease.google.redirectUris.gmail)
  )
    throw new Error("private_google_client_mismatch");
  if (["validate", "apply", "prepare"].includes(stage)) {
    if (
      process.env.GITHUB_REF !== "refs/heads/main" ||
      process.env.GITHUB_SHA !== lease.sourceCommit
    )
      throw new Error("lifecycle_run_changed");
    if (
      stage !== "prepare" &&
      (Date.now() < Date.parse(lease.approvedAt) ||
        Date.now() >= Date.parse(lease.startDeadline))
    )
      throw new Error("lease_start_expired");
  }
  if (stage === "validate") {
    console.log(
      JSON.stringify({
        ok: true,
        stage: "validated",
        applyPerformed: false,
        activationAllowed: false,
      }),
    );
    process.exit(0);
  }
  if (stage === "apply") {
    console.log(
      JSON.stringify(
        applyReviewedPlan(leasePath, expectedHash, directory, lease),
      ),
    );
    process.exit(0);
  }
  if (stage === "cleanup") {
    console.log(
      JSON.stringify(cleanup(leasePath, expectedHash, directory, lease)),
    );
    process.exit(0);
  }
  if (stage === "prepare") {
    console.log(
      JSON.stringify(
        prepare(leasePath, expectedHash, directory, lease, inputs),
      ),
    );
    process.exit(0);
  }
  if (stage === "hold") {
    console.log(JSON.stringify(await hold(directory, expectedHash, lease)));
    process.exit(0);
  }
  throw new Error("lifecycle_not_configured");
} catch (error) {
  if (uncertainStage && activeLease) {
    console.log(
      JSON.stringify({
        ok: false,
        reason: `${uncertainStage}_unknown`,
        cleanupRequired: true,
        absenceVerified: false,
        fallbackOwner: activeLease.fallbackOwner,
        activationAllowed: false,
      }),
    );
    process.exit(1);
  }
  const reasons = [
    "invalid_command",
    "private_google_inputs_required",
    "private_google_inputs_invalid",
    "private_google_client_mismatch",
    "lease_hash_changed",
    "lifecycle_run_changed",
    "lease_start_expired",
    "lifecycle_not_configured",
    "source_binding_changed",
    "external_operation_refused_or_uncertain",
    "nonempty_state",
    "application_preflight_changed",
    "local_artifact_missing",
    "local_artifact_invalid",
    "local_artifact_unsupported",
    "local_artifact_binding_changed",
  ];
  console.log(
    JSON.stringify({
      ok: false,
      reason:
        error.message === "operational_override_refused"
          ? "operational_override_refused"
          : reasons.includes(error.message)
            ? error.message
            : "operation_refused_or_uncertain",
    }),
  );
  process.exitCode = 1;
}
