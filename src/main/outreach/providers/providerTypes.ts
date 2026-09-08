export type SetupState = 'unconfigured' | 'ready' | 'locked' | 'reauthorize' | 'error';
export type OutreachStatus = {
  model: SetupState; modelName: string; gmail: SetupState; accountEmail: string | null;
  senderName: string; postalAddress: string;
};
export type ConfigureOutreach = {
  apiKey?: string; model?: string; googleClientId?: string; googleClientSecret?: string;
  senderName?: string; postalAddress?: string;
};
export type GroundedDraftContext = {
  personName: string; organizationLabel: string | null; segment: 'hot' | 'cold' | 'warm';
  stage: string; actionLabel: string | null; facts: { id: string; text: string }[]; playbook: string;
};
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
