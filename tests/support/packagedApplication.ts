type ExitStatus = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type SpawnedApplication = {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  removeListener(
    event: 'error' | 'exit',
    listener: (...args: unknown[]) => void,
  ): unknown;
};

const exitStatus = (application: SpawnedApplication): ExitStatus | undefined => {
  if (application.exitCode === null && application.signalCode === null) {
    return undefined;
  }

  return { code: application.exitCode, signal: application.signalCode };
};

const waitForExit = (
  application: SpawnedApplication,
  timeoutMs: number,
): Promise<ExitStatus | undefined> =>
  new Promise((resolve, reject) => {
    const existingExit = exitStatus(application);
    if (existingExit !== undefined) {
      resolve(existingExit);
      return;
    }

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(undefined);
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      application.removeListener(
        'exit',
        onExit as unknown as (...args: unknown[]) => void,
      );
      application.removeListener(
        'error',
        onError as unknown as (...args: unknown[]) => void,
      );
    };

    application.once('exit', onExit);
    application.once('error', onError);
  });

const signalAndWait = async (
  application: SpawnedApplication,
  signal: NodeJS.Signals,
  timeoutMs: number,
): Promise<ExitStatus | undefined> => {
  const waitingForExit = waitForExit(application, timeoutMs);

  if (!application.kill(signal)) {
    const exited = exitStatus(application);
    if (exited !== undefined) {
      return exited;
    }

    throw new Error(`Could not send ${signal} to the packaged application.`);
  }

  return waitingForExit;
};

export const terminatePackagedApplication = async (
  application: SpawnedApplication,
  timeoutMs = 5_000,
): Promise<ExitStatus> => {
  const existingExit = exitStatus(application);
  if (existingExit !== undefined) {
    return existingExit;
  }

  const gracefulExit = await signalAndWait(application, 'SIGTERM', timeoutMs);
  if (gracefulExit !== undefined) {
    return gracefulExit;
  }

  const forcedExit = await signalAndWait(application, 'SIGKILL', timeoutMs);
  if (forcedExit !== undefined) {
    return forcedExit;
  }

  throw new Error('Packaged application did not exit after SIGKILL.');
};

export const describeProcessExit = (application: SpawnedApplication): string =>
  `code=${application.exitCode ?? 'none'}, signal=${application.signalCode ?? 'none'}`;
