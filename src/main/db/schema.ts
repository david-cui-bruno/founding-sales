export type AppMetaTable = {
  singleton: number;
  schema_version: number;
  created_at: string;
  updated_at: string;
};

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type JobsTable = {
  id: string;
  type: string;
  state: JobState;
  progress_current: number;
  progress_total: number | null;
  retry_count: number;
  payload_json: string;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
};

export type FoundationDatabase = {
  app_meta: AppMetaTable;
  jobs: JobsTable;
};
