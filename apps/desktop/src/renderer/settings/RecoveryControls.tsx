import { useCallback, useEffect, useState, type JSX } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import type { DeadJob, OperationOutput } from '../../shared/operations.ts';
import { zodResolver } from '../lib/zodResolver.ts';
import { Alert } from '../ui/alert.tsx';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Label } from '../ui/label.tsx';
import { Select } from '../ui/select.tsx';
import { Textarea } from '../ui/textarea.tsx';

/**
 * Settings › Diagnostics: the two recoveries that had no screen (specification 12.5, 13.4).
 *
 * Both of these were `curl` in a runbook until 1.0.12 —
 * `docs/greenfield/runbooks/operate.md` — which is a poor place for the two things that
 * are only ever done in the middle of something going wrong:
 *
 * **An unknown send.** A message whose dispatch started and whose outcome the fence never
 * learned is held rather than guessed at (12.5), and a person has to say which it was.
 * The id is looked up *first*: this form will not let anyone record an outcome for a send
 * they have not just read the state of.
 *
 * **A dead job.** A job past its attempts is left where it is until somebody says why it
 * should run again. The reason is required here because it is required in the audit
 * record — "because it failed" is what the row already says.
 *
 * Three rules hold in both forms, and each has a test:
 *
 *   * the preview is a read and the recovery is a command, and they are different
 *     presses: `type="button"`, no form submit anywhere near the consequential one, so
 *     Enter in a field cannot record an outcome or requeue anything;
 *   * the button names what it is about to do — "Record it as delivered", "Requeue this
 *     job" — not "Confirm";
 *   * what comes back is shown as the server said it, and a refusal is shown in the
 *     same place rather than thrown away.
 *
 * `diagnostics.requeueJob` answers a plain body rather than the accepted envelope
 * (`apps/api/src/routes/admin/jobs.ts`), which is why the registry gives it
 * `envelope: 'plain'` and its own parser in the main process: the common command client
 * would read its success as a refusal.
 */

const api = (): NonNullable<typeof globalThis.callieApi> | undefined => globalThis.callieApi;

const messageOf = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : 'Callie could not do that.';

// ---------------------------------------------------------------------------
// An unknown send
// ---------------------------------------------------------------------------

const RESOLUTION_EFFECTS = {
  delivered: 'Record it as delivered',
  skipped: 'Record it as never sent',
} as const;
type Resolution = keyof typeof RESOLUTION_EFFECTS;

const sendLookupSchema = z.object({
  outboundMessageId: z.uuid('That is not a send id. Copy it from the alert or the operations log.'),
});
type SendLookup = z.infer<typeof sendLookupSchema>;

type Fence = NonNullable<OperationOutput<'diagnostics.sendStatus'>['fence']>;

/**
 * The six states a send can be in (`packages/contracts/src/outbound.ts`), as sentences.
 *
 * Only `unknown_terminal` can be resolved: the server refuses `/outbound/resolve` for
 * anything else with `fence_not_ready` (`apps/api/test/outbound.test.ts`), and a form
 * that invited the decision anyway would be a form whose button fails. `dispatching` is
 * a send still being reconciled and is **not** one of these: it becomes
 * `unknown_terminal` when the observation window expires, and the answer then is a
 * person's rather than a guess.
 */
const FENCE_STATES: Readonly<Record<string, string>> = Object.freeze({
  prepared: 'Prepared, not dispatched yet. Nothing to resolve.',
  held: 'Held. Nothing to resolve until sending is released.',
  dispatching: 'Dispatch started; Callie is still reconciling it. Nothing to resolve yet.',
  reconciling: 'Being reconciled against the mailbox. Nothing to resolve yet.',
  sent: 'Sent. Nothing to resolve.',
  unknown_terminal: 'Dispatch started and the outcome was never learned — this is the one you resolve.',
});

/** The one state 12.5 puts a question to a person about. */
const RESOLVABLE = 'unknown_terminal';

function FenceSummary({ fence }: { readonly fence: Fence }): JSX.Element {
  return (
    <dl data-testid="recovery-send-fence" className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1 text-xs">
      <dt className="text-muted-foreground">State</dt>
      <dd data-testid="recovery-send-state">{FENCE_STATES[fence.state] ?? fence.state}</dd>
      <dt className="text-muted-foreground">To</dt>
      <dd>{fence.recipientAddress}</dd>
      <dt className="text-muted-foreground">Dispatch started</dt>
      <dd>{fence.dispatchStartedAt ?? '—'}</dd>
      <dt className="text-muted-foreground">Sent</dt>
      <dd>{fence.sentAt ?? '—'}</dd>
      <dt className="text-muted-foreground">Held because</dt>
      <dd>{fence.heldReason ?? '—'}</dd>
      <dt className="text-muted-foreground">Already decided</dt>
      <dd>{fence.adminResolution ?? 'no'}</dd>
      <dt className="text-muted-foreground">Reconcile attempts</dt>
      <dd>{String(fence.reconcileAttempts)}</dd>
    </dl>
  );
}

