import { expect, it, vi } from "vitest";
import { createCrmAcquisitionDiagnosticIsolation } from "../mail/crmAcquisitionDiagnosticIsolation.ts";
import { createCrmAcquisitionDiagnosticStartup } from "../mail/crmAcquisitionDiagnosticStartup.ts";
const sdk = vi.hoisted(() => ({
  ecsSend: vi.fn<() => Promise<unknown>>(),
  rdsSend: vi.fn<() => Promise<unknown>>(),
  secretsSend: vi.fn<() => Promise<unknown>>(),
}));
vi.mock("@aws-sdk/client-ecs", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ECSClient: class {
    send = sdk.ecsSend;
  },
}));
vi.mock("@aws-sdk/client-rds", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  RDSClient: class {
    send = sdk.rdsSend;
  },
}));
vi.mock("@aws-sdk/client-secrets-manager", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  SecretsManagerClient: class {
    send = sdk.secretsSend;
  },
}));
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "10.1.2.3", family: 4 }]),
}));
const binding = {
  environmentId: "00000000-0000-4000-8000-000000000001",
  databaseName: "fss_diagnostic_acceptance",
  deploymentIdentity:
    "arn:aws:ecs:us-east-1:123456789012:task-definition/diagnostic:1",
  databaseInstanceArn: "arn:aws:rds:us-east-1:123456789012:db:diagnostic",
  databaseSecretArn:
    "arn:aws:secretsmanager:us-east-1:123456789012:secret:diagnostic",
  databaseEndpoint: "diagnostic.example.test",
  ecsClusterArn: "arn:aws:ecs:us-east-1:123456789012:cluster/diagnostic",
  connectedServerAddress: "10.1.2.3",
};
function fixture() {
  sdk.ecsSend.mockReset();
  sdk.rdsSend.mockReset();
  sdk.secretsSend.mockReset();
  const tags = [
    { key: "CalliePurpose", value: "acquisition_acceptance" },
    { key: "CallieDiagnosticEnvironment", value: binding.environmentId },
  ];
  const awsTags = tags.map((tag) => ({ Key: tag.key, Value: tag.value }));
  const ecsSend = sdk.ecsSend
    .mockResolvedValueOnce({
      $metadata: {},
      tasks: [
        {
          taskArn: "arn:task",
          clusterArn: binding.ecsClusterArn,
          taskDefinitionArn: binding.deploymentIdentity,
          lastStatus: "RUNNING",
          tags,
          containers: [
            { name: "worker", imageDigest: "sha256:" + "a".repeat(64) },
          ],
        },
      ],
    })
    .mockResolvedValueOnce({
      $metadata: {},
      taskDefinition: {
        taskDefinitionArn: binding.deploymentIdentity,
        containerDefinitions: [
          {
            name: "worker",
            secrets: [
              {
                name: "DATABASE_SECRET_ARN",
                valueFrom: binding.databaseSecretArn,
              },
            ],
          },
        ],
      },
    });
  sdk.rdsSend
    .mockResolvedValueOnce({
      $metadata: {},
      DBInstances: [
        {
          DBInstanceArn: binding.databaseInstanceArn,
          DBInstanceStatus: "available",
          Endpoint: { Address: binding.databaseEndpoint },
        },
      ],
    })
    .mockResolvedValueOnce({ $metadata: {}, TagList: awsTags });
  sdk.secretsSend.mockResolvedValue({
    $metadata: {},
    ARN: binding.databaseSecretArn,
    Tags: awsTags,
  });
  return {
    ecsSend,
    verify: createCrmAcquisitionDiagnosticIsolation({
      region: "us-east-1",
      taskMetadataEndpoint: "http://169.254.170.2/v4/current",
      databaseSecretArn: binding.databaseSecretArn,
      databaseHost: binding.databaseEndpoint,
      imageDigest: "sha256:" + "a".repeat(64),
      fetch: async () => new Response(JSON.stringify({ TaskARN: "arn:task" })),
    }),
  };
}
it("requires actual exact task, RDS, secret and connected endpoint witness, not database name or a manifest flag", async () => {
  const good = fixture();
  expect(await good.verify(binding)).toBe(true);
  const wrong = fixture();
  expect(
    await wrong.verify({ ...binding, connectedServerAddress: "10.9.9.9" }),
  ).toBe(false);
  expect(wrong.ecsSend).toHaveBeenCalledTimes(2);
});
it("refuses production database namespace and secret mismatch before any control-plane request", async () => {
  const data = fixture();
  expect(await data.verify({ ...binding, databaseName: "fss" })).toBe(false);
  expect(
    await data.verify({ ...binding, databaseSecretArn: "arn:production" }),
  ).toBe(false);
  expect(data.ecsSend).not.toHaveBeenCalled();
});
it("default startup is unavailable and explicit production connection is rejected", () => {
  const identity = {
    implementationCommit: "a".repeat(40),
    imageDigest: "sha256:" + "a".repeat(64),
    side: "worker" as const,
    schemaVersion: 90,
    connectionString: "postgres://user:secret@db.example.test/fss",
  };
  expect(createCrmAcquisitionDiagnosticStartup({}, identity)).toBeUndefined();
  expect(() =>
    createCrmAcquisitionDiagnosticStartup(
      {
        FSS_CRM_ACQUISITION_DIAGNOSTIC: JSON.stringify({
          environmentId: binding.environmentId,
          region: "us-east-1",
          databaseSecretArn: binding.databaseSecretArn,
          databaseInstanceArn: binding.databaseInstanceArn,
          ecsClusterArn: binding.ecsClusterArn,
        }),
        ECS_CONTAINER_METADATA_URI_V4: "http://169.254.170.2/v4/current",
      },
      identity,
    ),
  ).toThrow("diagnostic_database_not_isolated");
});

