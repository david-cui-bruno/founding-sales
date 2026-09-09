import type { DomainTables, PmAccountTables, DelegationTables, MailPersistenceTables, CampaignTables } from './domainSchema';

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
  idempotency_key: string | null;
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

export type FoundationTables = {
  app_meta: AppMetaTable;
  jobs: JobsTable;
};

export type FoundationDatabase = FoundationTables & DomainTables & PmAccountTables & DelegationTables & MailPersistenceTables & CampaignTables;
