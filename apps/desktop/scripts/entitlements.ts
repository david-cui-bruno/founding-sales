/**
 * The entitlements the app is signed with, and the ones it must never be signed
 * with (G13a deliverable 1: "hardened runtime and the entitlements the app needs,
 * no more").
 *
 * Callie is a Developer ID app, not a Mac App Store app, so it is not sandboxed and
 * the `com.apple.security.*` sandbox entitlements would say nothing. What it is is
 * hardened, and the hardened runtime blocks writable-executable memory — which V8
 * needs. That is the one exception, and it is the whole list.
 *
 * The forbidden list is the other half. Each of those entitlements turns off a part
 * of the hardened runtime, several of them are copied into Electron projects as
 * cargo cult, and one of them (`get-task-allow`) makes a build that cannot be
 * notarized at all. The verifier refuses a bundle carrying any of them, so adding
 * one is a deliberate change to this file rather than something that arrives with a
 * dependency's suggested configuration.
 */

export const DESKTOP_ENTITLEMENTS: Readonly<Record<string, boolean>> = Object.freeze({
  'com.apple.security.cs.allow-jit': true,
});

export const FORBIDDEN_ENTITLEMENTS: readonly string[] = Object.freeze([
  'com.apple.security.cs.allow-dyld-environment-variables',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.debugger',
  'com.apple.security.cs.disable-executable-page-protection',
  'com.apple.security.cs.disable-library-validation',
  'com.apple.security.get-task-allow',
]);

export function renderEntitlementsPlist(entitlements: Readonly<Record<string, boolean>>): string {
  const body = Object.keys(entitlements)
    .sort()
    .map(key => `\t<key>${escapeXml(key)}</key>\n\t<${entitlements[key] === true ? 'true' : 'false'}/>`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    body,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/**
 * Read back the entitlements `codesign -d --entitlements - --xml` prints.
 *
 * Deliberately small: only boolean entries are understood, because only boolean
 * entries are allowed. An entitlement with a string or array value — an application
 * group, a keychain access group — is reported as present and `true`, so the
 * comparison below calls it unexpected rather than quietly ignoring it.
 */
export function parseEntitlementsPlist(xml: string): Record<string, boolean> {
  const dictionary = /<dict>([\s\S]*)<\/dict>/.exec(xml);
  if (dictionary === null) return {};
  const found: Record<string, boolean> = {};
  const entry = /<key>([^<]+)<\/key>\s*(?:<(true|false)\s*\/>|<([a-z]+)>)/g;
  let match = entry.exec(dictionary[1] ?? '');
  while (match !== null) {
    const key = unescapeXml(match[1] ?? '');
    found[key] = match[2] === undefined ? true : match[2] === 'true';
    match = entry.exec(dictionary[1] ?? '');
  }
  return found;
}

export type EntitlementComparison =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly unexpected: readonly string[];
      readonly missing: readonly string[];
      readonly forbidden: readonly string[];
    };

export function compareEntitlements(found: Readonly<Record<string, boolean>>): EntitlementComparison {
  const granted = Object.keys(found).filter(key => found[key] === true);
  const forbidden = granted.filter(key => FORBIDDEN_ENTITLEMENTS.includes(key)).sort();
  const unexpected = granted
    .filter(key => !(key in DESKTOP_ENTITLEMENTS) && !FORBIDDEN_ENTITLEMENTS.includes(key))
    .sort();
  const missing = Object.keys(DESKTOP_ENTITLEMENTS)
    .filter(key => found[key] !== true)
    .sort();
  if (forbidden.length === 0 && unexpected.length === 0 && missing.length === 0) return { ok: true };
  return { ok: false, unexpected, missing, forbidden };
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function unescapeXml(value: string): string {
  return value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}
