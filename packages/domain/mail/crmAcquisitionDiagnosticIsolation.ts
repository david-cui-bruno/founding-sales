import {
  ECSClient,
  DescribeTasksCommand,
  DescribeTaskDefinitionCommand,
} from "@aws-sdk/client-ecs";
import {
  RDSClient,
  DescribeDBInstancesCommand,
  ListTagsForResourceCommand,
} from "@aws-sdk/client-rds";
import {
  SecretsManagerClient,
  DescribeSecretCommand,
} from "@aws-sdk/client-secrets-manager";
import { lookup } from "node:dns/promises";
import type { CrmAcquisitionDiagnosticRuntime } from "./crmAcquisitionDiagnostic.ts";
type Binding = Parameters<
  CrmAcquisitionDiagnosticRuntime["verifyIsolation"]
>[0];
/** This witness performs ordinary read-only control-plane inspection, never GetSecretValue.
 * Production has no diagnostic composition or permission expansion. Missing authority fails closed.
 */
export function createCrmAcquisitionDiagnosticIsolation(options: {
  region: string;
  taskMetadataEndpoint: string;
  databaseSecretArn: string;
  databaseHost: string;
  imageDigest: string;
  fetch?: typeof globalThis.fetch;
  ecs?: Pick<ECSClient, "send">;
  rds?: Pick<RDSClient, "send">;
  secrets?: Pick<SecretsManagerClient, "send">;
  resolve?: typeof lookup;
}): CrmAcquisitionDiagnosticRuntime["verifyIsolation"] {
  const ecs =
      options.ecs ??
      new ECSClient({
        region: options.region,
        maxAttempts: 1,
        requestHandler: { connectionTimeout: 2000, requestTimeout: 5000 },
      }),
    rds =
      options.rds ??
      new RDSClient({
        region: options.region,
        maxAttempts: 1,
        requestHandler: { connectionTimeout: 2000, requestTimeout: 5000 },
      }),
    secrets =
      options.secrets ??
      new SecretsManagerClient({
        region: options.region,
        maxAttempts: 1,
        requestHandler: { connectionTimeout: 2000, requestTimeout: 5000 },
      });
  return async (binding: Binding) => {
    try {
      if (
        !binding.connectedServerAddress ||
        binding.databaseSecretArn !== options.databaseSecretArn ||
        binding.databaseEndpoint !== options.databaseHost ||
        !/^fss[_-]diagnostic[_-]/u.test(binding.databaseName)
      )
        return false;
      const endpoint = new URL(options.taskMetadataEndpoint);
      if (
        endpoint.protocol !== "http:" ||
        endpoint.hostname !== "169.254.170.2" ||
        endpoint.username ||
        endpoint.password
      )
        return false;
      const response = await (options.fetch ?? globalThis.fetch)(
        `${endpoint.href.replace(/\/$/u, "")}/task`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (!response.ok) return false;
      const metadata: unknown = await response.json();
      if (
        !metadata ||
        typeof metadata !== "object" ||
        !("TaskARN" in metadata) ||
        typeof metadata.TaskARN !== "string"
      )
        return false;
      const tasks = await ecs.send(
        new DescribeTasksCommand({
          cluster: binding.ecsClusterArn,
          tasks: [metadata.TaskARN],
          include: ["TAGS"],
        }),
      );
      const task = tasks.tasks?.[0];
      const tagged = (
        tags:
          | readonly { key?: string | undefined; value?: string | undefined }[]
          | undefined,
      ) =>
        tags?.some(
          (tag) =>
            tag.key === "CalliePurpose" &&
            tag.value === "acquisition_acceptance",
        ) === true &&
        tags.some(
          (tag) =>
            tag.key === "CallieDiagnosticEnvironment" &&
            tag.value === binding.environmentId,
        );
      if (
        tasks.failures?.length ||
        tasks.tasks?.length !== 1 ||
        task?.taskArn !== metadata.TaskARN ||
        task.clusterArn !== binding.ecsClusterArn ||
        (binding.purpose !== "progress_read" &&
          binding.purpose !== "oauth_bootstrap" &&
          task.taskDefinitionArn !== binding.deploymentIdentity) ||
        !task.taskDefinitionArn ||
        task.lastStatus !== "RUNNING" ||
        !tagged(task.tags) ||
        !task.containers?.some(
          (container) => container.imageDigest === options.imageDigest,
        )
      )
        return false;
      const definition = await ecs.send(
        new DescribeTaskDefinitionCommand({
          taskDefinition: task.taskDefinitionArn,
        }),
      );
      if (
        definition.taskDefinition?.taskDefinitionArn !==
          task.taskDefinitionArn ||
        !definition.taskDefinition.containerDefinitions?.some(
          (container) =>
            task.containers?.some(
              (observed) =>
                observed.name === container.name &&
                observed.imageDigest === options.imageDigest,
            ) &&
            container.secrets?.some(
              (secret) =>
                secret.name === "DATABASE_SECRET_ARN" &&
                secret.valueFrom === binding.databaseSecretArn,
            ),
        )
      )
        return false;
      const instances = await rds.send(
        new DescribeDBInstancesCommand({
          DBInstanceIdentifier: binding.databaseInstanceArn,
        }),
      );
      const instance = instances.DBInstances?.[0];
      if (
        instances.DBInstances?.length !== 1 ||
        instance?.DBInstanceArn !== binding.databaseInstanceArn ||
        instance.Endpoint?.Address !== binding.databaseEndpoint ||
        instance.DBInstanceStatus !== "available"
      )
        return false;
      if (
        !tagged(
          (
            await rds.send(
              new ListTagsForResourceCommand({
                ResourceName: binding.databaseInstanceArn,
              }),
            )
          ).TagList?.map((tag) => ({ key: tag.Key, value: tag.Value })),
        )
      )
        return false;
      const secret = await secrets.send(
        new DescribeSecretCommand({ SecretId: binding.databaseSecretArn }),
      );
      if (
        secret.ARN !== binding.databaseSecretArn ||
        secret.DeletedDate ||
        !tagged(secret.Tags?.map((tag) => ({ key: tag.Key, value: tag.Value })))
      )
        return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const addresses = await Promise.race([
          (options.resolve ?? lookup)(binding.databaseEndpoint, { all: true }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("diagnostic_dns_timeout")),
              5000,
            );
          }),
        ]);
        return addresses.some(
          (address) => address.address === binding.connectedServerAddress,
        );
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch {
      return false;
    }
  };
}
