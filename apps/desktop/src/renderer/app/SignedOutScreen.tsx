import { useState, type JSX } from 'react';
import type { DesktopState } from '../../shared/contract.ts';
import type { UpdateStatus } from '../../shared/updateContract.ts';
import { buildScreenView } from '../viewModel.ts';
import { updateLine } from '../homeView.ts';
import { Alert } from '../ui/alert.tsx';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Label } from '../ui/label.tsx';

/**
 * Every screen that is not the shell: signing in, waiting for the browser, and the
 * upgrade instruction.
 *
 * The upgrade screen is the instruction and one control (wave 1): Update now, the
 * six-hourly check run at once. A blocked build installs what it finds and restarts by
 * itself, which is why there is nothing else on it to press.
 */

export const UPDATE_NOW_LABEL = 'Update now';
export const NO_UPDATE_YET = 'No update is available yet. Callie checks again every six hours.';
const CHECK_FAILED = 'Callie could not check for an update just now.';

export interface SignInDraft {
  readonly workspaceId: string;
  readonly deviceLabel: string;
}

function UpdateNow({
  update,
  onCheck,
}: {
  readonly update: UpdateStatus | null;
  onCheck(): Promise<UpdateStatus | null>;
}): JSX.Element | null {
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (update?.kind === 'installing') return null;
  return (
    <>
      <Button
        data-testid="update-now"
        disabled={pending}
        onClick={() => {
          setPending(true);
          setNote(null);
          void (async () => {
            try {
              const found = await onCheck();
              setNote(found === null || found.kind === 'none' ? NO_UPDATE_YET : null);
            } catch {
              setNote(CHECK_FAILED);
            } finally {
              setPending(false);
            }
          })();
        }}
      >
        {pending ? 'Checking…' : UPDATE_NOW_LABEL}
      </Button>
      {note === null ? null : (
        <Alert tone="info" data-testid="update-now-note">
          {note}
        </Alert>
      )}
    </>
  );
}

export function SignedOutScreen({
  desktop,
  update,
  busy,
  draft,
  hasUpdateBridge,
  onDraft,
  onSignIn,
  onCheckForUpdate,
}: {
  readonly desktop: DesktopState;
  readonly update: UpdateStatus | null;
  /** True from the press on Sign in until the main process answers it. */
  readonly busy: boolean;
  /** What was typed, held by the shell so a redraw never empties the form. */
  readonly draft: SignInDraft | null;
  readonly hasUpdateBridge: boolean;
  onDraft(next: SignInDraft | null): void;
  onSignIn(input: { readonly workspaceId?: string | undefined; readonly deviceLabel?: string | undefined }): void;
  onCheckForUpdate(): Promise<UpdateStatus | null>;
}): JSX.Element {
  const view = buildScreenView(desktop);
  const remembered = desktop.rememberedWorkspace;
  // A Mac that has signed in before remembers its workspace and its name (wave 1), so
  // the form is the one button; "Use another workspace" shows the two fields for the
  // rare other one. A first sign-in shows them from the start.
  const [fieldsShown, setFieldsShown] = useState(remembered === null || draft !== null);
  const waiting = busy || view.screen === 'signing_in';
  const workspaceId = draft?.workspaceId ?? '';
  const deviceLabel = draft?.deviceLabel ?? remembered?.deviceLabel ?? 'This Mac';

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <h1 data-testid="heading" className="text-2xl font-semibold tracking-tight">
        {view.heading}
      </h1>

      <div data-testid="banners" className="flex flex-col gap-2 empty:hidden">
        {view.banners.map(banner => (
          <Alert key={`${banner.tone}:${banner.text}`} tone={banner.tone} data-testid={`banner-${banner.tone}`}>
            {banner.text}
          </Alert>
        ))}
        {/* An install under way says so on every screen, including the upgrade screen it
            is about to clear. A staged update's Restart lives in the sidebar only. */}
        {update?.kind === 'installing' ? (
          <Alert tone="info" data-testid="update-notice">
            {updateLine(update) ?? ''}
          </Alert>
        ) : null}
      </div>

      {view.screen === 'upgrade_required' ? (
        <>
          <p data-testid="upgrade-only" className="text-sm text-muted-foreground">
            Callie will work again once this Mac is updated.
          </p>
          {hasUpdateBridge ? <UpdateNow update={update} onCheck={onCheckForUpdate} /> : null}
        </>
      ) : (
        <form
          data-testid="sign-in-form"
          className="flex flex-col gap-3"
          onSubmit={event => {
            event.preventDefault();
            // Hidden fields send nothing, and the main process signs in to the
            // remembered workspace.
            onDraft(fieldsShown ? { workspaceId, deviceLabel } : null);
            onSignIn(fieldsShown ? { workspaceId: workspaceId.trim(), deviceLabel: deviceLabel.trim() } : {});
          }}
        >
          <div data-testid="sign-in-fields" hidden={!fieldsShown} className="flex flex-col gap-3">
            <Label className="flex-col items-start gap-1 text-foreground">
              Workspace
              <Input
                name="workspaceId"
                autoComplete="off"
                required={fieldsShown}
                data-testid="workspace-id"
                value={workspaceId}
                onChange={event => {
                  onDraft({ workspaceId: event.target.value, deviceLabel });
                }}
              />
            </Label>
            <Label className="flex-col items-start gap-1 text-foreground">
              Name this Mac
              <Input
                name="deviceLabel"
                required={fieldsShown}
                data-testid="device-label"
                value={deviceLabel}
                onChange={event => {
                  onDraft({ workspaceId, deviceLabel: event.target.value });
                }}
              />
            </Label>
          </div>
          <Button type="submit" data-testid="sign-in" disabled={waiting || !view.signInEnabled}>
            {waiting ? 'Waiting for your browser…' : 'Sign in with Google'}
          </Button>
          {remembered !== null && !fieldsShown ? (
            <Button
              variant="quiet"
              data-testid="use-another-workspace"
              disabled={waiting}
              onClick={() => {
                setFieldsShown(true);
              }}
            >
              Use another workspace
            </Button>
          ) : null}
        </form>
      )}
    </div>
  );
}
