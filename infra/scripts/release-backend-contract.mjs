// Source-only production backend contract. This never inspects credentials or AWS.
import { readFileSync, readdirSync } from 'node:fs';

export const ACCOUNT = '326255650484';
export const REGION = 'us-east-1';
export const BUCKET = `callie-sourcing-tfstate-${ACCOUNT}`;
export const KEY = 'fss/greenfield/production/terraform.tfstate';
export const STATE = `arn:aws:s3:::${BUCKET}/${KEY}`;
export const LOCK = `${STATE}.tflock`;
export const TABLE = `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/callie-sourcing-tflock`;
export const ROW = `${BUCKET}/${KEY}`;
export const ROLE = `arn:aws:iam::${ACCOUNT}:role/fss-prod-deploy`;
const list = value => Array.isArray(value) ? value : [value];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = reason => { throw new Error(`backend_${reason}`); };
const matches = (pattern, value, action = false) => typeof pattern === 'string' && new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*').replace(/\?/gu, '.')}$`, action ? 'iu' : 'u').test(value);

export function backendPolicy(stage) {
  if (!['prepare', 'execute', 'local-plan'].includes(stage)) fail('stage_not_supported');
  const apply = stage === 'execute';
  const allow = (Sid, Action, Resource, Condition) => ({ Sid, Effect: 'Allow', Action, Resource: [Resource], ...(Condition ? { Condition } : {}) });
  const rows = keys => ({ 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': keys } });
  return { Version: '2012-10-17', Statement: [
    allow('BackendState', apply ? ['s3:GetObject', 's3:PutObject'] : ['s3:GetObject'], STATE),
    allow('BackendNativeLock', ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], LOCK),
    allow('BackendList', ['s3:ListBucket'], `arn:aws:s3:::${BUCKET}`, { StringEquals: { 's3:prefix': [KEY, `${KEY}.tflock`] } }),
    allow('BackendTable', ['dynamodb:DescribeTable'], TABLE),
    allow('BackendLockRow', ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem'], TABLE, rows([ROW])),
    allow('BackendChecksum', apply ? ['dynamodb:GetItem', 'dynamodb:PutItem'] : ['dynamodb:GetItem'], TABLE, rows([`${ROW}-md5`])),
  ] };
}

export function stageMapping(stage) {
  if (stage === 'prepare') return { backend: `arn:aws:iam::${ACCOUNT}:role/fss-prod-ci-plan`, provider: `arn:aws:iam::${ACCOUNT}:role/fss-prod-ci-plan`, assumeDeploymentRole: false, environment: 'production-plan', credential: 'FSS_PRODUCTION_PLAN_ROLE_ARN' };
  if (stage === 'execute') return { backend: ROLE, provider: ROLE, assumeDeploymentRole: false, environment: 'production-release-review', credential: 'FSS_PRODUCTION_REVIEWED_ROLE_ARN' };
  if (stage === 'local-plan') return { backend: 'separately approved human ambient identity, not provider assumption', provider: ROLE, assumeDeploymentRole: true, environment: null, credential: 'explicitly approved local AWS credential chain' };
  if (stage === 'app-only' || stage === 'maintenance') return { backend: null, provider: null, initializeTerraform: false };
  fail('stage_not_supported');
}

// Only the checked-in, exact backend is accepted. No optional KMS path or hidden CLI args.
export function validateConfiguration(stage, { env = process.env, backend = readFileSync('infra/roots/production/backend.hcl', 'utf8'), provider = readFileSync('infra/roots/production/providers.tf', 'utf8'), variables = { assume_deployment_role: stage === 'local-plan' } } = {}) {
  const mapping = stageMapping(stage);
  if (!['prepare', 'execute', 'local-plan'].includes(stage)) fail('stage_not_supported');
  for (const key of Object.keys(env)) {
    if (/^TF_CLI_ARGS(?:_|$)|^TF_(?:DATA_DIR|WORKSPACE|CLI_CONFIG_FILE)$|^TF_VAR_|^AWS_(?:ENDPOINT_URL|S3_ENDPOINT|DYNAMODB_ENDPOINT|KMS_ENDPOINT|ROLE_ARN|WEB_IDENTITY_TOKEN_FILE|CONFIG_FILE|SHARED_CREDENTIALS_FILE|PROFILE|DEFAULT_PROFILE|USE_FIPS_ENDPOINT|USE_DUALSTACK_ENDPOINT)/u.test(key) && env[key] !== undefined) fail('hidden_configuration');
  }
  if ((env.AWS_REGION && env.AWS_REGION !== REGION) || (env.AWS_DEFAULT_REGION && env.AWS_DEFAULT_REGION !== REGION) || (env.FSS_PRODUCTION_ACCOUNT_ID && env.FSS_PRODUCTION_ACCOUNT_ID !== ACCOUNT)) fail('scope_changed');
  const root = 'infra/roots/production';
  if (readdirSync(root).some(file => /(?:^terraform\.tfvars(?:\.json)?$|\.auto\.tfvars(?:\.json)?$|_override\.tf(?:\.json)?$|^override\.tf(?:\.json)?$)/u.test(file))) fail('hidden_configuration');
  const versions = readFileSync(`${root}/versions.tf`, 'utf8').replace(/#[^\n]*/gu, '');
  if (!/backend\s+"s3"\s*\{\s*\}/u.test(versions) || (versions.match(/backend\s+"/gu) || []).length !== 1) fail('configuration_changed');
  const locals = readFileSync(`${root}/main.tf`, 'utf8').replace(/#[^\n]*/gu, '');
  for (const [key, value] of Object.entries({ aws_account_id: ACCOUNT, aws_region: REGION, name_prefix: 'fss-prod', deployment_role_name: 'fss-prod-deploy' })) {
    const declarations = [...locals.matchAll(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"\\s*$`, 'gmu'))];
    if (declarations.length !== 1 || declarations[0][1] !== value) fail('scope_changed');
  }
  const expected = { bucket: BUCKET, key: KEY, region: REGION, dynamodb_table: 'callie-sourcing-tflock', encrypt: true, use_lockfile: true };
  const parsed = {};
  for (const line of backend.split('\n')) {
    const clean = line.replace(/#.*/u, '').trim();
    if (!clean) continue;
    const match = /^(\w+)\s*=\s*("[^"]*"|true|false)$/u.exec(clean);
    if (!match || Object.hasOwn(parsed, match[1])) fail('configuration_changed');
    parsed[match[1]] = JSON.parse(match[2]);
  }
  if (Object.keys(parsed).length !== Object.keys(expected).length || Object.entries(expected).some(([key, value]) => parsed[key] !== value)) fail('configuration_changed');
  const providerSource = provider.replace(/#[^\n]*/gu, '');
  if (variables.assume_deployment_role !== mapping.assumeDeploymentRole || !providerSource.includes('for_each = var.assume_deployment_role ? [1] : []') || !providerSource.includes('role_arn     = "arn:aws:iam::${local.aws_account_id}:role/${local.deployment_role_name}"') || (providerSource.match(/role_arn\s*=/gu) || []).length !== 1 || !/allowed_account_ids\s*=\s*\[local.aws_account_id\]/u.test(providerSource) || !/region\s*=\s*local.aws_region/u.test(providerSource)) fail('provider_mapping_changed');
  const sourcePolicy = JSON.parse(readFileSync('infra/policies/production-backend-plan.json', 'utf8'));
  validatePolicy(sourcePolicy, 'prepare');
  if (!same(sourcePolicy, backendPolicy('prepare'))) fail('source_policy_changed');
  return { ...mapping, encryption: 'SSE-S3', kmsKeyId: null, bucket: BUCKET, key: KEY, region: REGION };
}

// A conservative model, not IAM simulation: unsupported conditions on relevant rights
// refuse rather than guessing. Unrelated rights are retained, never re-rendered.
function applies(statement, action, resource, context) {
  const actionMatch = statement.Action ? list(statement.Action).some(pattern => matches(pattern, action, true)) : statement.NotAction ? !list(statement.NotAction).some(pattern => matches(pattern, action, true)) : false;
  const resourceMatch = statement.Resource ? list(statement.Resource).some(pattern => matches(pattern, resource)) : statement.NotResource ? !list(statement.NotResource).some(pattern => matches(pattern, resource)) : false;
  if (!actionMatch || !resourceMatch) return false;
  for (const [operator, entries] of Object.entries(statement.Condition || {})) {
    for (const [key, values] of Object.entries(entries)) {
      if (!['StringEquals', 'StringLike', 'ForAllValues:StringEquals'].includes(operator) || !['s3:prefix', 'dynamodb:LeadingKeys'].includes(key)) fail('unsupported_relevant_condition');
      if (!context[key] || !list(context[key]).every(value => list(values).some(pattern => operator === 'StringLike' ? matches(pattern, value) : pattern === value))) return false;
    }
  }
  return true;
}

export function validatePolicy(policy, stage) {
  if (policy?.Version !== '2012-10-17' || !Array.isArray(policy.Statement) || policy.Statement.some(s => !['Allow', 'Deny'].includes(s.Effect))) fail('policy_shape');
  for (const s of policy.Statement) {
    if (Object.keys(s).some(key => !['Sid', 'Effect', 'Action', 'NotAction', 'Resource', 'NotResource', 'Condition'].includes(key)) || Boolean(s.Action) === Boolean(s.NotAction) || Boolean(s.Resource) === Boolean(s.NotResource)) fail('policy_shape');
    for (const key of ['Action', 'NotAction', 'Resource', 'NotResource']) if (s[key] !== undefined && (!list(s[key]).length || list(s[key]).some(value => typeof value !== 'string' || !value))) fail('policy_shape');
    if (s.Effect !== 'Allow') continue;
    const candidates = backendPolicy(stage).Statement;
    for (const required of candidates) {
      const resource = required.Resource[0];
      const actionTouches = s.NotAction || list(s.Action).some(pattern => required.Action.some(action => matches(pattern, action, true)));
      const resourceTouches = s.NotResource || list(s.Resource).some(pattern => matches(pattern, resource));
      if (!actionTouches || !resourceTouches) continue;
      if (s.NotAction || s.NotResource || list(s.Resource).some(value => ![STATE, LOCK, TABLE, `arn:aws:s3:::${BUCKET}`].includes(value)) || list(s.Action).some(value => /[?*]/u.test(value))) fail('permission_scope');
      if (resource === TABLE && required.Sid !== 'BackendTable' && !same(s.Condition?.['ForAllValues:StringEquals']?.['dynamodb:LeadingKeys'], required.Condition['ForAllValues:StringEquals']['dynamodb:LeadingKeys'])) {
        // A separate checksum statement and lock statement must not share write scope.
        const keys = s.Condition?.['ForAllValues:StringEquals']?.['dynamodb:LeadingKeys'];
        if (!same(keys, [ROW]) && !same(keys, [`${ROW}-md5`])) fail('permission_scope');
      }
      if (resource === `arn:aws:s3:::${BUCKET}` && !same(s.Condition, required.Condition)) fail('permission_scope');
    }
  }
  const decision = (action, resource, context = {}) => {
    const applicable = policy.Statement.filter(s => applies(s, action, resource, context));
    return applicable.some(s => s.Effect === 'Allow') && !applicable.some(s => s.Effect === 'Deny');
  };
  const required = backendPolicy(stage);
  for (const statement of required.Statement) {
    const context = statement.Condition ? Object.values(statement.Condition)[0] : {};
    for (const action of statement.Action) if (!decision(action, statement.Resource[0], context)) fail('required_permission_denied');
  }
  if (decision('s3:DeleteObject', STATE) || (stage !== 'execute' && (decision('s3:PutObject', STATE) || decision('dynamodb:PutItem', TABLE, { 'dynamodb:LeadingKeys': [`${ROW}-md5`] }))) || decision('dynamodb:DeleteItem', TABLE, { 'dynamodb:LeadingKeys': [`${ROW}-md5`] })) fail('excess_state_permission');
  return true;
}

export function proposeExistingPolicy(baseline) {
  if (baseline?.roleArn !== ROLE || baseline.policyName !== 'fss-prod-deploy-scope') fail('baseline_identity');
  const original = baseline.policy;
  if (original?.Version !== '2012-10-17' || !Array.isArray(original.Statement) || original.Statement.some(s => !s.Sid || !['Allow', 'Deny'].includes(s.Effect)) || new Set(original.Statement.map(s => s.Sid)).size !== original.Statement.length) fail('baseline_shape');
  const deny = original.Statement.find(s => s.Sid === 'NoDeploymentDataAccess');
  if (!deny || deny.Effect !== 'Deny' || !same(list(deny.Resource), ['*']) || deny.Condition || deny.NotResource || deny.NotAction || !list(deny.Action).includes('s3:GetObject*') || Object.keys(deny).some(key => !['Sid', 'Effect', 'Action', 'Resource'].includes(key))) fail('baseline_explicit_deny_shape');
  const addition = backendPolicy('execute').Statement;
  if (original.Statement.some(s => addition.some(a => a.Sid === s.Sid) || s.Sid === 'BackendReadDenyOutsideExactObjects')) fail('baseline_sid_collision');
  // Carving the wildcard deny must not activate previously denied ACL/version/etc.
  // rights on the two objects. Refuse that unfamiliar baseline rather than narrowing
  // unrelated pre-existing rights or guessing the complete evolving S3 action list.
  for (const s of original.Statement.filter(s => s.Effect === 'Allow')) {
    const touchesObjects = s.NotResource || list(s.Resource).some(resource => matches(resource, STATE) || matches(resource, LOCK));
    const unsafeRead = action => typeof action === 'string' && action.toLowerCase() !== 's3:getobject' && (action.toLowerCase().startsWith('s3:getobject') || (/[?*]/u.test(action) && matches(action.split(':')[0], 's3', true)));
    if (touchesObjects && (s.NotAction || list(s.Action).some(unsafeRead))) fail('baseline_read_scope');
  }
  const remaining = list(deny.Action).filter(action => action !== 's3:GetObject*');
  const policy = structuredClone(original);
  const index = policy.Statement.findIndex(s => s.Sid === deny.Sid);
  const replacement = { Sid: remaining.length ? 'BackendReadDenyOutsideExactObjects' : deny.Sid, Effect: 'Deny', Action: ['s3:GetObject*'], NotResource: [STATE, LOCK] };
  policy.Statement.splice(index, 1, ...(remaining.length ? [{ ...deny, Action: remaining }, replacement] : [replacement]));
  policy.Statement.push(...addition);
  validatePolicy(policy, 'execute');
  if (JSON.stringify(policy).length > 10240) fail('inline_policy_size');
  return { version: 'fss.backend-policy-proposal.v1', operationalApproval: false, baseline: structuredClone(baseline), proposed: { ...structuredClone(baseline), policy }, scope: { state: STATE, lock: LOCK, table: TABLE }, warnings: ['Source proposal only. Review actual trust, attachments, boundaries, session and resource policies and encryption under separate approval. Never replace the historical role with the prospective template.'] };
}
