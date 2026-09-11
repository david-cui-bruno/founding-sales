import { execFileSync } from 'node:child_process';

export interface ResolveMacSigningIdentityOptions {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  listCodesigningIdentities?: () => string;
}

const IDENTITY_PREFERENCE = [
  'Developer ID Application:',
  'Apple Development:',
] as const;

const defaultListCodesigningIdentities = (): string =>
  execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
  });

const quotedIdentities = (listing: string): string[] => {
  const identities: string[] = [];
  for (const line of listing.split('\n')) {
    const match = /^\s*\d+\)\s+[0-9A-F]+\s+"(.+)"\s*$/i.exec(line);
    if (match !== null) {
      identities.push(match[1]);
    }
  }
  return identities;
};

/**
 * Resolves the macOS code-signing identity for local packaging.
 *
 * An exact CALLIE_MAC_SIGN_IDENTITY='-' selects the existing ad-hoc path
 * without querying signing credentials. Other explicit non-blank values win.
 * Otherwise the login keychain is queried and the most distribution-capable identity is
 * selected so repeated local builds keep a stable code identity and macOS
 * Keychain "Always Allow" grants survive rebuilds. Returns undefined off
 * macOS or when no usable identity exists, which falls back to ad-hoc
 * signing exactly as before.
 */
export const resolveMacSigningIdentity = ({
  env,
  platform,
  listCodesigningIdentities = defaultListCodesigningIdentities,
}: ResolveMacSigningIdentityOptions): string | undefined => {
  const explicit = env.CALLIE_MAC_SIGN_IDENTITY;
  if (explicit === '-') {
    return undefined;
  }
  if (explicit !== undefined && explicit.trim().length > 0) {
    return explicit;
  }

  if (platform !== 'darwin') {
    return undefined;
  }

  let listing: string;
  try {
    listing = listCodesigningIdentities();
  } catch {
    return undefined;
  }

  const identities = quotedIdentities(listing);
  for (const prefix of IDENTITY_PREFERENCE) {
    const found = identities.find((identity) => identity.startsWith(prefix));
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
};
