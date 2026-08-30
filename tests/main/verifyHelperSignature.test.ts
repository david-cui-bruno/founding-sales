import { describe, expect, it } from 'vitest';

import {
  verifyHelperSignature,
  type CodesignExecFile,
} from '../../src/main/appleBridge/verifyHelperSignature';

const packagedHelperPath =
  '/Applications/Callie.app/Contents/Helpers/Callie Apple Bridge.app/Contents/MacOS/CallieAppleBridge';

describe('verifyHelperSignature', () => {
  it('rejects a packaged helper with the wrong identifier', async () => {
    await expect(verifyHelperSignature({
      executablePath: packagedHelperPath,
      isPackaged: true,
      expectedIdentifier: 'com.callie.foundersales.applebridge',
      expectedTeamIdentifier: 'TEAM123456',
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
      isPackaged: true,
      expectedIdentifier: 'com.callie.foundersales.applebridge',
      expectedTeamIdentifier: 'TEAM123456',
      run: async () => ({
        signed: true,
        identifier: 'com.callie.foundersales.applebridge',
        teamIdentifier: 'ATTACKER00',
      }),
    })).rejects.toThrow('Team ID');
  });

  it('permits unsigned code only with an explicit unpackaged development opt-in', async () => {
    const unsigned = async () => ({ signed: false as const });
    const base = {
      executablePath: '/workspace/CallieAppleBridge',
      isPackaged: false,
      expectedIdentifier: 'com.callie.foundersales.applebridge',
      expectedTeamIdentifier: 'TEAM123456',
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
      isPackaged: true,
      expectedIdentifier: 'com.callie.foundersales.applebridge',
      expectedTeamIdentifier: 'TEAM123456',
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
    ]);
  });
});
