import { API_SCHEMA_RANGE } from '@fss/domain/db';
import type { LogFields } from './log.ts';

/**
 * The API's environment contract with its task definition.
 *
 * `infra/modules/cluster/main.tf` sets `FSS_ROLE=api`, `FSS_SCHEMA_MIN`,
 * `FSS_SCHEMA_MAX`, `PORT`, `FSS_HTTP_PORT` and `FSS_JOURNAL_ARN`, and injects the
 * database secret's *value* into `DATABASE_SECRET_ARN` through the ECS `secrets`
 * block. The rules are the worker's rules: read it once at startup, refuse rather than
 * guess, and name the variable without its value.
 *
 * The declared range is compared with the range the binary accepts. Under expand,
 * migrate, contract the task definition and the image are versioned separately, and a
 * disagreement means one of the two is stale.
 */

export type ApiConfigErrorCode = 'MISSING' | 'INVALID' | 'SCHEMA_RANGE_DISAGREES';

export class ApiConfigError extends Error {
  constructor(
    readonly code: ApiConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiConfigError';
  }
}

export interface ApiConfig {
  readonly role: 'api';
  readonly instanceKey: string;
  readonly port: number;
  readonly schemaRange: { readonly minimum: number; readonly maximum: number };
  readonly expectedSystemGeneration: number | null;
  readonly heartbeatIntervalMilliseconds: number;
  readonly shutdownTimeoutMilliseconds: number;
  /** Held, never logged. `describeApiConfig` is the only thing that leaves the process. */
  readonly database: { readonly connectionString: string };
}

/** `infra/modules/cluster/variables.tf` defaults `container_port` to 8080. */
export const DEFAULT_PORT = 8080;
export const DEFAULT_HEARTBEAT_INTERVAL_MILLISECONDS = 60_000;
/** The API task's ECS `stopTimeout` is 30 s; draining must finish inside it. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MILLISECONDS = 20_000;

type Environment = Readonly<Record<string, string | undefined>>;

function positiveInteger(environment: Environment, name: string, fallback: number): number {
  const raw = environment[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1) throw new ApiConfigError('INVALID', `${name} must be a positive integer`);
  return value;
}

function databaseConnection(environment: Environment): { readonly connectionString: string } {
  const url = environment['DATABASE_URL']?.trim();
  if (url !== undefined && url.length > 0) return { connectionString: url };

  const injected = environment['DATABASE_SECRET_ARN']?.trim();
  if (injected === undefined || injected.length === 0) {
    throw new ApiConfigError('MISSING', 'neither DATABASE_URL nor DATABASE_SECRET_ARN is set');
  }
  if (injected.startsWith('arn:')) {
    throw new ApiConfigError(
      'INVALID',
      'DATABASE_SECRET_ARN holds an ARN rather than the secret value; the task definition must inject it through the ECS secrets block',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(injected);
  } catch {
    throw new ApiConfigError('INVALID', 'DATABASE_SECRET_ARN is neither a Secrets Manager JSON value nor a URL');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ApiConfigError('INVALID', 'DATABASE_SECRET_ARN does not hold a JSON object');
  }
  const secret = parsed as Record<string, unknown>;
  const field = (name: string): string => {
    const value = secret[name];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number') return String(value);
    throw new ApiConfigError('INVALID', `DATABASE_SECRET_ARN does not carry ${name}`);
  };
  const user = encodeURIComponent(field('username'));
  const password = encodeURIComponent(field('password'));
  return {
    connectionString: `postgresql://${user}:${password}@${field('host')}:${field('port')}/${field('dbname')}`,
  };
}

export function readApiConfig(environment: Environment): ApiConfig {
  const role = (environment['FSS_ROLE'] ?? 'api').trim();
  if (role !== 'api') throw new ApiConfigError('INVALID', 'FSS_ROLE is not api');

  const declaredMinimum = environment['FSS_SCHEMA_MIN']?.trim();
  const declaredMaximum = environment['FSS_SCHEMA_MAX']?.trim();
  if (declaredMinimum === undefined || declaredMaximum === undefined) {
    throw new ApiConfigError('MISSING', 'FSS_SCHEMA_MIN and FSS_SCHEMA_MAX are not set');
  }
  if (Number(declaredMinimum) !== API_SCHEMA_RANGE.minimum || Number(declaredMaximum) !== API_SCHEMA_RANGE.maximum) {
    throw new ApiConfigError(
      'SCHEMA_RANGE_DISAGREES',
      `FSS_SCHEMA_MIN and FSS_SCHEMA_MAX do not match the range this image accepts (${String(API_SCHEMA_RANGE.minimum)}-${String(API_SCHEMA_RANGE.maximum)})`,
    );
  }

  const expected = environment['FSS_EXPECTED_SYSTEM_GENERATION']?.trim();
  if (expected !== undefined && expected.length > 0 && (!Number.isInteger(Number(expected)) || Number(expected) < 1)) {
    throw new ApiConfigError('INVALID', 'FSS_EXPECTED_SYSTEM_GENERATION must be a positive integer');
  }

  const hostname = environment['HOSTNAME']?.trim();
  return {
    role: 'api',
    instanceKey: (environment['FSS_API_INSTANCE']?.trim() ?? (hostname !== undefined && hostname.length > 0 ? `api-${hostname}` : 'api')).slice(0, 120),
    port: positiveInteger(environment, 'PORT', positiveInteger(environment, 'FSS_HTTP_PORT', DEFAULT_PORT)),
    schemaRange: { minimum: API_SCHEMA_RANGE.minimum, maximum: API_SCHEMA_RANGE.maximum },
    expectedSystemGeneration: expected !== undefined && expected.length > 0 ? Number(expected) : null,
    heartbeatIntervalMilliseconds: positiveInteger(
      environment,
      'FSS_API_HEARTBEAT_MS',
      DEFAULT_HEARTBEAT_INTERVAL_MILLISECONDS,
    ),
    shutdownTimeoutMilliseconds: positiveInteger(
      environment,
      'FSS_API_SHUTDOWN_TIMEOUT_MS',
      DEFAULT_SHUTDOWN_TIMEOUT_MILLISECONDS,
    ),
    database: databaseConnection(environment),
  };
}

/** The startup line: every decision, and nothing that could be a credential. */
export function describeApiConfig(config: ApiConfig): LogFields {
  return {
    role: config.role,
    instance: config.instanceKey,
    port: config.port,
    schemaRange: `${String(config.schemaRange.minimum)}-${String(config.schemaRange.maximum)}`,
    expectedSystemGeneration: config.expectedSystemGeneration,
    heartbeatIntervalMilliseconds: config.heartbeatIntervalMilliseconds,
  };
}
