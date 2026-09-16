import type { CompanyFactExtractor } from '../../research/companyFactExtraction';
import type { GoogleGrant } from '../../../../cloud/lambdas/delegated-worker/src/googleGrantCapabilities';
export type { GoogleCapability, GoogleGrant } from '../../../../cloud/lambdas/delegated-worker/src/googleGrantCapabilities';
import type { AudienceQuery, ResearchLimits, ResearchCapability, CompanyCandidate } from '../../research/companyResearchTypes';
export type SetupState = 'unconfigured' | 'ready' | 'locked' | 'reauthorize' | 'error';
export type OutreachStatus = {
  model: SetupState; modelName: string; gmail: SetupState; accountEmail: string | null;
  senderName: string; postalAddress: string;
};
export type ConfigureOutreach = {
  apiKey?: string; model?: string; googleClientId?: string; googleClientSecret?: string;
  senderName?: string; postalAddress?: string;
};
export type PersonGroundedDraftContext = {
  personName: string; organizationLabel: string | null; segment: 'hot' | 'cold' | 'warm';
  stage: string; actionLabel: string | null; facts: { id: string; text: string }[]; playbook: string;
};
export type CompanyGroundedDraftContext = {
  recipientKind: 'company_business_inbox'; companyName: string; purpose: 'prepare_first_conversation';
  facts: { id: string; text: string }[]; playbook: string;
  /** The founder's saved sender name from outreach setup, sign-off data only. Absent when unset; never defaulted. */
  senderName?: string;
};
export type GroundedDraftContext = PersonGroundedDraftContext | CompanyGroundedDraftContext;
export type GeneratedDraft = {
  subject: string; body: string; evidenceIds: string[]; provider: 'openai'; model: string; responseId: string;
};
export type FrozenEmail = { commandId: string; from: string; to: string; subject: string; body: string };
export type EmailSendResult =
  | { status: 'accepted'; messageId: string; threadId: string | null }
  | { status: 'not_sent'; reasonCode: string }
  | { status: 'unknown'; reasonCode: string };
export interface PreparedGmailSender {
  readonly accountEmail: string;
  sendOnce(email: FrozenEmail): Promise<EmailSendResult>;
}
export interface OutreachProviders {
  status(): Promise<OutreachStatus>;
  configure(input: ConfigureOutreach): Promise<OutreachStatus>;
  connectGmail(): Promise<OutreachStatus>;
  disconnectGmail(): Promise<OutreachStatus>;
  generate(context: GroundedDraftContext, signal: AbortSignal): Promise<GeneratedDraft>;
  prepare(signal: AbortSignal): Promise<PreparedGmailSender>;
  /** Production manager always implements this. Optional for existing fixture ports. */
  invalidate?(): void;
  dispose(): void;
}

/** Main-only adapter. Electron async safeStorage is wrapped by the composition root. */
export interface SafeStorage {
  isEncryptionAvailable(): boolean | Promise<boolean>;
  encryptString(value: string): Buffer | Promise<Buffer>;
  decryptString(value: Buffer): string | Promise<string>;
}
export type ModelCredentials = { apiKey: string; model: string };
export type GmailCredentials = {
  clientId: string; clientSecret: string; refreshToken: string; accessToken: string;
  expiresAt: number; email: string;
  /** Missing for legacy send-only credentials, never inferred as read/calendar powers. */
  grant?: GoogleGrant;
};
export type StoredCredentials = {
  model: ModelCredentials; gmail: GmailCredentials; senderName: string; postalAddress: string;
};
export type OutreachProviderOptions = {
  directory: string;
  safeStorage: SafeStorage;
  openExternal(url: string): Promise<void>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
};

/** Main-only capability. Deliberately not added to renderer/IPC contracts. */
export interface CompanyResearchModelProvider {
  /** Optional only for old fixtures. Production implements this without browser/search tools. */
  researchCompanyFacts?: CompanyFactExtractor;
  researchCompanies(input: { query: AudienceQuery; limits: ResearchLimits; capability: ResearchCapability }, signal: AbortSignal): Promise<CompanyCandidate[]>;
}
