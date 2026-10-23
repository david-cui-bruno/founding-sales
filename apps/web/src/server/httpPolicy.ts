/** One fixed public response policy for handler and pre-request parser refusals. */
export const BROWSER_SECURITY_HEADERS = Object.freeze({
  'cache-control': 'private, no-store',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
});
export const BROWSER_REFUSAL_BODY = '{"error":"browser_request_refused"}';
export const BROWSER_JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
