#!/usr/bin/env node
/** Default-off isolated lifecycle. Private Google inputs are supplied on stdin. */
import {
  readFileSync,
  writeFileSync,
  realpathSync,
  readdirSync,
  rmSync,
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
      (program === "bash" && args[1] === "bootstrap"))
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
    if (command("terraform", ["state", "list"]).trim() !== "")
      throw new Error("nonempty_state");
    registerLifecycleLease({
      leasePath,
      expectedLeaseSha256: expectedHash,
      outDirectory: resolve(directory, "registration"),
    });
    if (
      Date.now() >= Date.parse(lease.startDeadline) ||
      command("terraform", ["state", "list"]).trim() !== ""
    )
      throw new Error("application_preflight_changed");
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
  const names = value("secret_names");
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
    !Array.isArray(names) ||
    names.length !== expected.length ||
    [...names].sort().join() !== expected.sort().join()
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
            : `${lease.prefix}/${name}`,
        "--secret-string",
        `file://${file}`,
        "--output",
        "json",
      ]);
    } finally {
      rmSync(file, { force: true });
    }
  }
  const environment = { FSS_REHEARSAL_REPORTS: resolve(directory, "reports") };
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
  writeFileSync(
    resolve(directory, "prepared-receipt.json"),
    JSON.stringify({
      leaseSha256: expectedHash,
      sourceCommit: lease.sourceCommit,
      imageBuildCommit: lease.imageBuildCommit,
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
