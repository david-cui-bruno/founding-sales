export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type JobRecord = {
  id: string;
  type: string;
  state: JobState;
  progressCurrent: number;
  progressTotal: number | null;
  retryCount: number;
  payload: unknown;
  result: unknown | null;
  error: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
};

export type EnqueueJobInput = {
  id?: string;
  type: string;
  payload: unknown;
  progressTotal?: number | null;
};
