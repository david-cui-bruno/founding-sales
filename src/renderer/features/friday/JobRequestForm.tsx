import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type {
  CancelJobRequest,
  CreateJobRequest,
  FillJobRequest,
  JobRequest,
} from '../../../shared/contracts/fridayContract';
import type { FridayIntent, FridayMutationView, FridaySaveResult } from './FridayRoute';
import { Button } from '../../components/Button';
import { StatusPill } from '../../components/StatusPill';

// Local-time display; the strict ISO timestamp lives in the contract.
const accepted = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

const statusLabel: Record<JobRequest['status'], string> = {
  requested: 'Requested',
  filled: 'Filled',
  cancelled: 'Cancelled',
};

const statusTone = (
  status: JobRequest['status'],
): 'neutral' | 'positive' => (status === 'filled' ? 'positive' : 'neutral');

function mintJobId(): string {
  const generator = globalThis.crypto;
  if (generator !== undefined && 'randomUUID' in generator) {
    return `job-${generator.randomUUID()}`;
  }
  return `job-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

/** Local date (yyyy-mm-dd) + time (HH:mm) to a canonical ISO instant. */
function localDateTimeToIso(date: string, time: string): string {
  return new Date(`${date}T${time === '' ? '00:00' : time}`).toISOString();
}

export type JobRequestFormProps = {
  jobs: JobRequest[];
  onCreateJob(input: CreateJobRequest): Promise<FridaySaveResult>;
  onFillJob(input: FillJobRequest): Promise<FridaySaveResult>;
  onCancelJob(input: CancelJobRequest): Promise<FridaySaveResult>;
  mutation: FridayMutationView;
  onRetryMutation(): Promise<FridaySaveResult>;
  onRefreshJobs(): Promise<FridaySaveResult>;
  now?(): string;
};

/**
 * Manual founder job tracking. Creating records the requested timestamp and
 * an optional Won cycle; filling requires the contractor-accepted timestamp
 * because contractor acceptance is the fill event. Cancelled jobs stay
 * visible; the domain excludes them from the fill denominator. Timestamps
 * are entered as a local date + time pair, never as raw UTC strings.
 */
export function JobRequestForm({
  jobs,
  onCreateJob,
  onFillJob,
  onCancelJob,
  mutation,
  onRetryMutation,
  onRefreshJobs,
  now = () => new Date().toISOString(),
}: JobRequestFormProps) {
  const [requestedDate, setRequestedDate] = useState('');
  const [requestedTime, setRequestedTime] = useState('');
  const [wonCycleId, setWonCycleId] = useState('');
  const [fillingJobId, setFillingJobId] = useState<string | null>(null);
  const [acceptedDate, setAcceptedDate] = useState('');
  const [acceptedTime, setAcceptedTime] = useState('');

  type Captured = { intent: FridayIntent; date: string; time: string; cycle: string };
  const captured = useRef<Captured | null>(null);
  const flight = useRef<object | null>(null);
  const lifetime = useRef<{ active: boolean } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);
  const blocked = submitting || mutation.status === 'pending' || mutation.status === 'unconfirmed';
  useLayoutEffect(() => {
    const token = { active: true };
    lifetime.current = token;
    return () => { token.active = false; };
  }, []);
  const clearSubmitted = useCallback((submitted: Captured) => {
    if (captured.current !== submitted) return;
    captured.current = null;
    if (submitted.intent.kind === 'create') {
      setRequestedDate((value) => value === submitted.date ? '' : value);
      setRequestedTime((value) => value === submitted.time ? '' : value);
      setWonCycleId((value) => value === submitted.cycle ? '' : value);
    } else if (submitted.intent.kind === 'fill') {
      const id = submitted.intent.input.jobId;
      setFillingJobId((value) => value === id ? null : value);
      setAcceptedDate((value) => value === submitted.date ? '' : value);
      setAcceptedTime((value) => value === submitted.time ? '' : value);
    }
  }, []);
  useEffect(() => {
    const submitted = captured.current;
    if (mutation.status !== 'saved' || !submitted) return;
    const a = submitted.intent;
    const b = mutation.intent;
    if (a.input.jobId !== b.input.jobId) return;
    const same = a.kind === 'create' && b.kind === 'create'
      ? a.input.requestedAt === b.input.requestedAt && a.input.salesCycleId === b.input.salesCycleId
      : a.kind === 'fill' && b.kind === 'fill'
        ? a.input.contractorAcceptedAt === b.input.contractorAcceptedAt
        : a.kind === 'cancel' && b.kind === 'cancel';
    if (same) clearSubmitted(submitted);
  }, [mutation, clearSubmitted]);

  const submit = async (capture: () => Captured) => {
    const token = lifetime.current;
    if (blocked || flight.current || !token?.active) return;
    const attempt = {};
    flight.current = attempt; // Also prevents minting another ID in the same turn.
    let submitted: Captured;
    try {
      submitted = capture();
    } catch {
      flight.current = null;
      setValidation('Check the job date and time before saving.');
      return;
    }
    captured.current = submitted;
    setSubmitting(true);
    setValidation(null);
    try {
      const intent = submitted.intent;
      const result = await (intent.kind === 'create' ? onCreateJob(intent.input)
        : intent.kind === 'fill' ? onFillJob(intent.input) : onCancelJob(intent.input));
      if (!token.active || lifetime.current !== token) return;
      if (result.status === 'saved') clearSubmitted(submitted);
      else if (result.status === 'not_started' && captured.current === submitted) captured.current = null;
    } finally {
      if (token.active && lifetime.current === token && flight.current === attempt) {
        flight.current = null;
        setSubmitting(false);
      }
    }
  };
  const submitCreate = () => submit(() => {
    const requestedAt = requestedDate === '' ? now() : localDateTimeToIso(requestedDate, requestedTime);
    return { intent: { kind: 'create', input: {
      jobId: mintJobId(), salesCycleId: wonCycleId.trim() === '' ? null : wonCycleId.trim(), requestedAt,
    } }, date: requestedDate, time: requestedTime, cycle: wonCycleId };
  });
  const submitFill = () => {
    if (fillingJobId === null || acceptedDate === '') return;
    const jobId = fillingJobId;
    void submit(() => ({ intent: { kind: 'fill', input: {
      jobId, contractorAcceptedAt: localDateTimeToIso(acceptedDate, acceptedTime),
    } }, date: acceptedDate, time: acceptedTime, cycle: '' }));
  };

  return (
    <div className="friday-jobs">
      {validation && <p role="alert">{validation}</p>}
      <form
        className="friday-jobs__create"
        onSubmit={(event) => {
          event.preventDefault();
          void submitCreate();
        }}
      >
        <div className="friday-jobs__field">
          <label htmlFor="friday-job-requested-date">Requested date</label>
          <input
            id="friday-job-requested-date"
            type="date"
            value={requestedDate}
            readOnly={blocked}
            onChange={(event) => { if (!blocked && !flight.current) setRequestedDate(event.target.value); }}
          />
        </div>
        <div className="friday-jobs__field">
          <label htmlFor="friday-job-requested-time">Requested time</label>
          <input
            id="friday-job-requested-time"
            type="time"
            value={requestedTime}
            readOnly={blocked}
            onChange={(event) => { if (!blocked && !flight.current) setRequestedTime(event.target.value); }}
          />
        </div>
        <div className="friday-jobs__field">
          <label htmlFor="friday-job-won-cycle">Won sales cycle (optional)</label>
          <input
            id="friday-job-won-cycle"
            type="text"
            value={wonCycleId}
            readOnly={blocked}
            onChange={(event) => { if (!blocked && !flight.current) setWonCycleId(event.target.value); }}
          />
        </div>
        <Button type="submit" disabled={blocked}>Request job</Button>
      </form>

      <div>
        {mutation.status === 'unconfirmed' && <Button onClick={() => { void onRetryMutation(); }}>Retry</Button>}
        <Button variant="quiet" disabled={submitting || mutation.status === 'pending'}
          onClick={() => { void onRefreshJobs(); }}>Refresh jobs</Button>
      </div>

      {jobs.length > 0 && (
        <ul className="friday-jobs__list">
          {jobs.map((job) => (
            <li key={job.id} className="friday-jobs__row">
              <span className="friday-jobs__id">{job.id}</span>
              <StatusPill tone={statusTone(job.status)}>
                {statusLabel[job.status]}
              </StatusPill>
              {job.contractorAcceptedAt !== null && (
                <span className="friday-jobs__accepted">
                  Contractor accepted{' '}
                  {accepted.format(new Date(job.contractorAcceptedAt))}
                </span>
              )}
              {job.status === 'requested' && (
                <span className="friday-jobs__actions">
                  <Button
                    variant="quiet"
                    disabled={blocked}
                    aria-label={`Fill ${job.id}`}
                    onClick={() => {
                      if (blocked || flight.current) return;
                      setFillingJobId(job.id);
                      setAcceptedDate('');
                      setAcceptedTime('');
                    }}
                  >
                    Fill
                  </Button>
                  <Button
                    variant="danger"
                    disabled={blocked}
                    aria-label={`Cancel ${job.id}`}
                    onClick={() => { void submit(() => ({ intent: { kind: 'cancel', input: { jobId: job.id } }, date: '', time: '', cycle: '' })); }}
                  >
                    Cancel
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {fillingJobId !== null && (
        <div
          className="friday-jobs__confirm"
          role="group"
          aria-label={`Fill ${fillingJobId}`}
        >
          <p className="friday-jobs__confirm-copy">
            Contractor acceptance is the fill event. Enter the date and time
            the contractor accepted this job.
          </p>
          <div className="friday-jobs__confirm-fields">
            <div className="friday-jobs__field">
              <label htmlFor="friday-job-accepted-date">Accepted date</label>
              <input
                id="friday-job-accepted-date"
                type="date"
                value={acceptedDate}
                readOnly={blocked}
            onChange={(event) => { if (!blocked && !flight.current) setAcceptedDate(event.target.value); }}
              />
            </div>
            <div className="friday-jobs__field">
              <label htmlFor="friday-job-accepted-time">Accepted time</label>
              <input
                id="friday-job-accepted-time"
                type="time"
                value={acceptedTime}
                readOnly={blocked}
            onChange={(event) => { if (!blocked && !flight.current) setAcceptedTime(event.target.value); }}
              />
            </div>
          </div>
          <div className="friday-jobs__confirm-actions">
            <Button onClick={submitFill} disabled={blocked}>Confirm fill</Button>
            <Button
              variant="quiet"
              disabled={blocked}
              onClick={() => {
                if (blocked || flight.current) return;
                setFillingJobId(null);
                setAcceptedDate('');
                setAcceptedTime('');
              }}
            >
              Keep requested
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
