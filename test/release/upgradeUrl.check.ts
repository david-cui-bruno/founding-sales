import { describe, expect, it } from 'vitest';
import {
  DEPLOYMENT_ENVIRONMENT_VARIABLES,
  DeploymentConfigError,
  readUpgradeUrl,
} from '../../apps/api/src/bootstrap/deployment.ts';
import { DEFAULT_UPGRADE_URL } from '../../apps/api/src/routes/types.ts';
import { CHANNEL_MANIFEST_PATH } from '../../apps/desktop/src/main/updateChannel.ts';
import { readRepositoryFile } from './support/coverage.ts';

/**
 * The upgrade notice names the update channel in production, and only there (lane g86).
 *
 * `/auth/client-version` published `https://callie.example/downloads/mac` from every
 * deployment. Four places now have to agree: the variable the API reads, the stack
 * that puts it on the API task definition alone, the production root that supplies it
 * and refuses a bad one, and the path the desktop reads its signed manifest from. Each
 * is read from where it is enforced.
 *
 * ## The vacuous-pass traps, named
 *
 * A root whose default is the right string but whose validation accepts anything would
 * pass a check of the default alone, so the validation's two clauses are evaluated here
 * against the placeholder, a blank, plain http and a signed URL, and must refuse each.
 * A stack that put the variable in the shared environment would pass a check that the
 * API has it, so the worker's block is required not to. And a default that pointed at
 * a path the desktop does not read would pass both, so its path is compared with
 * `CHANNEL_MANIFEST_PATH`.
 */

const NAME = DEPLOYMENT_ENVIRONMENT_VARIABLES.upgradeUrl;
const ROOT_VARIABLES = readRepositoryFile('infra/roots/production/variables.tf');
const ROOT_MAIN = readRepositoryFile('infra/roots/production/main.tf');
const REHEARSAL_VARIABLES = readRepositoryFile('infra/roots/rehearsal/variables.tf');
const REHEARSAL_MAIN = readRepositoryFile('infra/roots/rehearsal/main.tf');
const STACK = readRepositoryFile('infra/modules/stack/main.tf');

function block(text: string, header: string): string {
  const start = text.indexOf(header);
  expect(start, `no ${header}`).toBeGreaterThan(-1);
  return text.slice(start, text.indexOf('\n}\n', start) + 2);
}

const variable = block(ROOT_VARIABLES, 'variable "desktop_upgrade_url" {');
const productionDefault = /\n {2}default {5,}= "([^"]+)"\n/u.exec(variable)?.[1] ?? '';
const pattern = /can\(regex\("([^"]+)", var\.desktop_upgrade_url\)\)/u.exec(variable)?.[1] ?? '';

/** The production root's validation, both clauses, evaluated as Terraform would. */
function rootAccepts(value: string): boolean {
  return new RegExp(pattern.replaceAll('\\\\', '\\'), 'u').test(value) && !value.includes('callie.example');
}

describe('the upgrade notice address', () => {
  it('is read by the API under one name, which only the API task definition carries', () => {
    expect(NAME).toBe('FSS_DESKTOP_UPGRADE_URL');
    expect(STACK).toContain(
      '  api_environment = var.desktop_upgrade_url == null ? {} : {\n    FSS_DESKTOP_UPGRADE_URL = var.desktop_upgrade_url\n  }\n',
    );
    const worker = STACK.slice(STACK.indexOf('  worker_environment = {'), STACK.indexOf('  }\n', STACK.indexOf('  worker_environment = {')));
    expect(worker).not.toContain(NAME);
    const shared = block(STACK, '  environment = merge(var.extra_environment, {');
    expect(shared).not.toContain(NAME);
  });

  it('is the signed manifest the desktop reads, in production, and passes the API’s own rule there', () => {
    expect(ROOT_MAIN).toContain('\n  desktop_upgrade_url = var.desktop_upgrade_url\n');
    expect(productionDefault.startsWith('https://')).toBe(true);
    expect(productionDefault.endsWith(`/${CHANNEL_MANIFEST_PATH}`)).toBe(true);
    expect(variable).toContain('nullable    = false');
    expect(readUpgradeUrl({ FSS_ENVIRONMENT: 'production', [NAME]: productionDefault })).toEqual({
      value: productionDefault,
      source: 'environment',
    });
  });

  it('is refused by the production root when it is blank, not plain https, or the placeholder', () => {
    expect(pattern.length).toBeGreaterThan(0);
    expect(rootAccepts(productionDefault)).toBe(true);
    for (const bad of [
      '',
      DEFAULT_UPGRADE_URL,
      productionDefault.replace('https://', 'http://'),
      `${productionDefault}?X-Amz-Signature=abc`,
      `https://someone@${productionDefault.slice('https://'.length)}`,
    ]) {
      expect(rootAccepts(bad), bad).toBe(false);
    }
    // And the API refuses the placeholder in production by itself, the second line.
    expect(() => readUpgradeUrl({ FSS_ENVIRONMENT: 'production', [NAME]: DEFAULT_UPGRADE_URL })).toThrow(DeploymentConfigError);
    expect(() => readUpgradeUrl({ FSS_ENVIRONMENT: 'production' })).toThrow(DeploymentConfigError);
  });

  it('is not set by the rehearsal, whose API publishes the placeholder', () => {
    expect(REHEARSAL_VARIABLES).not.toContain('desktop_upgrade_url');
    expect(REHEARSAL_MAIN).not.toContain('desktop_upgrade_url');
    expect(readUpgradeUrl({ FSS_ENVIRONMENT: 'rehearsal' })).toEqual({ value: DEFAULT_UPGRADE_URL, source: 'placeholder' });
  });
});
