/**
 * Which permission the window's page may have (slice C1): the microphone, for a call
 * placed from Callie, asked by Callie's own page. Nothing else — no camera, no screen,
 * no notifications, no geolocation, and nothing for any other origin, which in a
 * single-window app with navigation locked down should never ask at all.
 *
 * Pure functions, so the rule is tested without Electron; `app.ts` binds them to the
 * window's session with `setPermissionRequestHandler` and `setPermissionCheckHandler`.
 */

/** Whether `url` is a page of `origin` (`callie-app://bundle`, or `file://` in development). */
function isOwnPage(url: string, origin: string): boolean {
  return url === origin || url.startsWith(`${origin}/`);
}

/**
 * `setPermissionRequestHandler`: a page asking for something now. Only `media`, only
 * audio (every requested type is `audio`, and at least one), only from our own page.
 */
export function allowPermissionRequest(input: {
  readonly permission: string;
  readonly mediaTypes?: readonly string[] | undefined;
  readonly requestingUrl: string;
  readonly ownOrigin: string;
}): boolean {
  if (input.permission !== 'media') return false;
  if (!isOwnPage(input.requestingUrl, input.ownOrigin)) return false;
  const types = input.mediaTypes ?? [];
  return types.length > 0 && types.every(type => type === 'audio');
}

/**
 * `setPermissionCheckHandler`: a page asking whether it already has something (Chromium
 * asks this before `getUserMedia`, and when enumerating devices). The same rule.
 */
export function allowPermissionCheck(input: {
  readonly permission: string;
  readonly mediaType?: string | undefined;
  readonly requestingOrigin: string;
  readonly ownOrigin: string;
}): boolean {
  if (input.permission !== 'media') return false;
  if (!isOwnPage(input.requestingOrigin, input.ownOrigin)) return false;
  return input.mediaType === 'audio';
}
