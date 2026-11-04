// Metadata only. Never resolve credentials or include rejected input in errors.
const invalid = () => { throw new Error('founder_browser_configuration_invalid'); };
const required = ['origin', 'clientVersion', 'founderWorkspaceId', 'founderUserId', 'cookieKeySecretArn'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function founderBrowserConfiguration(raw, baselineDefinition) {
  // An unknown baseline cannot establish that disabling hosting is safe.
  if (!Array.isArray(baselineDefinition?.containerDefinitions) || baselineDefinition.containerDefinitions.length === 0) invalid();
  const enabled = baselineDefinition.containerDefinitions.some(container =>
    [...(container.environment || []), ...(container.secrets || [])].some(entry => typeof entry.name === 'string' && entry.name.startsWith('FSS_BROWSER_')));
  if (raw === undefined || raw === '') {
    if (enabled) throw new Error('founder_browser_configuration_required');
    return null;
  }
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 4096) invalid();
  let value;
  try { value = JSON.parse(raw); } catch { invalid(); }
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
      Object.keys(value).some(key => ![...required, 'certificateArn'].includes(key)) ||
      required.some(key => typeof value[key] !== 'string') ||
      (Object.hasOwn(value, 'certificateArn') && typeof value.certificateArn !== 'string')) invalid();
  let origin;
  try { origin = new URL(value.origin); } catch { invalid(); }
  if (origin.protocol !== 'https:' || origin.origin !== value.origin || origin.username || origin.password ||
      !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(origin.hostname) ||
      !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(value.clientVersion) ||
      !uuid.test(value.founderWorkspaceId) || !uuid.test(value.founderUserId) ||
      !/^arn:aws:secretsmanager:us-east-1:326255650484:secret:fss-prod\/browser-cookie-key-[A-Za-z0-9]{6}$/u.test(value.cookieKeySecretArn) ||
      (Object.hasOwn(value, 'certificateArn') && !/^arn:aws:acm:us-east-1:326255650484:certificate\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value.certificateArn))) invalid();
  return value;
}

// Bind host provisioning to the reviewed plan without putting credential values
// in Terraform. Missing metadata must not destroy a staged or active host.
export function socialPublisherConfiguration(raw, baselineDefinition, state) {
  const invalidPublisher = () => { throw new Error('social_publisher_configuration_invalid'); };
  if (!Array.isArray(baselineDefinition?.containerDefinitions) || baselineDefinition.containerDefinitions.length === 0 ||
      !Array.isArray(state?.resources)) invalidPublisher();
  const deployed = state.resources.some(resource => resource.mode === 'managed' &&
    resource.module === 'module.stack.module.social_publisher[0]') ||
    baselineDefinition.containerDefinitions.some(container =>
      [...(container.environment || []), ...(container.secrets || [])].some(entry =>
        typeof entry.name === 'string' && entry.name.startsWith('FSS_SOCIAL_PUBLISHER_')));
  if (raw === undefined || raw === '') {
    if (deployed) throw new Error('social_publisher_configuration_required');
    return { social_publisher_host: null, social_publisher_runtime_ready: false };
  }
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 2048) invalidPublisher();
  let value;
  try { value = JSON.parse(raw); } catch { invalidPublisher(); }
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
      Object.keys(value).some(key => !['amiId', 'runtimeReady'].includes(key)) ||
      typeof value.amiId !== 'string' || !/^ami-[0-9a-f]{17}$/u.test(value.amiId) ||
      typeof value.runtimeReady !== 'boolean') invalidPublisher();
  return { social_publisher_host: { ami_id: value.amiId }, social_publisher_runtime_ready: value.runtimeReady };
}
