#!/usr/bin/env node
/** Closed protected operations; documentary lease/config reads never grant action authority. */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readRegisteredDiagnosticOperationEvidence,
  readDiagnosticOperationConfigurationEvidence,
} from "./diagnostic-handoff.mjs";
const repository = fileURLToPath(new URL("../..", import.meta.url)),
  root = realpathSync(resolve(repository, "infra/roots/rehearsal"));
const sha = (x) => createHash("sha256").update(x).digest("hex"),
  hash = /^[a-f0-9]{64}$/u,
  uuid =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
let deadline = Infinity,
  consumed = false,
  workingDirectory = null;
const refuse = () => {
  throw new Error("diagnostic_operation_refused_or_uncertain");
};
const fields = (v, keys) => {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).sort().join() !== keys.sort().join()
  )
    refuse();
};
function command(program, args, cwd = repository, additions = {}) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) refuse();
  return execFileSync(program, args, {
    cwd,
    encoding: "utf8",
    timeout: Math.min(180000, remaining),
    maxBuffer: 1048576,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...additions },
  });
}
const aws = (args) => command("aws", [...args, "--region", "us-east-1"]);
function download(lease, key, path) {
  aws([
    "s3api",
    "get-object",
    "--bucket",
    lease.state.bucket,
    "--key",
    key,
    path,
  ]);
  return readFileSync(path);
}
function retain(lease, key, value, path) {
  writeFileSync(path, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  aws([
    "s3api",
    "put-object",
    "--bucket",
    lease.state.bucket,
    "--key",
    key,
    "--body",
    path,
    "--if-none-match",
    "*",
    "--server-side-encryption",
    "aws:kms",
    "--ssekms-key-id",
    lease.state.kmsKeyArn,
  ]);
  if (!download(lease, key, `${path}.readback`).equals(readFileSync(path)))
    refuse();
}
function source(lease) {
  if (
    process.env.GITHUB_REF !== "refs/heads/main" ||
    process.env.GITHUB_SHA !== lease.sourceCommit ||
    process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    process.env.GITHUB_REPOSITORY !== "david-cui-bruno/founding-sales" ||
    command("git", ["rev-parse", "HEAD"]).trim() !== lease.sourceCommit ||
    command("git", [
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      "infra",
      ".github/workflows",
    ]).trim() ||
    Object.keys(process.env).some(
      (k) =>
        k.startsWith("TF_CLI_ARGS") ||
        k.startsWith("TF_VAR_") ||
        k === "TF_WORKSPACE",
    )
  )
    refuse();
}
function origin(lease, run, attempt) {
  const observed = JSON.parse(
    command("gh", [
      "api",
      `repos/david-cui-bruno/founding-sales/actions/runs/${run}/attempts/${attempt}`,
    ]),
  );
  if (
    String(observed.id) !== run ||
    String(observed.run_attempt) !== attempt ||
    observed.status !== "in_progress" ||
    observed.head_sha !== lease.sourceCommit ||
    observed.head_branch !== "main" ||
    observed.event !== "workflow_dispatch" ||
    observed.repository?.full_name !== "david-cui-bruno/founding-sales" ||
    observed.head_repository?.full_name !== "david-cui-bruno/founding-sales"
  )
    refuse();
  const workflow = JSON.parse(
    command("gh", [
      "api",
      `repos/david-cui-bruno/founding-sales/actions/workflows/${observed.workflow_id}`,
    ]),
  );
  if (workflow.path !== ".github/workflows/crm-acquisition-diagnostic.yml")
    refuse();
}
function action(raw, expected, lease, leaseHash, run, attempt) {
  if (sha(raw) !== expected || raw.length > 32768) refuse();
  const a = JSON.parse(raw);
  fields(a, [
    "version",
    "purpose",
    "operationId",
    "action",
    "origin",
    "leaseSha256",
    "sourceCommit",
    "environmentId",
    "workerImageDigest",
    "approvedAt",
    "validUntil",
    "reviewReference",
    "input",
  ]);
  fields(a.origin, ["runId", "attempt"]);
  if (
    a.version !== 1 ||
    a.purpose !== "acquisition_diagnostic_operation" ||
    !uuid.test(a.operationId) ||
    a.origin.runId !== run ||
    a.origin.attempt !== attempt ||
    a.leaseSha256 !== leaseHash ||
    a.sourceCommit !== lease.sourceCommit ||
    a.environmentId !== lease.environmentId ||
    a.workerImageDigest !== lease.images.worker ||
    typeof a.reviewReference !== "string" ||
    !/^[A-Za-z0-9:._/#+ -]{1,200}$/u.test(a.reviewReference) ||
    !Number.isFinite(Date.parse(a.approvedAt)) ||
    !Number.isFinite(Date.parse(a.validUntil)) ||
    Date.parse(a.approvedAt) < Date.parse(lease.approvedAt) ||
    Date.parse(a.validUntil) > Date.parse(lease.cleanupAt) ||
    Date.parse(a.validUntil) <= Date.parse(a.approvedAt)
  )
    refuse();
  deadline = Math.min(Date.parse(a.validUntil), Date.parse(lease.cleanupAt));
  if (Date.now() < Date.parse(a.approvedAt) || deadline - Date.now() < 300000)
    refuse();
  return a;
}
async function argumentsFor(a, lease, outputs) {
  const i = a.input;
  if (a.action === "bindings") {
    fields(i, ["workspaceId", "mailboxId", "ownerUserId"]);
    for (const id of Object.values(i))
      if (typeof id !== "string" || !uuid.test(id)) refuse();
    return [
      "admin",
      "crm-acquisition-diagnostic",
      "bindings",
      "--workspace",
      i.workspaceId,
      "--mailbox",
      i.mailboxId,
      "--owner",
      i.ownerUserId,
    ];
  }
  if (a.action === "revoke") {
    fields(i, ["workspaceId", "authorizationId", "reference"]);
    if (
      !uuid.test(i.workspaceId) ||
      !uuid.test(i.authorizationId) ||
      typeof i.reference !== "string" ||
      !/^[A-Za-z0-9:._/#+ -]{1,200}$/u.test(i.reference)
    )
      refuse();
    return [
      "admin",
      "crm-acquisition-diagnostic",
      "revoke",
      "--workspace",
      i.workspaceId,
      "--authorization",
      i.authorizationId,
      "--reference",
      i.reference,
    ];
  }

  if (a.action === "provision") {
    fields(i, ["authorization", "authorizationSha256"]);
    const { crmAcquisitionDiagnosticAuthorizationSchema } =
      await import("../../packages/contracts/src/crmAcquisitionDiagnostic.ts");
    const g = crmAcquisitionDiagnosticAuthorizationSchema.parse(
      i.authorization,
    );
    if (
      sha(JSON.stringify(g)) !== i.authorizationSha256 ||
      g.environmentId !== lease.environmentId ||
      g.databaseName !== lease.databaseName ||
      g.implementationCommit !== lease.imageBuildCommit ||
      g.apiImageDigest !== lease.images.api ||
      g.workerImageDigest !== lease.images.worker ||
      g.ecsClusterArn !== outputs.cluster_arn ||
      g.databaseEndpoint !== outputs.database_endpoint.split(":")[0] ||
      g.databaseSecretArn !== outputs.app_runtime_database_secret_arn ||
      g.providerAccountId !== lease.bootstrapAdminEmail ||
      Date.parse(g.verifiedAt) > Date.now() ||
      Date.parse(g.validUntil) <= Date.now() ||
      Date.parse(g.validUntil) > deadline - 300000 ||
      deadline - Date.now() < 600000 ||
      g.messages.length !== 2 ||
      g.maxReads !== 8 ||
      g.maxUnits !== 160 ||
      JSON.stringify(
        g.messages
          .map((m) => [m.messageId, m.threadId, m.origin, m.fromAt, m.toAt])
          .sort(),
      ) !==
        JSON.stringify(
          [
            [
              "1a11cef279246619",
              "1a11c079cb7273b8",
              "received",
              "2026-10-08T00:00:00Z",
              "2026-10-09T00:00:00Z",
            ],
            [
              "1a11ddf7ccdb1bac",
              "1a11c079cb7273b8",
              "sent",
              "2026-10-08T00:00:00Z",
              "2026-10-09T00:00:00Z",
            ],
          ].sort(),
        )
    )
      refuse();
    const instance = JSON.parse(
      aws([
        "rds",
        "describe-db-instances",
        "--db-instance-identifier",
        `${lease.prefix}-pg`,
      ]),
    ).DBInstances;
    if (
      !Array.isArray(instance) ||
      instance.length !== 1 ||
      instance[0].DBInstanceArn !== g.databaseInstanceArn ||
      instance[0].DBName !== lease.databaseName ||
      instance[0].Endpoint?.Address !== g.databaseEndpoint
    )
      refuse();
    const tasks = JSON.parse(
      aws([
        "ecs",
        "describe-tasks",
        "--cluster",
        outputs.cluster_arn,
        "--tasks",
        g.deploymentIdentity,
        g.workerDeploymentIdentity,
      ]),
    ).tasks;
    if (!Array.isArray(tasks) || tasks.length !== 2) refuse();
    for (const [taskId, digest, name] of [
      [g.deploymentIdentity, g.apiImageDigest, "api"],
      [g.workerDeploymentIdentity, g.workerImageDigest, "worker"],
    ]) {
      const task = tasks.find((t) => t.taskArn === taskId);
      if (
        task?.clusterArn !== outputs.cluster_arn ||
        task.lastStatus !== "RUNNING" ||
        !task.taskDefinitionArn?.startsWith(
          `arn:aws:ecs:us-east-1:326255650484:task-definition/${lease.prefix}-${name}:`,
        ) ||
        !task.containers?.some(
          (c) => c.name === name && c.imageDigest === digest,
        )
      )
        refuse();
    }
    return [
      "admin",
      "crm-acquisition-diagnostic",
      "provision",
      "--json-base64",
      Buffer.from(JSON.stringify(g)).toString("base64"),
      "--sha256",
      i.authorizationSha256,
    ];
  }
  refuse();
}
function bindings(lease) {
  const o = Object.fromEntries(
    Object.entries(
      JSON.parse(command("terraform", ["output", "-json"], root)),
    ).map(([k, v]) => [k, v.value]),
  );
  const arn = `arn:aws:ecs:us-east-1:326255650484:`;
  if (
    o.environment !== "rehearsal" ||
    o.destroyable !== true ||
    o.name_prefix !== lease.prefix ||
    o.database_name !== lease.databaseName ||
    o.crm_acquisition_diagnostic?.environment_id !== lease.environmentId ||
    o.crm_acquisition_diagnostic?.database_name !== lease.databaseName ||
    !o.cluster_arn?.startsWith(`${arn}cluster/${lease.prefix}`) ||
    !o.migration_task_definition_arn?.startsWith(
      `${arn}task-definition/${lease.prefix}-migration:`,
    ) ||
    !o.operations_task_definition_arn?.startsWith(
      `${arn}task-definition/${lease.prefix}-operations:`,
    ) ||
    typeof o.database_endpoint !== "string" ||
    !o.migration_database_secret_arn?.startsWith(
      `arn:aws:secretsmanager:us-east-1:326255650484:secret:${lease.prefix}/`,
    ) ||
    !o.task_network_configuration?.subnet_ids?.length ||
    !o.task_network_configuration.security_group_id
  )
    refuse();
  return o;
}
async function execute(run, attempt, leaseHash, actionHash, directory) {
  if (
    !/^[1-9][0-9]*$/u.test(run) ||
    !/^[1-9][0-9]*$/u.test(attempt) ||
    !hash.test(leaseHash) ||
    !hash.test(actionHash)
  )
    refuse();
  mkdirSync(directory, { recursive: false, mode: 0o700 });
  workingDirectory = directory;
  const owned = readRegisteredDiagnosticOperationEvidence({
    originRunId: run,
    originAttempt: attempt,
    expectedLeaseSha256: leaseHash,
    outDirectory: resolve(directory, "owned"),
  });
  const lease = owned.lease;
  source(lease);
  origin(lease, run, attempt);
  const a = action(
    download(
      lease,
      `fss/greenfield/rehearsal/${lease.prefix}/diagnostic/operations/reviews/${actionHash}.json`,
      resolve(directory, "action.private.json"),
    ),
    actionHash,
    lease,
    leaseHash,
    run,
    attempt,
  );
  const config = readDiagnosticOperationConfigurationEvidence({
    leasePath: owned.leasePath,
    expectedLeaseSha256: leaseHash,
    outDirectory: resolve(directory, "configuration"),
  });
  if (
    config.execution.runId !== run ||
    config.execution.attempt !== attempt ||
    sha(readFileSync(resolve(root, ".terraform.lock.hcl"))) !==
      config.manifest.providerLockSha256
  )
    refuse();
  writeFileSync(
    resolve(root, "run.auto.tfvars.json"),
    JSON.stringify(config.configuration),
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
  );
  const output = bindings(lease);
  const args = await argumentsFor(a, lease, output);
  source(lease);
  origin(lease, run, attempt);
  if (deadline - Date.now() < 300000) refuse();
  const base = `fss/greenfield/rehearsal/${lease.prefix}/diagnostic/operations/${a.operationId}`;
  consumed = true;
  retain(
    lease,
    `${base}/intent.json`,
    {
      version: 1,
      actionSha256: actionHash,
      leaseSha256: leaseHash,
      origin: { runId: run, attempt },
      execution: {
        runId: process.env.GITHUB_RUN_ID,
        attempt: process.env.GITHUB_RUN_ATTEMPT,
      },
      status: "consumed_no_retry",
    },
    resolve(directory, "intent.private.json"),
  );
  source(lease);
  origin(lease, run, attempt);
  if (
    JSON.stringify(bindings(lease)) !== JSON.stringify(output) ||
    deadline - Date.now() < 300000
  )
    refuse();
  if (
    JSON.stringify(await argumentsFor(a, lease, output)) !==
    JSON.stringify(args)
  )
    refuse();
  source(lease);
  origin(lease, run, attempt);
  if (deadline - Date.now() < 300000) refuse();
  const capture = resolve(directory, "capture.private.log");
  command(
    "bash",
    [
      resolve(repository, "infra/scripts/rehearsal.sh"),
      "run-task",
      lease.prefix,
      `diagnostic-${a.operationId}`,
      "migration",
      "--",
      ...args,
    ],
    repository,
    {
      FSS_REHEARSAL_ROOT: root,
      FSS_RELEASE_WORKER_DIGEST: lease.images.worker,
      FSS_RELEASE_CAPTURE: capture,
      FSS_REHEARSAL_REPORTS: resolve(directory, "reports"),
    },
  );
  source(lease);
  origin(lease, run, attempt);
  const raw = readFileSync(capture, "utf8");
  let result;
  for (const line of raw.split("\n")) {
    try {
      const candidate = JSON.parse(line);
      if (
        candidate &&
        typeof candidate === "object" &&
        !Array.isArray(candidate)
      )
        result = candidate;
    } catch {
      /* Non-report log lines never become result content. */
    }
  }
  if (!result) refuse();
  validateResult(a, result, lease);
  const retained = {
    version: 1,
    action: a.action,
    actionSha256: actionHash,
    leaseSha256: leaseHash,
    result,
  };
  retain(
    lease,
    `${base}/result.json`,
    retained,
    resolve(directory, "result.private.json"),
  );
  return {
    ok: true,
    action: a.action,
    actionSha256: actionHash,
    resultSha256: sha(JSON.stringify(retained)),
    resultKey: `${base}/result.json`,
    activationAllowed: false,
  };
}
function validateResult(a, r, lease) {
  if (a.action === "bindings") {
    fields(r, [
      "workspaceId",
      "mailboxId",
      "ownerUserId",
      "providerAccountId",
      "generation",
      "accountBinding",
      "oauthGrantObservationId",
      "databaseName",
      "schemaVersion",
      "disclosureVersion",
      "disclosureSha256",
      "readOnly",
      "productionActivationAllowed",
    ]);
    if (
      r.workspaceId !== a.input.workspaceId ||
      r.mailboxId !== a.input.mailboxId ||
      r.ownerUserId !== a.input.ownerUserId ||
      r.readOnly !== true ||
      r.productionActivationAllowed !== false ||
      r.schemaVersion !== 90 ||
      r.databaseName !== lease.databaseName ||
      r.disclosureVersion !== "crm-mail-body-acquisition-v1" ||
      r.providerAccountId !== lease.bootstrapAdminEmail ||
      typeof r.providerAccountId !== "string" ||
      r.providerAccountId.length > 320 ||
      !Number.isSafeInteger(r.generation) ||
      r.generation < 1 ||
      !hash.test(r.accountBinding) ||
      !uuid.test(r.oauthGrantObservationId) ||
      !hash.test(r.disclosureSha256)
    )
      refuse();
  } else if (a.action === "provision") {
    fields(r, ["authorizationId", "sha256"]);
    if (
      r.authorizationId !== a.input.authorization.id ||
      r.sha256 !== a.input.authorizationSha256
    )
      refuse();
  } else if (a.action === "revoke") {
    fields(r, ["authorizationId"]);
    if (r.authorizationId !== a.input.authorizationId) refuse();
  } else {
    refuse();
  }
}
try {
  const [stage, run, attempt, leaseHash, actionHash, directory, ...extra] =
    process.argv.slice(2);
  if (stage !== "execute" || extra.length || !directory) refuse();
  console.log(
    JSON.stringify(
      await execute(run, attempt, leaseHash, actionHash, resolve(directory)),
    ),
  );
} catch {
  console.log(
    JSON.stringify({
      ok: false,
      reason: "diagnostic_operation_refused_or_uncertain",
      intentConsumed: consumed,
      activationAllowed: false,
    }),
  );
  process.exitCode = 1;
} finally {
  if (workingDirectory)
    rmSync(workingDirectory, { recursive: true, force: true });
}
