/**
 * What the settings page lists when the API has not answered yet.
 *
 * The real list comes from the server (`SETTINGS_ELSEWHERE` in
 * `packages/domain/settings/elsewhere.ts`) and is rendered from the response, so a
 * slice that moves moves in one place. This is only the skeleton the page draws
 * before the first read returns, and it is deliberately short: a stale list of every
 * endpoint would be a second copy to keep correct.
 */
export const SETTINGS_ELSEWHERE_FALLBACK: readonly {
  readonly topic: string;
  readonly path: string;
  readonly ownedBy: string;
}[] = Object.freeze([]);