function ResolveSend(): JSX.Element {
  const [fence, setFence] = useState<Fence | null>(null);
  const [looked, setLooked] = useState<string | null>(null);
  const [resolution, setResolution] = useState<Resolution>('delivered');
  const [notice, setNotice] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const form = useForm<SendLookup>({
    resolver: zodResolver(sendLookupSchema),
    defaultValues: { outboundMessageId: '' },
  });

  /*
   * The state on screen belongs to the id that was looked up, and to no other. Editing
   * the field after a preview used to leave the old id as the command's target, so the
   * screen described one send and the button resolved another. Changing a character
   * takes the preview away; looking it up again brings one back.
   */
  const typed = form.watch('outboundMessageId');
  useEffect(() => {
    if (looked !== null && typed.trim() !== looked) {
      setFence(null);
      setLooked(null);
      setAnswer(null);
    }
  }, [typed, looked]);

  const look = useCallback(
    async ({ outboundMessageId }: SendLookup): Promise<void> => {
      const bridge = api();
      if (bridge === undefined) return;
      setBusy(true);
      setNotice(null);
      setAnswer(null);
      setFence(null);
      try {
        const state = await bridge.read('diagnostics.sendStatus', { outboundMessageId });
        setFence(state.fence);
        setLooked(outboundMessageId);
        if (state.fence === null) setNotice('There is no send with that id in this workspace.');
      } catch (error: unknown) {
        setNotice(messageOf(error));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const resolve = useCallback((): void => {
    const bridge = api();
    if (bridge === undefined || looked === null) return;
    setBusy(true);
    setNotice(null);
    void bridge
      .command('diagnostics.resolveSend', { outboundMessageId: looked, resolution })
      .then(
        recorded => {
          setAnswer(
            recorded.resolution === 'delivered'
              ? 'Recorded as delivered. Nothing will be sent again.'
              : 'Recorded as never sent. The step can be tried again.',
          );
          // The state on screen was true before the decision, so it is not true now.
          setFence(null);
          setLooked(null);
          form.reset();
        },
        (error: unknown) => {
          setNotice(messageOf(error));
        },
      )
      .finally(() => {
        setBusy(false);
      });
  }, [form, looked, resolution]);

  // Already decided, or never in doubt: either way there is nothing for a person to say.
  const resolvable = fence !== null && fence.state === RESOLVABLE && fence.adminResolution === null;

  return (
    <section data-testid="recovery-send" className="flex flex-col gap-3 border-t border-border pt-4">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-medium">A send whose outcome is unknown</h3>
        <p className="text-xs text-muted-foreground">
          Look the send up, read what the fence knows, then say which it was. Nothing is decided until you press the
          button that names it.
        </p>
      </div>

      {/* A read, so this one may be a form: Enter here looks a send up and nothing else. */}
      <form
        className="flex items-end gap-2"
        onSubmit={event => {
          void form.handleSubmit(look)(event);
        }}
      >
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor="recovery-send-id">Send id</Label>
          <Input
            id="recovery-send-id"
            data-testid="recovery-send-id"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={form.formState.errors.outboundMessageId !== undefined}
            {...form.register('outboundMessageId')}
          />
        </div>
        <Button type="submit" variant="outline" data-testid="recovery-send-lookup" disabled={busy}>
          Look it up
        </Button>
      </form>
      {form.formState.errors.outboundMessageId !== undefined ? (
        <Alert tone="blocking" data-testid="recovery-send-invalid">
          {form.formState.errors.outboundMessageId.message}
        </Alert>
      ) : null}

      {fence !== null ? (
        <>
          <FenceSummary fence={fence} />
          <div className="flex items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="recovery-send-resolution">What happened</Label>
              <Select
                id="recovery-send-resolution"
                data-testid="recovery-send-resolution"
                value={resolution}
                onChange={event => {
                  setResolution(event.target.value as Resolution);
                }}
              >
                <option value="delivered">It reached them</option>
                <option value="skipped">It never went out</option>
              </Select>
            </div>
            <Button data-testid="recovery-send-confirm" disabled={busy || !resolvable} onClick={resolve}>
              {RESOLUTION_EFFECTS[resolution]}
            </Button>
          </div>
          {resolvable ? null : (
            <p data-testid="recovery-send-settled" className="text-xs text-muted-foreground">
              {fence.adminResolution === null
                ? 'Only a send whose outcome was never learned can be resolved here.'
                : `This send was already recorded as ${fence.adminResolution}.`}
            </p>
          )}
        </>
      ) : null}

      {answer !== null ? (
        <Alert data-testid="recovery-send-answer" tone="info">
          {answer}
        </Alert>
      ) : null}
      {notice !== null ? (
        <Alert data-testid="recovery-send-notice" tone="warning">
          {notice}
        </Alert>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// A dead job
// ---------------------------------------------------------------------------

const requeueSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'Say why this should run again. It goes into the record with your name on it.')
    .max(500, 'Five hundred characters is the most the record keeps.'),
});
type Requeue = z.infer<typeof requeueSchema>;

function DeadJobRow({
  job,
  picked,
  onPick,
}: {
  readonly job: DeadJob;
  readonly picked: boolean;
  readonly onPick: (id: string) => void;
}): JSX.Element {
  return (
    <li className="border-t border-border py-2 first:border-t-0">
      <label className="flex cursor-pointer items-start gap-2 text-xs">
        <input
          type="radio"
          name="recovery-dead-job"
          data-testid={`recovery-job-${job.id}`}
          className="mt-0.5"
          checked={picked}
          onChange={() => {
            onPick(job.id);
          }}
        />
        <span className="flex flex-col gap-0.5">
          <span className="text-sm">{job.kind}</span>
          <span className="text-muted-foreground">
            {job.attempts} of {job.maxAttempts} attempts, dead since {job.deadAt}
            {job.requeuedCount > 0 ? `, requeued ${job.requeuedCount} time${job.requeuedCount === 1 ? '' : 's'} before` : ''}
          </span>
          <span className="text-muted-foreground">{job.errorCode ?? 'no error code'}</span>
        </span>
      </label>
    </li>
  );
}

function RequeueDeadJob(): JSX.Element {
  const [jobs, setJobs] = useState<readonly DeadJob[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const form = useForm<Requeue>({ resolver: zodResolver(requeueSchema), defaultValues: { reason: '' } });

  const list = useCallback((): void => {
    const bridge = api();
    if (bridge === undefined) return;
    setBusy(true);
    setNotice(null);
    setAnswer(null);
    void bridge
      .read('diagnostics.deadJobs', {})
      .then(
        state => {
          setJobs(state.deadJobs);
          setPicked(state.deadJobs[0]?.id ?? null);
        },
        (error: unknown) => {
          setNotice(messageOf(error));
        },
      )
      .finally(() => {
        setBusy(false);
      });
  }, []);

  const requeue = useCallback(
    async ({ reason }: Requeue): Promise<void> => {
      const bridge = api();
      if (bridge === undefined || picked === null) return;
      setBusy(true);
      setNotice(null);
      try {
        // Its own parser, in the main process: this route answers `{ requeued, jobId,
        // kind }` rather than the accepted envelope every other command answers.
        const done = await bridge.command('diagnostics.requeueJob', { jobId: picked, reason });
        setAnswer(`Requeued: ${done.kind}. It will be picked up on the next pass.`);
        setJobs(jobs?.filter(job => job.id !== done.jobId) ?? null);
        setPicked(null);
        form.reset();
      } catch (error: unknown) {
        setNotice(messageOf(error));
      } finally {
        setBusy(false);
      }
    },
    [form, jobs, picked],
  );

  return (
    <section data-testid="recovery-jobs" className="flex flex-col gap-3 border-t border-border pt-4">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-medium">A job that gave up</h3>
        <p className="text-xs text-muted-foreground">
          Jobs past their last attempt stay where they are. Say why one should run again and it goes back in the queue.
        </p>
      </div>

      <div>
        <Button variant="outline" data-testid="recovery-jobs-load" disabled={busy} onClick={list}>
          {jobs === null ? 'Look for dead jobs' : 'Look again'}
        </Button>
      </div>

      {jobs !== null && jobs.length === 0 ? (
        <p data-testid="recovery-jobs-none" className="text-xs text-muted-foreground">
          No job has given up.
        </p>
      ) : null}

      {jobs !== null && jobs.length > 0 ? (
        <>
          <ul data-testid="recovery-jobs-list" className="rounded-md border border-border px-3">
            {jobs.map(job => (
              <DeadJobRow
                key={job.id}
                job={job}
                picked={job.id === picked}
                onPick={id => {
                  setPicked(id);
                  setAnswer(null);
                }}
              />
            ))}
          </ul>
          <div className="flex flex-col gap-1">
            <Label htmlFor="recovery-job-reason">Why it should run again</Label>
            <Textarea
              id="recovery-job-reason"
              data-testid="recovery-job-reason"
              rows={2}
              aria-invalid={form.formState.errors.reason !== undefined}
              {...form.register('reason')}
            />
          </div>
          {form.formState.errors.reason !== undefined ? (
            <Alert tone="blocking" data-testid="recovery-job-invalid">
              {form.formState.errors.reason.message}
            </Alert>
          ) : null}
          {/* No form: only this press requeues anything, and Enter in the reason is a newline. */}
          <div>
            <Button
              data-testid="recovery-job-confirm"
              disabled={busy || picked === null}
              onClick={() => {
                void form.handleSubmit(requeue)();
              }}
            >
              Requeue this job
            </Button>
          </div>
        </>
      ) : null}

      {answer !== null ? (
        <Alert data-testid="recovery-job-answer" tone="info">
          {answer}
        </Alert>
      ) : null}
      {notice !== null ? (
        <Alert data-testid="recovery-job-notice" tone="warning">
          {notice}
        </Alert>
      ) : null}
    </section>
  );
}

/** The two recoveries, under the Diagnostics tab's own panels. */
export function RecoveryControls(): JSX.Element | null {
  if (api() === undefined) return null;
  return (
    <div data-testid="recovery" className="mt-8 flex flex-col gap-6">
      <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Recovery</h2>
      <ResolveSend />
      <RequeueDeadJob />
    </div>
  );
}
