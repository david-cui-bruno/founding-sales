import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('packaged test artifact selection', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('targets an explicitly selected candidate output instead of the running installed build', async () => {
    vi.stubEnv('CALLIE_E2E_OUT_DIR', '/fixture/fss-candidate');
    vi.resetModules();
    const { packagedApplicationBinary } = await import('./founderWorkspace');
    expect(packagedApplicationBinary).toBe('/fixture/fss-candidate/Callie Founder Sales System-darwin-arm64/Callie Founder Sales System.app/Contents/MacOS/Callie Founder Sales System');
  });

  it('retains the existing out directory when no candidate is selected', async () => {
    vi.stubEnv('CALLIE_E2E_OUT_DIR', undefined);
    vi.resetModules();
    const { packagedApplicationBinary } = await import('./founderWorkspace');
    expect(packagedApplicationBinary).toBe(join(process.cwd(), 'out', 'Callie Founder Sales System-darwin-arm64', 'Callie Founder Sales System.app', 'Contents', 'MacOS', 'Callie Founder Sales System'));
  });
});
