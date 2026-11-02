import {z} from 'zod';

/**
 * Keyless AWS -> GCP access for qualification (David, 1 November 2026): the worker's ECS task
 * role is exchanged, through a Google workload identity pool that trusts only that role, for a
 * short-lived token of the `callie-qualification` service account (roles/aiplatform.user).
 * No Google key exists anywhere; `infra/scripts/gcp-vertex-qualification-setup.sh` creates the
 * pool, and the non-secret `external_account` configuration below reaches the worker as
 * `FSS_VERTEX_CREDENTIAL_CONFIG` (Terraform, `infra/modules/stack`).
 *
 * `google-auth-library`'s AWS client signs the STS GetCallerIdentity request and performs the
 * exchange and impersonation. Its own credential sources are environment variables and EC2
 * metadata, neither of which a Fargate task has (it has the container credentials endpoint),
 * so the AWS SDK's default provider chain, the one the Bedrock client uses, supplies them.
 */
const GOOGLE_CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** Only the fields that identify the federation; `credential_source` is ignored (the supplier replaces it). */
export const vertexCredentialConfigSchema = z.object({
  type: z.literal('external_account'),
  audience: z.string().regex(/^\/\/iam\.googleapis\.com\/projects\/\d{4,20}\/locations\/global\/workloadIdentityPools\/[a-z][a-z0-9-]{2,30}[a-z0-9]\/providers\/[a-z][a-z0-9-]{2,30}[a-z0-9]$/u),
  subject_token_type: z.literal('urn:ietf:params:aws:token-type:aws4_request'),
  service_account_impersonation_url: z.string().regex(/^https:\/\/iamcredentials\.googleapis\.com\/v1\/projects\/-\/serviceAccounts\/[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com:generateAccessToken$/u),
  token_url: z.literal('https://sts.googleapis.com/v1/token').optional(),
});
export type VertexCredentialConfig = z.infer<typeof vertexCredentialConfigSchema>;

export interface AwsIdentity {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string | undefined;
}

/** What `AwsClient` asks of a supplier: the region, and credentials it does not cache itself. */
export interface AwsSecurityCredentialsSupplier {
  getAwsRegion(): Promise<string>;
  getAwsSecurityCredentials(): Promise<{accessKeyId: string; secretAccessKey: string; token?: string}>;
}

export function awsSecurityCredentialsSupplier(region: string, credentials: () => Promise<AwsIdentity>): AwsSecurityCredentialsSupplier {
  return {
    getAwsRegion: async () => region,
    getAwsSecurityCredentials: async () => {
      const identity = await credentials();
      if (!identity.accessKeyId || !identity.secretAccessKey) throw new Error('aws_credentials_incomplete');
      return {accessKeyId: identity.accessKeyId, secretAccessKey: identity.secretAccessKey, ...(identity.sessionToken ? {token: identity.sessionToken} : {})};
    },
  };
}

/** A GCP OAuth access token for the federated service account; the library caches it until shortly before expiry. */
export interface AccessTokenSource {
  token(): Promise<string>;
}

/** The federation endpoints; the real ones are `VertexCredentialConfig`'s, a test points them at a local server. */
export interface FederationEndpoints {
  readonly audience: string;
  readonly tokenUrl: string;
  readonly serviceAccountImpersonationUrl: string;
}

/**
 * The federated token source over a supplier of AWS credentials. `google-auth-library` is
 * imported on demand, as the Bedrock client loads its SDK, so it is not in the static graph of
 * the API, the CLI tools or a test that never reaches Vertex.
 */
export async function awsFederatedTokenSource(endpoints: FederationEndpoints, supplier: AwsSecurityCredentialsSupplier): Promise<AccessTokenSource> {
  const {AwsClient} = await import('google-auth-library');
  const client = new AwsClient({
    type: 'external_account',
    audience: endpoints.audience,
    subject_token_type: 'urn:ietf:params:aws:token-type:aws4_request',
    token_url: endpoints.tokenUrl,
    service_account_impersonation_url: endpoints.serviceAccountImpersonationUrl,
    scopes: [GOOGLE_CLOUD_PLATFORM_SCOPE],
    aws_security_credentials_supplier: supplier,
  });
  return {
    token: async () => {
      const {token} = await client.getAccessToken();
      if (!token) throw new Error('google_access_token_unavailable');
      return token;
    },
  };
}

/** The production source: the task role's credentials from the AWS SDK's default provider chain (ECS container credentials). */
export async function loadAwsFederatedTokenSource(config: VertexCredentialConfig, region: string): Promise<AccessTokenSource> {
  const {defaultProvider} = await import('@aws-sdk/credential-provider-node');
  return await awsFederatedTokenSource({
    audience: config.audience,
    tokenUrl: config.token_url ?? 'https://sts.googleapis.com/v1/token',
    serviceAccountImpersonationUrl: config.service_account_impersonation_url,
  }, awsSecurityCredentialsSupplier(region, defaultProvider()));
}
