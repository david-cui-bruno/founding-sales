import { DescribeTableCommand, DynamoDBClient, GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import type { DynamoResult } from './dynamoStore';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { reservePrivateOutput, type OperatorCloud, type OperatorDependencies, type PairingOptions } from './operatorPairing';

/** Only supported public AWS partitions. No user/environment endpoint can enter a request. */
function destination(region: string) {
  if (/^cn-(?:north|northwest)-[1-9]$/.test(region)) return { partition: 'aws-cn', suffix: 'amazonaws.com.cn' };
  if (/^us-gov-(?:east|west)-[1-9]$/.test(region)) return { partition: 'aws-us-gov', suffix: 'amazonaws.com' };
  if (/^(?:(?:us|eu|ap|ca|sa|me|af|il|mx)-(?:central|north|south|east|west|northeast|northwest|southeast|southwest))-[1-9]$/.test(region)) {
    return { partition: 'aws', suffix: 'amazonaws.com' };
  }
  throw new Error('operator_cloud_unavailable');
}

/** Called by orchestration only AFTER exclusive private output reservation.
 * Only explicit ENV signing credentials are accepted. Never invoke the default
 * credential chain, which may read profiles or contact unpinned nested services.
 * Both service clients receive the identical frozen, non-refreshing snapshot.
 */
export async function connectOperatorAws(options: PairingOptions, policy: { maxAttempts: 1 }): Promise<OperatorCloud> {
  let dynamo: DynamoDBClient | undefined, sts: STSClient | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    // Cleanup must attempt every client even if one destroy implementation fails.
    for (const client of [sts, dynamo]) {
      try { client?.destroy(); } catch { /* Never expose SDK/provider details. */ }
    }
  };
  try {
    if (!options.execute || policy.maxAttempts !== 1 || !/^\d{12}$/.test(options.account)
      || !/^[A-Za-z0-9_.-]{3,255}$/.test(options.table)) throw new Error('operator_cloud_unavailable');
    const { partition, suffix } = destination(options.region);
    const config = { region: options.region, maxAttempts: 1, useFipsEndpoint: false, useDualstackEndpoint: false };
    const dynamoEndpoint = `https://dynamodb.${options.region}.${suffix}`;
    // Read only inside execute connect, after validation and before ANY clients.
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    const sessionToken = process.env.AWS_SESSION_TOKEN;
    if (!accessKeyId?.trim() || !secretAccessKey?.trim()
      || (sessionToken !== undefined && !sessionToken.trim())) throw new Error('operator_cloud_unavailable');
    const snapshot = Object.freeze({ accessKeyId, secretAccessKey,
      ...(sessionToken === undefined ? {} : { sessionToken }) });
    // SDK object credentials are annotated with $source. An explicit provider
    // avoids that mutation while returning only this fixed, immutable snapshot.
    const credentials = async () => snapshot;
    dynamo = new DynamoDBClient({ ...config, endpoint: dynamoEndpoint, credentials });
    sts = new STSClient({ ...config, endpoint: `https://sts.${options.region}.${suffix}`, credentials });
    const db = dynamo, identity = sts;
    const abortSignal = AbortSignal.timeout(30_000);
    const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        if (closed) throw new Error('operator_cloud_unavailable');
        return await operation();
      } catch { close(); throw new Error('operator_cloud_unavailable'); }
    };
    return {
      getCallerIdentity: () => guarded(async () => {
        const response = await identity.send(new GetCallerIdentityCommand({}), { abortSignal });
        return { Account: response.Account, Arn: response.Arn };
      }),
      describeTable: () => guarded(async () => {
        const response = await db.send(new DescribeTableCommand({
          TableName: `arn:${partition}:dynamodb:${options.region}:${options.account}:table/${options.table}`,
        }), { abortSignal });
        return { TableName: response.Table?.TableName, TableArn: response.Table?.TableArn, TableStatus: response.Table?.TableStatus };
      }),
      dynamo: { send: command => guarded(async () => {
        // Existing repository facade intersects SDK outputs. Narrow the command
        // overload here. ConsumedCapacity (whose shapes differ) is never requested.
        const response = command instanceof GetItemCommand ? await db.send(command, { abortSignal })
          : command instanceof QueryCommand ? await db.send(command, { abortSignal })
            : await db.send(command, { abortSignal });
        return response as DynamoResult;
      }) },
      close,
    };
  } catch { close(); throw new Error('operator_cloud_unavailable'); }
}

// Importing this module does not construct clients, read credentials, or touch disk.
export const operatorAwsDependencies: OperatorDependencies = {
  reserveOutput: reservePrivateOutput,
  connect: connectOperatorAws,
};
