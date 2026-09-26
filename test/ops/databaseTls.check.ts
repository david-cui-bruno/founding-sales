import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readRepositoryFile } from './support/repository.ts';

/**
 * The database refuses any connection that is not TLS (`rds.force_ssl = 1`), the `pg`
 * driver verifies the server's certificate against Node's bundled roots, and those roots
 * do not include Amazon RDS. Nothing in the tree set `ssl` on a client or `PGSSLMODE` in
 * an image, so the first process that ever reached the real database — `fss migrate`,
 * run 35876269976, 23 September 2026 — was refused at the handshake, after the two
 * earlier attempts had died before reaching it at all. The Terraform test knew the
 * parameter; nothing tied it to the images.
 *
 * So both images set `PGSSLMODE=verify-full` (encrypted, certificate verified, hostname
 * checked) and ship AWS's public RDS bundle as `NODE_EXTRA_CA_CERTS`, and this test ties
 * the three together: the parameter, the environment, and the bundle's identity.
 */

const BUNDLE = 'certs/rds-global-bundle.pem';
const BUNDLE_SHA256 = 'e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3';
const BUNDLE_CERTIFICATES = 108;

describe('TLS to the database: the parameter, the images and the bundle agree', () => {
  it('the database forces SSL, so a plain connection is refused at the handshake', () => {
    const database = readRepositoryFile('infra/modules/database/main.tf');
    expect(database).toMatch(/name\s*=\s*"rds\.force_ssl"\s*\n\s*value\s*=\s*"1"/);
  });

  for (const image of ['Dockerfile.api', 'Dockerfile.worker']) {
    it(`${image} connects with verify-full and trusts the RDS authorities`, () => {
      const dockerfile = readRepositoryFile(image);
      expect(dockerfile).toContain('PGSSLMODE=verify-full');
      expect(dockerfile).toContain('NODE_EXTRA_CA_CERTS=/app/certs/rds-global-bundle.pem');
      expect(dockerfile).toContain(`COPY ${BUNDLE} ${BUNDLE}`);
      // The images are built from a whitelist; a path the ignore file does not admit is
      // silently absent and the COPY fails only at build time.
      expect(readRepositoryFile(`${image}.dockerignore`)).toContain(`!${BUNDLE}`);
    });
  }

  it('the bundle is the one AWS publishes, whole', () => {
    const pem = readRepositoryFile(BUNDLE);
    expect(createHash('sha256').update(pem).digest('hex')).toBe(BUNDLE_SHA256);
    expect(pem.match(/-----BEGIN CERTIFICATE-----/g)?.length).toBe(BUNDLE_CERTIFICATES);
    expect(pem).not.toContain('PRIVATE KEY');
    expect(readRepositoryFile('certs/README.md')).toContain(BUNDLE_SHA256);
  });

  it('no client in the tree turns verification off', () => {
    for (const file of [
      'apps/worker/src/tools/fss.ts',
      'apps/worker/src/bootstrap/main.ts',
      'apps/api/src/bootstrap/main.ts',
      // The API's request pool is built here since lane g75.
      'apps/api/src/bootstrap/connections.ts',
      'apps/worker/src/bootstrap/config.ts',
    ]) {
      const source = readRepositoryFile(file);
      expect(source, file).not.toContain('rejectUnauthorized');
      expect(source, file).not.toMatch(/\bssl\s*:\s*false/);
      expect(source, file).not.toContain("sslmode=disable");
    }
  });
});
