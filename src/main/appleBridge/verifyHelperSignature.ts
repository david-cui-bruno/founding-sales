import { execFile as nodeExecFile } from 'node:child_process';

const CODESIGN_PATH = '/usr/bin/codesign';
const CODESIGN_ENV = {
  LANG: 'C',
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
} as const;
const CODESIGN_OPTIONS = {
  encoding: 'utf8' as const,
  env: CODESIGN_ENV,
  maxBuffer: 65_536,
  timeout: 5_000,
};

export type CodesignExecFile = (
  executable: string,
  args: readonly string[],
  options: typeof CODESIGN_OPTIONS,
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void;

export type HelperSignature =
  | { signed: false }
  | {
    signed: true;
    identifier: string;
    teamIdentifier: string;
  };

export type HelperSignatureRunner = (
  executablePath: string,
) => Promise<HelperSignature>;

export type VerifyHelperSignatureOptions = {
  executablePath: string;
  parentExecutablePath: string;
  isPackaged: boolean;
  expectedIdentifier: string;
  allowUnsignedDevelopment?: boolean;
  run?: HelperSignatureRunner;
  execFile?: CodesignExecFile;
};

type CodesignOutput = {
  stdout: string;
  stderr: string;
};

class CodesignCommandError extends Error {
  constructor(readonly output: CodesignOutput) {
    super('codesign command failed');
  }
}

const executeCodesign = (
  args: readonly string[],
  execFile: CodesignExecFile,
): Promise<CodesignOutput> => new Promise((resolve, reject) => {
  execFile(CODESIGN_PATH, args, CODESIGN_OPTIONS, (error, stdout, stderr) => {
    if (error !== null) {
      reject(new CodesignCommandError({ stdout, stderr }));
      return;
    }
    resolve({ stdout, stderr });
  });
});

const parseMetadataField = (metadata: string, field: string): string | undefined => {
  const prefix = `${field}=`;
  return metadata
    .split(/\r?\n/u)
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
};

async function inspectWithCodesign(
  executablePath: string,
  execFile: CodesignExecFile,
): Promise<HelperSignature> {
  try {
    await executeCodesign(
      ['--verify', '--strict', '--verbose=4', executablePath],
      execFile,
    );
  } catch (error) {
    if (
      error instanceof CodesignCommandError
      && /code object is not signed at all/iu.test(
        `${error.output.stdout}\n${error.output.stderr}`,
      )
    ) {
      return { signed: false };
    }
    throw new Error('Apple bridge failed strict code-signature verification.');
  }

  const displayed = await executeCodesign(
    ['--display', '--verbose=4', executablePath],
    execFile,
  ).catch(() => {
    throw new Error('Apple bridge signing identity could not be inspected.');
  });
  const metadata = `${displayed.stdout}\n${displayed.stderr}`;
  const identifier = parseMetadataField(metadata, 'Identifier');
  const teamIdentifier = parseMetadataField(metadata, 'TeamIdentifier');
  if (identifier === undefined || teamIdentifier === undefined) {
    throw new Error('Apple bridge signing identity is incomplete.');
  }

  return { signed: true, identifier, teamIdentifier };
}

export async function verifyHelperSignature(
  options: VerifyHelperSignatureOptions,
): Promise<HelperSignature> {
  const run = options.run ?? ((executablePath: string) => inspectWithCodesign(
    executablePath,
    options.execFile ?? (nodeExecFile as unknown as CodesignExecFile),
  ));
  const signature = await run(options.executablePath);

  if (!signature.signed) {
    if (!options.isPackaged && options.allowUnsignedDevelopment === true) {
      return signature;
    }
    throw new Error('Apple bridge is unsigned; unsigned helpers are development-only.');
  }

  if (options.isPackaged) {
    if (signature.identifier !== options.expectedIdentifier) {
      throw new Error('Apple bridge signing identifier does not match the packaged expectation.');
    }

    const parentSignature = await run(options.parentExecutablePath);
    if (!parentSignature.signed) {
      throw new Error('Packaged parent application is unsigned.');
    }
    if (signature.teamIdentifier !== parentSignature.teamIdentifier) {
      throw new Error('Apple bridge signing Team ID does not match the packaged parent.');
    }
  }

  return signature;
}
