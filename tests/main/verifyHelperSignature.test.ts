import { describe, expect, it } from 'vitest';

import {
  verifyHelperSignature,
  type CodesignExecFile,
  type VerifyHelperSignatureOptions,
} from '../../src/main/appleBridge/verifyHelperSignature';

const packagedHelperPath =
  '/Applications/Callie.app/Contents/Helpers/Callie Apple Bridge.app/Contents/MacOS/CallieAppleBridge';
const packagedParentPath =
  '/Applications/Callie.app/Contents/MacOS/Callie';

describe('verifyHelperSignature', () => {
  it('anchors packaged Team identity to the parent and permits a matching ad-hoc package', async () => {
    const options = {
      executablePath: packagedHelperPath,
      parentExecutablePath: packagedParentPath,
      isPackaged: true,
      expectedIdentifier: 'com.callie.foundersales.applebridge',
      run: async (executablePath: string) => ({
        signed: true as const,
        identifier: executablePath === packagedHelperPath
          ? 'com.callie.foundersales.applebridge'
          : 'com.callie.foundersales',
        teamIdentifier: 'not set',
      }),
    } satisfies VerifyHelperSignatureOptions;

    await expect(verifyHelperSignature(options)).resolves.toMatchObject({
      signed: true,
      identifier: 'com.callie.foundersales.applebridge',
      teamIdentifier: 'not set',
    });
  });

  it('rejects a packaged helper with the wrong identifier', async () => {
    await expect(verifyHelperSignature({
      executablePath: packagedHelperPath,
      parentExecutablePath: packagedParentPath,
      isPackaged: true,
      expectedIdentifier: 'com.callie.foundersales.applebridge',
      run: async () => ({
        signed: true,
        identifier: 'com.attacker.helper',
        teamIdentifier: 'TEAM123456',
      }),
    })).rejects.toThrow('identifier');
  });

  it('rejects a packaged helper with the wrong Team ID', async () => {
    await expect(verifyHelperSignature({
      executablePath: packagedHelperPath,
      parentExecutablePath: packagedParentPath,
      isPackaged: true,
      expectedIdentifier: 'com.callie.foundersales.applebridge',
      run: async (executablePath) => ({
        signed: true,
        identifier: executablePath === packagedHelperPath
          ? 'com.callie.foundersales.applebridge'
          : 'com.callie.foundersales',
        teamIdentifier: executablePath === packagedHelperPath
          ? 'ATTACKER00'
          : 'TEAM123456',
      }),
    })).rejects.toThrow('Team ID');
  });

  it('permits unsigned code only with an explicit unpackaged development opt-in', async () => {
    const unsigned = async () => ({ signed: false as const });
    const base = {
      executablePath: '/workspace/CallieAppleBridge',
      parentExecutablePath: '/workspace/Callie',
      isPackaged: false,
      expectedIdentifier: 'com.callie.foundersales.applebridge',
      run: unsigned,
    };

    await expect(verifyHelperSignature(base)).rejects.toThrow('unsigned');
    await expect(verifyHelperSignature({
      ...base,
      allowUnsignedDevelopment: true,
    })).resolves.toEqual({ signed: false });
    await expect(verifyHelperSignature({
      ...base,
      isPackaged: true,
      allowUnsignedDevelopment: true,
    })).rejects.toThrow('unsigned');
  });

  it('uses fixed codesign verification and display arguments without a shell', async () => {
    const calls: Array<{
      executable: string;
      args: readonly string[];
      options: Record<string, unknown>;
    }> = [];
    const execFile: CodesignExecFile = (executable, args, options, callback) => {
      calls.push({ executable, args: [...args], options });
      if (args[0] === '--verify') {
        callback(null, '', 'valid on disk\nsatisfies its Designated Requirement\n');
      } else {
        callback(
          null,
          '',
          'Executable=/redacted\nIdentifier=com.callie.foundersales.applebridge\nTeamIdentifier=TEAM123456\n',
        );
      }
    };

    await expect(verifyHelperSignature({
      executablePath: packagedHelperPath,
      parentExecutablePath: packagedParentPath,
      isPackaged: true,
      expectedIdentifier: 'com.callie.foundersales.applebridge',
      execFile,
    })).resolves.toMatchObject({
      signed: true,
      identifier: 'com.callie.foundersales.applebridge',
      teamIdentifier: 'TEAM123456',
    });

    expect(calls).toEqual([
      {
        executable: '/usr/bin/codesign',
        args: ['--verify', '--strict', '--verbose=4', packagedHelperPath],
        options: {
          encoding: 'utf8',
          env: { LANG: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
          maxBuffer: 65_536,
          timeout: 5_000,
        },
      },
      {
        executable: '/usr/bin/codesign',
        args: ['--display', '--verbose=4', packagedHelperPath],
        options: {
          encoding: 'utf8',
          env: { LANG: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
          maxBuffer: 65_536,
          timeout: 5_000,
        },
      },
      {
        executable: '/usr/bin/codesign',
        args: ['--verify', '--strict', '--verbose=4', packagedParentPath],
        options: {
          encoding: 'utf8',
          env: { LANG: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
          maxBuffer: 65_536,
          timeout: 5_000,
        },
      },
      {
        executable: '/usr/bin/codesign',
        args: ['--display', '--verbose=4', packagedParentPath],
        options: {
          encoding: 'utf8',
          env: { LANG: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
          maxBuffer: 65_536,
          timeout: 5_000,
        },
      },
    ]);
  });
});
