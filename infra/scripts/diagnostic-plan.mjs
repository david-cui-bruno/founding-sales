#!/usr/bin/env node
/** Exact plan-only operator command. No apply, destroy, secret-value or provider commands. */
import {
  createHash,
  createPublicKey,
  createCipheriv,
  createDecipheriv,
  publicEncrypt,
  privateDecrypt,
  randomBytes,
  constants,
} from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  API_SCHEMA_RANGE,
  WORKER_SCHEMA_RANGE,
} from "../../packages/domain/db/schemaRange.ts";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const write = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
function requireValue(value, pattern) {
  if (typeof value !== "string" || !pattern.test(value))
    throw new Error("invalid_configuration");
  return value;
}
function validate(file, directory) {
  const config = read(file);
  const fields = [
    "environmentId",
    "databaseName",
    "apiHostname",
    "recipientPublicKeyPem",
    "recipientPublicKeySha256",
  ];
  if (Object.keys(config).sort().join() !== fields.sort().join())
    throw new Error("invalid_configuration");
  const env = process.env;
  if (
    Object.keys(env).some(
      (name) =>
        name.startsWith("TF_CLI_ARGS") ||
        name.startsWith("TF_VAR_") ||
        name === "TF_WORKSPACE",
    )
  )
    throw new Error("terraform_override_refused");
  if (env.GITHUB_REF !== "refs/heads/main") throw new Error("main_required");
  const commit = requireValue(env.GITHUB_SHA, /^[0-9a-f]{40}$/u);
  const runId = requireValue(env.GITHUB_RUN_ID, /^[1-9][0-9]*$/u);
  const runAttempt = requireValue(env.GITHUB_RUN_ATTEMPT, /^[1-9][0-9]*$/u);
  const suffix = requireValue(
    env.FSS_DIAGNOSTIC_RUN_SUFFIX,
    /^[a-z0-9][a-z0-9-]{1,16}[a-z0-9]$/u,
  );
  const prefix = `fss-rh-${suffix}`;
  requireValue(
    config.environmentId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  requireValue(config.databaseName, /^fss_diagnostic_[a-z0-9_]{1,40}$/u);
  if (
    config.databaseName !== `fss_diagnostic_${suffix.replaceAll("-", "_")}` ||
    config.apiHostname !== `${suffix}.rehearsal.usecallie.com`
  )
    throw new Error("namespace_mismatch");
  if (
    typeof config.recipientPublicKeyPem !== "string" ||
    !config.recipientPublicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----") ||
    config.recipientPublicKeyPem.length > 10000
  )
    throw new Error("public_key_required");
  const key = createPublicKey(config.recipientPublicKeyPem);
  if (
    key.export({ type: "spki", format: "pem" }).toString().trim() !==
    config.recipientPublicKeyPem.trim()
  )
    throw new Error("public_key_required");
  if (
    key.asymmetricKeyType !== "rsa" ||
    key.asymmetricKeyDetails.modulusLength < 3072 ||
    sha(key.export({ type: "spki", format: "der" })) !==
      requireValue(config.recipientPublicKeySha256, /^[0-9a-f]{64}$/u)
  )
    throw new Error("recipient_mismatch");
  for (const range of [API_SCHEMA_RANGE, WORKER_SCHEMA_RANGE])
    if (range.minimum !== 90 || range.maximum !== 90)
      throw new Error("schema90_required");
  const apiDigest = requireValue(
    env.FSS_DIAGNOSTIC_API_DIGEST,
    /^sha256:[0-9a-f]{64}$/u,
  );
  const workerDigest = requireValue(
    env.FSS_DIAGNOSTIC_WORKER_DIGEST,
    /^sha256:[0-9a-f]{64}$/u,
  );
  if (apiDigest === workerDigest) throw new Error("distinct_images_required");
  const apiRepository = requireValue(
    env.FSS_DIAGNOSTIC_API_REPOSITORY,
    /^[0-9]{12}\.dkr\.ecr\.us-east-1\.amazonaws\.com\/fss-rh-api$/u,
  );
  const workerRepository = requireValue(
    env.FSS_DIAGNOSTIC_WORKER_REPOSITORY,
    /^[0-9]{12}\.dkr\.ecr\.us-east-1\.amazonaws\.com\/fss-rh-worker$/u,
  );
  if (apiRepository.split(".")[0] !== workerRepository.split(".")[0])
    throw new Error("account_mismatch");
  const account = apiRepository.split(".")[0];
  const certificate = requireValue(
    env.FSS_DIAGNOSTIC_CERTIFICATE_ARN,
    new RegExp(
      `^arn:aws:acm:us-east-1:${account}:certificate/[0-9a-f-]{36}$`,
      "u",
    ),
  );
  const zones = env.FSS_DIAGNOSTIC_ZONES ?? "us-east-1a,us-east-1b";
  if (!["us-east-1a,us-east-1b", "us-east-1a,us-east-1d"].includes(zones))
    throw new Error("invalid_zones");
  const configuration = {
    assume_deployment_role: false,
    bootstrap: true,
    name_prefix: prefix,
    availability_zones: zones.split(","),
    api_image: `${apiRepository}@${apiDigest}`,
    worker_image: `${workerRepository}@${workerDigest}`,
    certificate_arn: certificate,
    api_hostname: config.apiHostname,
    api_schema_range: { min: 90, max: 90 },
    worker_schema_range: { min: 90, max: 90 },
    crm_acquisition_diagnostic: {
      environment_id: config.environmentId,
      database_name: config.databaseName,
    },
  };
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const validated = {
    version: "fss.diagnostic-plan-input.v1",
    commit,
    runId,
    runAttempt,
    prefix,
    stateKey: `fss/greenfield/rehearsal/${prefix}/terraform.tfstate`,
    schema: 90,
    account,
    configuration,
    configurationSha256: sha(JSON.stringify(configuration)),
    recipientPublicKeyPem: config.recipientPublicKeyPem,
    recipientPublicKeySha256: config.recipientPublicKeySha256,
  };
  write(resolve(directory, "validated.json"), validated);
  console.log("diagnostic proposal validated; no cloud operations");
}
function command(program, args, cwd, timeout = 60000) {
  try {
    return execFileSync(program, args, {
      cwd,
      encoding: "utf8",
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    const operation = program === "terraform" && ["version", "init", "state", "plan", "show"].includes(args[0])
      ? `_${args[0]}`
      : "";
    throw new Error(`command_failed_${program.replaceAll(/[^a-z]/gu, "")}${operation}`);
  }
}
function provenance(validatedPath, pinPath) {
  const input = read(validatedPath),
    pin = read(pinPath);
  if (
    pin.schema !== "fss.image-pin.v1" ||
    pin.commit !== input.commit ||
    pin.imageInputsUnchanged !== true ||
    !/^[0-9a-f]{40}$/u.test(pin.imagesCommit) ||
    !/^[1-9][0-9]*$/u.test(String(pin.imagesRunId)) ||
    !/^[1-9][0-9]*$/u.test(String(pin.gateRunId))
  )
    throw new Error("invalid_provenance");
  for (const service of ["api", "worker"])
    if (
      pin.images[service].repository !== `fss-rh-${service}` ||
      input.configuration[`${service}_image`].split("@")[1] !==
        pin.images[service].digest
    )
      throw new Error("image_mismatch");
  return pin;
}
export async function prepareDiagnosticPlan(configFile, directory, root, options = {}) {
  validate(configFile, directory);
  const input = read(resolve(directory, "validated.json"));
  if (options.validatedConfigurationConsumer !== undefined) {
    if (typeof options.validatedConfigurationConsumer !== "function")
      throw new Error("invalid_configuration_consumer");
    await options.validatedConfigurationConsumer({
      configuration: structuredClone(input.configuration),
    });
  }
  const repository = fileURLToPath(new URL("../..", import.meta.url));
  root = realpathSync(root);
  // Only the exact checked-out root is supported; copied asset trees cannot attest source.
  const source = resolve(repository, "infra/roots/rehearsal");
  if (root !== source) throw new Error("root_changed");
  const allowedRootFiles = new Set([
    "main.tf",
    "variables.tf",
    "providers.tf",
    "versions.tf",
    "outputs.tf",
    "backend.hcl",
    ".terraform.lock.hcl",
    "run.auto.tfvars.json",
  ]);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("root_changed");
    if (
      !entry.isDirectory() &&
      /(?:\.tf(?:\.json)?|\.hcl|\.tfvars(?:\.json)?)$/u.test(entry.name) &&
      !allowedRootFiles.has(entry.name)
    )
      throw new Error("root_changed");
  }
  if (command("git", ["rev-parse", "HEAD"], repository).trim() !== input.commit)
    throw new Error("source_changed");
  if (
    command(
      "git",
      [
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        "infra",
        ".github/workflows/greenfield-release.yml",
        "packages/domain/db/schemaRange.ts",
        ".node-version",
      ],
      repository,
    ).trim() !== ""
  )
    throw new Error("source_changed");
  const providerLockSha256 = sha(
    readFileSync(resolve(root, ".terraform.lock.hcl")),
  );
  const sourceTree = command(
    "git",
    ["rev-parse", `${input.commit}^{tree}`],
    repository,
  ).trim();
  command(
    "bash",
    [
      resolve(repository, "infra/scripts/images.sh"),
      "pin",
      input.commit,
      resolve(directory, "image-pin.json"),
    ],
    repository,
    120000,
  );
  const pin = provenance(
    resolve(directory, "validated.json"),
    resolve(directory, "image-pin.json"),
  );
  const identity = JSON.parse(
    command(
      "aws",
      ["sts", "get-caller-identity", "--output", "json"],
      repository,
    ),
  );
  if (
    identity.Account !== input.account ||
    !new RegExp(
      `^arn:aws:sts::${input.account}:assumed-role/fss-rh-deploy/[^/]+$`,
      "u",
    ).test(identity.Arn)
  )
    throw new Error("wrong_role");
  const registry = input.configuration.api_image.split("/")[0];
  const dockerConfig = resolve(directory, "registry-private");
  mkdirSync(dockerConfig, { recursive: true, mode: 0o700 });
  const previousDockerConfig = process.env.DOCKER_CONFIG;
  process.env.DOCKER_CONFIG = dockerConfig;
  try {
    for (const service of ["api", "worker"]) {
      const name = `fss-rh-${service}`;
      const repositories = JSON.parse(
        command(
          "aws",
          [
            "ecr",
            "describe-repositories",
            "--repository-names",
            name,
            "--region",
            "us-east-1",
            "--output",
            "json",
          ],
          repository,
        ),
      );
      if (
        repositories.repositories?.length !== 1 ||
        repositories.repositories[0].imageTagMutability !== "IMMUTABLE"
      )
        throw new Error("registry_provenance_changed");
      const images = JSON.parse(
        command(
          "aws",
          [
            "ecr",
            "describe-images",
            "--repository-name",
            name,
            "--image-ids",
            `imageTag=ci-${pin.imagesCommit}`,
            "--region",
            "us-east-1",
            "--output",
            "json",
          ],
          repository,
        ),
      );
      if (
        images.imageDetails?.length !== 1 ||
        images.imageDetails[0].imageDigest !== pin.images[service].digest
      )
        throw new Error("registry_provenance_changed");
    }
    // Ephemeral ECR authentication is supplied on stdin, never a database secret or log.
    const password = command(
      "aws",
      ["ecr", "get-login-password", "--region", "us-east-1"],
      repository,
    );
    try {
      execFileSync(
        "docker",
        ["login", "--username", "AWS", "--password-stdin", registry],
        {
          cwd: repository,
          input: password,
          timeout: 60000,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch {
      throw new Error("registry_provenance_changed");
    }
    for (const service of ["api", "worker"]) {
      const reference = input.configuration[`${service}_image`];
      command(
        "docker",
        ["pull", "--platform", "linux/arm64", reference],
        repository,
        600000,
      );
      const inspected = JSON.parse(
        command("docker", ["image", "inspect", reference], repository),
      );
      if (
        inspected.length !== 1 ||
        inspected[0].Architecture !== "arm64" ||
        !inspected[0].RepoDigests?.includes(reference) ||
        inspected[0].Config?.Labels?.["org.opencontainers.image.revision"] !==
          pin.imagesCommit ||
        !inspected[0].Config?.Env?.includes(
          `FSS_BUILD_COMMIT=${pin.imagesCommit}`,
        )
      )
        throw new Error("registry_provenance_changed");
    }
  } finally {
    rmSync(dockerConfig, { recursive: true, force: true });
    if (previousDockerConfig === undefined) delete process.env.DOCKER_CONFIG;
    else process.env.DOCKER_CONFIG = previousDockerConfig;
  }
  const certificate = JSON.parse(
    command(
      "aws",
      [
        "acm",
        "describe-certificate",
        "--certificate-arn",
        input.configuration.certificate_arn,
        "--region",
        "us-east-1",
        "--output",
        "json",
      ],
      repository,
    ),
  ).Certificate;
  if (
    certificate.Status !== "ISSUED" ||
    !certificate.SubjectAlternativeNames.some(
      (name) =>
        name === input.configuration.api_hostname ||
        name === "*.rehearsal.usecallie.com",
    )
  )
    throw new Error("certificate_mismatch");
  const version = JSON.parse(
    command("terraform", ["version", "-json"], root),
  ).terraform_version;
  if (version !== "1.15.8") throw new Error("terraform_version_mismatch");
  write(resolve(root, "run.auto.tfvars.json"), input.configuration);
  command(
    "terraform",
    [
      "init",
      "-reconfigure",
      "-input=false",
      "-lockfile=readonly",
      "-backend-config=backend.hcl",
      `-backend-config=key=${input.stateKey}`,
    ],
    root,
    300000,
  );
  if (command("terraform", ["state", "list"], root).trim() !== "")
    throw new Error("nonempty_state");
  const planPath = resolve(directory, "plan.tfplan");
  const publicPath = resolve(directory, "recipient.pem");
  try {
    command(
      "terraform",
      ["plan", "-input=false", "-lock-timeout=5m", `-out=${planPath}`],
      root,
      900000,
    );
    const shown = JSON.parse(
      command("terraform", ["show", "-json", planPath], root),
    );
    for (const [name, value] of Object.entries(input.configuration)) {
      if (
        JSON.stringify(canonical(shown.variables?.[name]?.value)) !==
        JSON.stringify(canonical(value))
      )
        throw new Error("plan_configuration_changed");
    }
    function refuseSecretValues(module) {
      for (const resource of module?.resources ?? [])
        if (
          ["aws_secretsmanager_secret_version", "aws_ssm_parameter"].includes(
            resource.type,
          )
        )
          throw new Error("secret_value_plan_refused");
      for (const child of module?.child_modules ?? []) refuseSecretValues(child);
    }
    refuseSecretValues(shown.planned_values?.root_module);
    const actions = [];
    for (const change of shown.resource_changes ?? []) {
      if (
        ["aws_secretsmanager_secret_version", "aws_ssm_parameter"].includes(
          change.type,
        )
      )
        throw new Error("secret_value_plan_refused");
      if (
        !/^[a-zA-Z0-9_.[\]"-]+$/u.test(change.address) ||
        !Array.isArray(change.change?.actions)
      )
        throw new Error("unsafe_summary");
      if (
        change.change.actions.some(
          (action) => !["create", "read", "no-op"].includes(action),
        )
      )
        throw new Error("not_creation_plan");
      actions.push({ address: change.address, actions: change.change.actions });
    }
    if (!actions.some((item) => item.actions.includes("create")))
      throw new Error("empty_plan");
    if (command("terraform", ["state", "list"], root).trim() !== "")
      throw new Error("state_changed");
    if (
      command("git", ["rev-parse", "HEAD"], repository).trim() !== input.commit ||
      command(
        "git",
        [
          "status",
          "--porcelain",
          "--untracked-files=all",
          "--",
          "infra",
          ".github/workflows/greenfield-release.yml",
          "packages/domain/db/schemaRange.ts",
          ".node-version",
        ],
        repository,
      ).trim() !== "" ||
      sha(readFileSync(resolve(root, ".terraform.lock.hcl"))) !==
        providerLockSha256
    )
      throw new Error("source_changed");
    const publicDir = resolve(directory, "public"),
      encryptedDir = resolve(directory, "encrypted");
    mkdirSync(publicDir, { recursive: true, mode: 0o700 });
    mkdirSync(encryptedDir, { recursive: true, mode: 0o700 });
    const manifest = {
      version: "fss.diagnostic-plan.v1",
      commit: input.commit,
      sourceTree,
      providerLockSha256,
      imageBuildCommit: pin.imagesCommit,
      imagesRunId: pin.imagesRunId,
      gateRunId: pin.gateRunId,
      workflowRunId: input.runId,
      workflowRunAttempt: input.runAttempt,
      stateKey: input.stateKey,
      configurationSha256: input.configurationSha256,
      diagnostic: {
        environmentId:
          input.configuration.crm_acquisition_diagnostic.environment_id,
        databaseName:
          input.configuration.crm_acquisition_diagnostic.database_name,
        apiHostname: input.configuration.api_hostname,
        prefix: input.prefix,
        schema: 90,
        sendingEnabled: false,
        bootstrap: true,
      },
      recipientPublicKeySha256: input.recipientPublicKeySha256,
      planSha256: sha(readFileSync(planPath)),
      terraformVersion: version,
      apiDigest: pin.images.api.digest,
      workerDigest: pin.images.worker.digest,
      activationAllowed: false,
      applySupported: false,
    };
    const manifestPath = resolve(publicDir, "manifest.json");
    write(manifestPath, manifest);
    if (options.privatePlanConsumer !== undefined) {
      if (typeof options.privatePlanConsumer !== "function") throw new Error("invalid_private_consumer");
      const manifestSha256 = sha(readFileSync(manifestPath));
      await options.privatePlanConsumer({
        planPath, manifestPath, manifest: structuredClone(manifest),
        configuration: structuredClone(input.configuration),
      });
      if (sha(readFileSync(planPath)) !== manifest.planSha256 ||
          sha(readFileSync(manifestPath)) !== manifestSha256)
        throw new Error("plan_changed");
    }
    writeFileSync(publicPath, input.recipientPublicKeyPem, { mode: 0o600 });
    const encryptedPath = resolve(encryptedDir, "plan.encrypted.json");
    seal(
      planPath,
      manifestPath,
      publicPath,
      input.recipientPublicKeySha256,
      encryptedPath,
    );
    write(resolve(publicDir, "artifact-receipt.json"), {
      version: "fss.diagnostic-plan-artifact.v1",
      manifestSha256: sha(readFileSync(manifestPath)),
      encryptedPlanSha256: sha(readFileSync(encryptedPath)),
      retentionDays: 1,
    });
    const summary = `resource changes: ${actions.length}\n${actions.map((item) => `${item.actions.join("+")} ${item.address}`).join("\n")}\nplan only; no apply or acquisition acceptance\n`;
    writeFileSync(resolve(publicDir, "summary.txt"), summary, { mode: 0o600 });
    console.log(summary.trim());
  } finally {
    rmSync(planPath, { force: true });
    rmSync(publicPath, { force: true });
  }
}
function seal(planPath, manifestPath, publicPath, fingerprint, output) {
  const plan = readFileSync(planPath);
  const manifest = readFileSync(manifestPath);
  if (read(manifestPath).planSha256 !== sha(plan))
    throw new Error("plan_changed");
  const pem = readFileSync(publicPath, "utf8");
  if (!pem.startsWith("-----BEGIN PUBLIC KEY-----"))
    throw new Error("public_key_required");
  const recipient = createPublicKey(pem);
  if (
    recipient.export({ type: "spki", format: "pem" }).toString().trim() !==
    pem.trim()
  )
    throw new Error("public_key_required");
  if (
    recipient.asymmetricKeyType !== "rsa" ||
    recipient.asymmetricKeyDetails.modulusLength < 3072 ||
    sha(recipient.export({ type: "spki", format: "der" })) !== fingerprint
  )
    throw new Error("recipient_mismatch");
  const key = randomBytes(32),
    nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(manifest);
  const ciphertext = Buffer.concat([cipher.update(plan), cipher.final()]);
  const wrapped = publicEncrypt(
    {
      key: recipient,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    key,
  );
  write(output, {
    version: "fss.encrypted-plan.v1",
    algorithm: "RSA-OAEP-SHA256+A256GCM",
    manifestSha256: sha(manifest),
    recipientPublicKeySha256: fingerprint,
    wrappedKey: wrapped.toString("base64"),
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
  key.fill(0);
}
function decrypt(envelopePath, manifestPath, privatePath, output) {
  const packet = read(envelopePath),
    manifest = readFileSync(manifestPath);
  if (
    readFileSync(envelopePath, "utf8") !==
    `${JSON.stringify(packet, null, 2)}\n`
  )
    throw new Error("invalid_envelope");
  if (
    Object.keys(packet).sort().join() !==
      [
        "version",
        "algorithm",
        "manifestSha256",
        "recipientPublicKeySha256",
        "wrappedKey",
        "nonce",
        "tag",
        "ciphertext",
      ]
        .sort()
        .join() ||
    packet.version !== "fss.encrypted-plan.v1" ||
    packet.algorithm !== "RSA-OAEP-SHA256+A256GCM" ||
    packet.manifestSha256 !== sha(manifest)
  )
    throw new Error("envelope_changed");
  const privateKey = readFileSync(privatePath);
  const recipient = createPublicKey(privateKey);
  if (
    sha(recipient.export({ type: "spki", format: "der" })) !==
    packet.recipientPublicKeySha256
  )
    throw new Error("wrong_recipient");
  const key = privateDecrypt(
    {
      key: privateKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(packet.wrappedKey, "base64"),
  );
  const nonce = Buffer.from(packet.nonce, "base64"),
    tag = Buffer.from(packet.tag, "base64");
  if (key.length !== 32 || nonce.length !== 12 || tag.length !== 16)
    throw new Error("invalid_envelope");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(manifest);
  decipher.setAuthTag(tag);
  const plan = Buffer.concat([
    decipher.update(Buffer.from(packet.ciphertext, "base64")),
    decipher.final(),
  ]);
  if (sha(plan) !== read(manifestPath).planSha256)
    throw new Error("plan_changed");
  writeFileSync(output, plan, { mode: 0o600, flag: "wx" });
  key.fill(0);
}
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "validate" && args.length === 2) validate(...args);
    else if (command === "provenance" && args.length === 2) provenance(...args);
    else if (command === "plan" && args.length === 3) await prepareDiagnosticPlan(...args);
    else if (command === "seal" && args.length === 5) seal(...args);
    else if (command === "decrypt" && args.length === 4) decrypt(...args);
    else throw new Error("invalid_command");
  } catch (error) {
    console.error(
      `diagnostic plan refused: ${
        [
          "invalid_configuration",
          "main_required",
          "namespace_mismatch",
          "public_key_required",
          "recipient_mismatch",
          "schema90_required",
          "distinct_images_required",
          "account_mismatch",
          "invalid_zones",
          "root_changed",
          "source_changed",
          "invalid_provenance",
          "image_mismatch",
          "wrong_role",
          "certificate_mismatch",
          "terraform_version_mismatch",
          "nonempty_state",
          "unsafe_summary",
          "not_creation_plan",
          "empty_plan",
          "state_changed",
          "plan_configuration_changed",
          "plan_changed",
          "envelope_changed",
          "wrong_recipient",
          "invalid_envelope",
          "invalid_command",
          "command_failed_bash",
          "command_failed_aws",
          "command_failed_terraform",
          "command_failed_terraform_version",
          "command_failed_terraform_init",
          "command_failed_terraform_state",
          "command_failed_terraform_plan",
          "command_failed_terraform_show",
          "command_failed_git",
        ].includes(error.message)
          ? error.message
          : "operation_failed"
      }`,
    );
    process.exitCode = 1;
  }

}