it("refuses a secret bound to another task container even when image and tags match", async () => {
  const data = fixture();
  sdk.ecsSend
    .mockReset()
    .mockResolvedValueOnce({
      tasks: [
        {
          taskArn: "arn:task",
          clusterArn: binding.ecsClusterArn,
          taskDefinitionArn: binding.deploymentIdentity,
          lastStatus: "RUNNING",
          tags: [
            { key: "CalliePurpose", value: "acquisition_acceptance" },
            {
              key: "CallieDiagnosticEnvironment",
              value: binding.environmentId,
            },
          ],
          containers: [
            { name: "worker", imageDigest: "sha256:" + "a".repeat(64) },
          ],
        },
      ],
    })
    .mockResolvedValueOnce({
      taskDefinition: {
        taskDefinitionArn: binding.deploymentIdentity,
        containerDefinitions: [
          {
            name: "other",
            secrets: [
              {
                name: "DATABASE_SECRET_ARN",
                valueFrom: binding.databaseSecretArn,
              },
            ],
          },
        ],
      },
    });
  expect(await data.verify(binding)).toBe(false);
  expect(sdk.rdsSend).not.toHaveBeenCalled();
});

it("historical progress witnesses the current task and physical database, without granting historical dispatch", async () => {
  const read = fixture();
  expect(
    await read.verify({
      ...binding,
      deploymentIdentity: "old-task",
      purpose: "progress_read",
    }),
  ).toBe(true);
  const dispatch = fixture();
  expect(
    await dispatch.verify({
      ...binding,
      deploymentIdentity: "old-task",
      purpose: "acquisition_dispatch",
    }),
  ).toBe(false);
  expect(dispatch.ecsSend).toHaveBeenCalledTimes(1);
  const wrongDatabase = fixture();
  expect(
    await wrongDatabase.verify({
      ...binding,
      deploymentIdentity: "old-task",
      purpose: "progress_read",
      connectedServerAddress: "10.9.9.9",
    }),
  ).toBe(false);
});

it("consent bootstrap witnesses the actual running task without a fabricated acquisition grant", async () => {
  const current = fixture();
  expect(
    await current.verify({
      ...binding,
      deploymentIdentity: "",
      purpose: "oauth_bootstrap",
    }),
  ).toBe(true);
  const wrongEndpoint = fixture();
  expect(
    await wrongEndpoint.verify({
      ...binding,
      deploymentIdentity: "",
      purpose: "oauth_bootstrap",
      connectedServerAddress: "10.9.9.9",
    }),
  ).toBe(false);
});
