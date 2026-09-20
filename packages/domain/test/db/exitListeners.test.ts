import { afterEach, describe, expect, it } from 'vitest';
import {
  RECLAIMED_EXIT_EVENTS,
  removeExitListenersAddedSince,
  snapshotExitListeners,
} from '../../db/testing/embeddedPostgres.ts';

/**
 * The guard on the gate's exit status.
 *
 * `embedded-postgres` registers an `async-exit-hook` cleanup at import time, and that
 * package hooks `beforeExit` with a hard-coded exit code of zero. `beforeExit` is
 * exactly how a Vitest run ends, so the hook turned a failing local run into
 * `process.exit(0)` — the gate printed its failures and reported success. The `exit`
 * hook in the same package calls an async handler without the callback it declares,
 * which throws once the first hook is gone.
 *
 * `startPostgresCluster` takes both listeners back off `process` immediately after the
 * import. This file tests that removal against synthetic listeners, so it proves the
 * mechanism on any platform and in CI, where the cluster is a service container and
 * `embedded-postgres` is never imported at all.
 *
 * See `docs/decisions/g5b-gate-exit-status.md`.
 */

const registered: { event: string; listener: () => void }[] = [];

function register(event: string, listener: () => void): () => void {
  process.on(event, listener);
  registered.push({ event, listener });
  return listener;
}

afterEach(() => {
  for (const { event, listener } of registered.splice(0)) process.removeListener(event, listener);
});

describe('reclaiming the exit listeners a dependency installs', () => {
  it('removes what was added after the snapshot and keeps what was there before', () => {
    const before = register('beforeExit', () => undefined);
    const snapshot = snapshotExitListeners();
    const afterBeforeExit = register('beforeExit', () => undefined);
    const afterExit = register('exit', () => undefined);

    expect(removeExitListenersAddedSince(snapshot)).toBe(2);
    expect(process.listeners('beforeExit')).toContain(before);
    expect(process.listeners('beforeExit')).not.toContain(afterBeforeExit);
    expect(process.listeners('exit')).not.toContain(afterExit);
  });

  it('removes nothing when nothing was added', () => {
    register('beforeExit', () => undefined);
    const snapshot = snapshotExitListeners();
    expect(removeExitListenersAddedSince(snapshot)).toBe(0);
  });

  it('leaves the signal handlers alone, because 128 + signal is the right code', () => {
    const snapshot = snapshotExitListeners();
    // async-exit-hook also hooks SIGINT, SIGTERM and SIGHUP, and those are what stop a
    // Ctrl-C from leaving a postgres running. They exit with 128 + signal, which is
    // correct, so they are deliberately not reclaimed.
    const onSigint = register('SIGINT', () => undefined);
    const onSigterm = register('SIGTERM', () => undefined);

    removeExitListenersAddedSince(snapshot);

    expect(process.listeners('SIGINT')).toContain(onSigint);
    expect(process.listeners('SIGTERM')).toContain(onSigterm);
    expect([...RECLAIMED_EXIT_EVENTS]).toEqual(['beforeExit', 'exit']);
  });
});
