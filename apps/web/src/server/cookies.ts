import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';

export const COOKIE_NAMES = Object.freeze({ access: '__Host-callie-access', pending: '__Host-callie-pending', anonymous: '__Host-callie-csrf' });
const secret = z.string().min(32).max(4096);
export const custodySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('access'), token: secret, csrf: secret, expiresAt: z.string().datetime() }),
  z.strictObject({ kind: z.literal('pending'), state: secret, handoff: secret, expiresAt: z.string().datetime() }),
  z.strictObject({ kind: z.literal('anonymous'), csrf: secret, expiresAt: z.string().datetime() }),
]);
export type Custody = z.infer<typeof custodySchema>;
export const freshCsrf = (): string => randomBytes(32).toString('base64url');

/** Cookie name and configured origin are authenticated to prevent purpose/host substitution. */
export function sealCookie(key: Buffer, origin: string, name: string, value: Custody): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${origin}\n${name}\nv1`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(custodySchema.parse(value))), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

export function openCookie(key: Buffer, origin: string, name: string, value: string): Custody {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length > 8192) throw new Error('invalid_cookie');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length < 29 || bytes.toString('base64url') !== value) throw new Error('invalid_cookie');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(`${origin}\n${name}\nv1`));
  decipher.setAuthTag(bytes.subarray(12, 28));
  const plaintext = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
  return custodySchema.parse(JSON.parse(plaintext.toString('utf8')));
}

/** Never choose a winner among ambiguous cookie values, including unrelated duplicates. */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (header === undefined || header === '') return cookies;
  if (header.length > 16384) throw new Error('invalid_cookie');
  for (const part of header.split(';')) {
    const match = /^\s*([!#$%&'*+.^_`|~A-Za-z0-9-]+)=([\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*)\s*$/u.exec(part);
    if (match === null || cookies.has(match[1]!)) throw new Error('invalid_cookie');
    cookies.set(match[1]!, match[2]!);
  }
  return cookies;
}

export function cookieHeader(name: string, value: string, expiresAt: string): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}`;
}
export function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
