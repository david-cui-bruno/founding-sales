import { useState } from 'react';

import type {
  CancelJobRequest,
  CreateJobRequest,
  FillJobRequest,
  JobRequest,
} from '../../../shared/contracts/fridayContract';
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
  onCreateJob(input: CreateJobRequest): void;
  onFillJob(input: FillJobRequest): void;
  onCancelJob(input: CancelJobRequest): void;
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
  now = () => new Date().toISOString(),
}: JobRequestFormProps) {
  const [requestedDate, setRequestedDate] = useState('');
  const [requestedTime, setRequestedTime] = useState('');
  const [wonCycleId, setWonCycleId] = useState('');
  const [fillingJobId, setFillingJobId] = useState<string | null>(null);
  const [acceptedDate, setAcceptedDate] = useState('');
  const [acceptedTime, setAcceptedTime] = useState('');

  const submitCreate = () => {
    onCreateJob({
      jobId: mintJobId(),
      salesCycleId: wonCycleId.trim() === '' ? null : wonCycleId.trim(),
      requestedAt: requestedDate === ''
        ? now()
        : localDateTimeToIso(requestedDate, requestedTime),
    });
    setRequestedDate('');
    setRequestedTime('');
    setWonCycleId('');
  };

  const submitFill = () => {
    if (fillingJobId === null || acceptedDate === '') {
      return;
    }
    onFillJob({
      jobId: fillingJobId,
      contractorAcceptedAt: localDateTimeToIso(acceptedDate, acceptedTime),
    });
    setFillingJobId(null);
    setAcceptedDate('');
    setAcceptedTime('');
  };

  return (
    <div className="friday-jobs">
      <form
        className="friday-jobs__create"
        onSubmit={(event) => {
          event.preventDefault();
          submitCreate();
        }}
      >
        <div className="friday-jobs__field">
          <label htmlFor="friday-job-requested-date">Requested date</label>
          <input
            id="friday-job-requested-date"
            type="date"
            value={requestedDate}
            onChange={(event) => setRequestedDate(event.target.value)}
          />
        </div>
        <div className="friday-jobs__field">
          <label htmlFor="friday-job-requested-time">Requested time</label>
          <input
            id="friday-job-requested-time"
            type="time"
            value={requestedTime}
            onChange={(event) => setRequestedTime(event.target.value)}
          />
        </div>
        <div className="friday-jobs__field">
          <label htmlFor="friday-job-won-cycle">Won sales cycle (optional)</label>
          <input
            id="friday-job-won-cycle"
            type="text"
            value={wonCycleId}
            onChange={(event) => setWonCycleId(event.target.value)}
          />
        </div>
        <Button type="submit">Request job</Button>
      </form>

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
                    aria-label={`Fill ${job.id}`}
                    onClick={() => {
                      setFillingJobId(job.id);
                      setAcceptedDate('');
                      setAcceptedTime('');
                    }}
                  >
                    Fill
                  </Button>
                  <Button
                    variant="danger"
                    aria-label={`Cancel ${job.id}`}
                    onClick={() => onCancelJob({ jobId: job.id })}
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
          role="alertdialog"
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
                onChange={(event) => setAcceptedDate(event.target.value)}
              />
            </div>
            <div className="friday-jobs__field">
              <label htmlFor="friday-job-accepted-time">Accepted time</label>
              <input
                id="friday-job-accepted-time"
                type="time"
                value={acceptedTime}
                onChange={(event) => setAcceptedTime(event.target.value)}
              />
            </div>
          </div>
          <div className="friday-jobs__confirm-actions">
            <Button onClick={submitFill}>Confirm fill</Button>
            <Button
              variant="quiet"
              onClick={() => {
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
