/** One fixed policy for handler and parser refusals. Bundled Voice SDK scripts stay
 * self-only. These exact default-edge media/signalling hosts follow the authenticated
 * API and official twilio-voice.js CSP documentation. No wildcard
 * or provider SDK download is allowed. Microphone still needs a user gesture and
 * browser permission; this header does not enable a call or mint credentials. */
export const BROWSER_SECURITY_HEADERS = Object.freeze({
  'cache-control': 'private, no-store',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https://eventgw.twilio.com wss://voice-js.roaming.twilio.com https://media.twiliocdn.com https://sdk.twilio.com; media-src 'self' mediastream: blob: https://media.twiliocdn.com https://sdk.twilio.com; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(self), geolocation=()',
});
export const BROWSER_REFUSAL_BODY = '{"error":"browser_request_refused"}';
export const BROWSER_JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
