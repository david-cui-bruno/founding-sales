import { useState, type JSX } from 'react';
import { Section } from '../settings/Group.tsx';
import { Button } from '../ui/button.tsx';
import { Row, RowMain, Rows } from '../ui/layout.tsx';
import { registryRecordingPorts, useRecordings, type RecordingsPorts } from './recordingsMemory.ts';

/**
 * Settings › Demo recordings folder (lane M4): the folder this Mac watches for Zoom's local
 * demo recordings (default `~/Movies/Callie Demos`, a setting of this Mac), "Choose…" to change
 * it in macOS's panel, and "Import a recording folder…", the same pipeline for one folder.
 * Only recordings that overlap a Callie meeting are ever read or uploaded; the sentence says so.
 */
export function RecordingsFolderSection({ ports = registryRecordingPorts() }: { readonly ports?: RecordingsPorts | null }): JSX.Element | null {
  const recordings = useRecordings(ports);
  const [busy, setBusy] = useState(false);
  if (ports === null) return null;
  const folder = recordings.view?.folder ?? null;
  const run = (action: (() => Promise<unknown>) | undefined): void => {
    if (action === undefined || busy) return;
    setBusy(true);
    void action()
      .then(
        answer => {
          if (answer !== null && typeof answer === 'object' && 'items' in answer) recordings.setView(answer as Parameters<typeof recordings.setView>[0]);
        },
        () => undefined,
      )
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <Section data-testid="recordings-folder-section" title="Demo recordings folder">
      <Rows>
        <Row>
          <RowMain
            line={<span data-testid="recordings-folder-path">{folder?.path ?? '…'}</span>}
            detail={
              <span>
                {folder !== null && !folder.available ? 'Not found on this Mac. ' : ''}
                Zoom’s local recordings of Callie demos. Only a recording made during a Callie meeting is read or uploaded, and only its audio.
              </span>
            }
          />
          <span className="flex shrink-0 items-center gap-1">
            <Button size="sm" variant="outline" data-testid="recordings-folder-choose" disabled={busy || ports.chooseFolder === undefined} onClick={() => run(ports.chooseFolder)}>
              Choose…
            </Button>
            <Button size="sm" variant="quiet" data-testid="recordings-folder-import" disabled={busy || ports.importFolder === undefined} onClick={() => run(ports.importFolder)}>
              Import a recording folder…
            </Button>
          </span>
        </Row>
      </Rows>
    </Section>
  );
}
