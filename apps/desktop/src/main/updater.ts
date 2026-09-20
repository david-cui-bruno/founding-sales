import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, dialog, shell } from 'electron';
import {
  checkForUpdate,
  downloadVerifiedArtifact,
  type UpdateDecision,
  type UpdateManifest,
} from './updateChannel.ts';

/**
 * The part of the update channel a person sees.
 *
 * Everything that decides anything is in `updateChannel.ts` and is tested without
 * Electron. This file asks, shows, downloads and verifies — and the one thing it
 * never does is install something the verification refused. When the API has raised
 * the minimum client version, the app is already refusing every mutation (G2's
 * gate, specification 5.3), and that is exactly the moment when "just install it"
 * is most tempting and most dangerous, so the refusal path here is a dialog that
 * says what went wrong rather than a fallback that proceeds anyway.
 *
 * It does not replace the running bundle in place. Squirrel.Mac can, and needs a
 * Developer ID signature to do it; no such signature exists yet, so an updater that
 * claimed to swap the app would be untested code on the one path that must not
 * fail. What this does is verify the download against the signed manifest and put
 * it in front of the person in Finder. `docs/decisions/g13-update-application.md`.
 */

const SIX_HOURS = 6 * 60 * 60 * 1000;

export interface UpdateWatchOptions {
  readonly currentVersion: string;
  readonly channelBaseUrl: string;
  /** Base64 SPKI DER, compiled in by the build. Empty means every update is refused. */
  readonly publicKey: string;
  readonly intervalMs?: number;
  readonly check?: typeof checkForUpdate;
  readonly download?: typeof downloadVerifiedArtifact;
  readonly ask?: (manifest: UpdateManifest) => Promise<boolean>;
  readonly tell?: (message: string, detail: string) => Promise<void>;
  readonly reveal?: (path: string) => void;
  readonly downloadDirectory?: () => string;
}

export interface UpdateWatch {
  checkNow(): Promise<UpdateDecision>;
  stop(): void;
}

export function startUpdateWatch(options: UpdateWatchOptions): UpdateWatch {
  const check = options.check ?? checkForUpdate;
  const download = options.download ?? downloadVerifiedArtifact;
  const ask = options.ask ?? defaultAsk;
  const tell = options.tell ?? defaultTell;
  const reveal = options.reveal ?? ((path: string) => { shell.showItemInFolder(path); });
  const downloadDirectory = options.downloadDirectory ?? (() => app.getPath('downloads'));

  // One prompt per version. A person who said "later" is not asked again until the
  // channel offers something new.
  const declined = new Set<string>();
  let running = false;

  const checkNow = async (): Promise<UpdateDecision> => {
    if (running) return { kind: 'refused', reason: 'update_offline' };
    running = true;
    try {
      const decision = await check({
        currentVersion: options.currentVersion,
        channelBaseUrl: options.channelBaseUrl,
        publicKey: options.publicKey,
      });
      if (decision.kind === 'available' && !declined.has(decision.manifest.releaseVersion)) {
        await offer(decision.manifest);
      }
      return decision;
    } finally {
      running = false;
    }
  };

  const offer = async (manifest: UpdateManifest): Promise<void> => {
    if (!(await ask(manifest))) {
      declined.add(manifest.releaseVersion);
      return;
    }
    const downloaded = await download(manifest);
    if (!downloaded.ok) {
      // The signed manifest and the bytes disagree, or the channel stopped
      // answering. Either way this build stays as it is.
      await tell('Callie could not verify the update', `It has not been installed (${downloaded.reason}).`);
      return;
    }
    const target = join(downloadDirectory(), `Callie-${manifest.releaseVersion}-arm64.zip`);
    await writeFile(target, downloaded.bytes, { mode: 0o600 });
    reveal(target);
    await tell(
      `Callie ${manifest.releaseVersion} is ready to install`,
      'Unzip it and replace Callie in Applications, then open it again.',
    );
  };

  const timer = setInterval(() => {
    void checkNow();
  }, options.intervalMs ?? SIX_HOURS);
  timer.unref?.();

  return {
    checkNow,
    stop: () => { clearInterval(timer); },
  };
}

async function defaultAsk(manifest: UpdateManifest): Promise<boolean> {
  const answer = await dialog.showMessageBox({
    type: 'info',
    buttons: ['Download update', 'Later'],
    defaultId: 0,
    cancelId: 1,
    message: `Callie ${manifest.releaseVersion} is available`,
    detail: 'Callie checked its signature against the key this build was made with.',
  });
  return answer.response === 0;
}

async function defaultTell(message: string, detail: string): Promise<void> {
  await dialog.showMessageBox({ type: 'info', buttons: ['OK'], message, detail });
}
