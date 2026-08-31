import { useState } from 'react';

import type {
  CancelJobRequest,
  CreateJobRequest,
  FillJobRequest,
  JobRequest,
} from '../../../shared/contracts/fridayContract';
import { Button } from '../../components/Button';
import { StatusPill } from '../../components/StatusPill';

const accepted = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  timeZone: 'UTC',
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
 * visible; the domain excludes them from the fill denominator.
 */
export function JobRequestForm({
  jobs,
  onCreateJob,
  onFillJob,
  onCancelJob,
  now = () => new Date().toISOString(),
}: JobRequestFormProps) {
  const [requestedAt, setRequestedAt] = useState('');
  const [wonCycleId, setWonCycleId] = useState('');
  const [fillingJobId, setFillingJobId] = useState<string | null>(null);
  const [contractorAcceptedAt, setContractorAcceptedAt] = useState('');

  const submitCreate = () => {
    onCreateJob({
      jobId: mintJobId(),
      salesCycleId: wonCycleId.trim() === '' ? null : wonCycleId.trim(),
      requestedAt: requestedAt.trim() === '' ? now() : requestedAt.trim(),
    });
    setRequestedAt('');
    setWonCycleId('');
  };

  const submitFill = () => {
    if (fillingJobId === null || contractorAcceptedAt.trim() === '') {
      return;
    }
    onFillJob({
      jobId: fillingJobId,
      contractorAcceptedAt: contractorAcceptedAt.trim(),
    });
    setFillingJobId(null);
    setContractorAcceptedAt('');
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
          <label htmlFor="friday-job-requested-at">Requested at</label>
          <input
            id="friday-job-requested-at"
            type="text"
            value={requestedAt}
            placeholder={now()}
            onChange={(event) => setRequestedAt(event.target.value)}
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
                      setContractorAcceptedAt('');
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
            Contractor acceptance is the fill event. Enter the timestamp the
            contractor accepted this job.
          </p>
          <div className="friday-jobs__field">
            <label htmlFor="friday-job-accepted-at">Contractor accepted at</label>
            <input
              id="friday-job-accepted-at"
              type="text"
              value={contractorAcceptedAt}
              onChange={(event) => setContractorAcceptedAt(event.target.value)}
            />
          </div>
          <div className="friday-jobs__confirm-actions">
            <Button onClick={submitFill}>Confirm fill</Button>
            <Button
              variant="quiet"
              onClick={() => {
                setFillingJobId(null);
                setContractorAcceptedAt('');
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
