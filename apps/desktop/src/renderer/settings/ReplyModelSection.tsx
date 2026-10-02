import { useMemo, type JSX } from 'react';
import type { Generation } from '../app/generation.ts';
import { useViewState } from '../app/useViewState.ts';
import { REPLY_MODELS, type ReplyModel, type ReplyModelState } from '../replyContract.ts';
import { Button } from '../ui/button.tsx';
import { useKept } from '../replies/kept.ts';
import { Section } from './Group.tsx';
import { Select } from '../ui/select.tsx';

/**
 * Settings › Reply suggestions: which model writes them (slice 3a, C0; David's decision 1).
 *
 * An admin chooses between the two the contract names. The choice is saved through the
 * existing `POST /replies/settings/update` and **only the model name is sent**: the effort
 * and the caps are the server's, and nothing here can change them. Absent for anyone who is
 * not an admin, as Research is: a control that exists only to be refused teaches nothing.
 */

/** The words an admin knows each model by. The un-dated alias is the same Haiku. */
export function modelLabel(name: string): string {
  if (name === 'claude-haiku-4-5-20251001' || name === 'claude-haiku-4-5') return 'Haiku 4.5 (AWS credits)';
  if (name === 'claude-opus-5') return 'Opus 5 (direct API)';
  return name;
}

const NOTICES: Readonly<Record<string, string>> = Object.freeze({
  reply_model_saved: 'Saved.',
  admin_only: 'Only an admin may change the model.',
  offline: 'Callie is offline. Nothing was saved.',
  refused: 'The server refused that.',
});

export function replyModelNotice(code: string): string {
  return NOTICES[code] ?? 'The model could not be saved.';
}

export function ReplyModelSection({
  isAdmin,
  identity,
  generation,
  guard,
}: {
  readonly isAdmin: boolean;
  readonly identity: string | null;
  readonly generation: number;
  readonly guard: Generation;
}): JSX.Element | null {
  const view = useViewState<ReplyModelState>({
    key: 'reply-model',
    identity: isAdmin ? identity : null,
    generation,
    guard,
    first: useMemo(() => async api => await api.read('replies.model', {}), []),
  });
  // The model picked and not yet saved: kept above the route, '' for none (S4R, criterion 7).
  const [chosenText, setChosenText] = useKept('settings:reply-model:choice', '');
  const choice: ReplyModel | null = REPLY_MODELS.find(name => name === chosenText) ?? null;
  if (!isAdmin || !view.available) return null;

  const state = view.state;
  const current = state?.classifier?.modelName ?? null;
  const known = current === 'claude-haiku-4-5' ? REPLY_MODELS[0] : current;
  const shown: string = choice ?? (known !== null && (REPLY_MODELS as readonly string[]).includes(known) ? known : '');
  const saving = view.busy('reply-model');
  const changed = choice !== null && choice !== current;

  return (
    <Section data-testid="reply-model" title="Reply suggestions">
      <p data-testid="reply-model-current" className="py-1 text-sm">
        {current === null ? (
          <span className="text-muted-foreground">{state === null ? 'Reading the current model…' : 'The current model could not be read.'}</span>
        ) : (
          <>
            <span className="text-muted-foreground">Model now: </span>
            {modelLabel(current)}
          </>
        )}
      </p>
      <div className="mt-2 flex items-center gap-2">
        <Select
          aria-label="Reply suggestions model"
          data-testid="reply-model-select"
          className="w-64"
          disabled={saving || state?.classifier == null}
          value={shown}
          onChange={event => {
            setChosenText(event.target.value);
          }}
        >
          {shown === '' ? <option value="">{current ?? '—'}</option> : null}
          {REPLY_MODELS.map(name => (
            <option key={name} value={name}>
              {modelLabel(name)}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          data-testid="reply-model-save"
          disabled={saving || !changed || state?.mayMutate === false}
          {...(saving ? { 'aria-busy': true } : {})}
          onClick={() => {
            if (choice === null) return;
            const modelName = choice;
            view.command('reply-model', async api => await api.command('replies.saveModel', { modelName }));
            setChosenText('');
          }}
        >
          Save
        </Button>
        {state?.notice == null ? null : (
          <span data-testid="reply-model-notice" role="status" className="text-xs text-muted-foreground">
            {replyModelNotice(state.notice)}
          </span>
        )}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Only the model changes here. The effort and the daily caps are left as they are.</p>
    </Section>
  );
}
