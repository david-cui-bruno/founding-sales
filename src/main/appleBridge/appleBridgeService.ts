import type { AppleBridgeClientApi } from './appleBridgeClient';
import type {
  BridgeEvent,
  BridgeRequest,
  BridgeResponse,
} from '../../shared/appleBridgeContract';

export type AppleBridgeDisabledReason =
  | 'unsupported_platform'
  | 'not_packaged_or_configured';

export type AppleBridgeDegradedCode =
  | 'staging_unavailable'
  | 'helper_resolution_failed'
  | 'helper_verification_failed'
  | 'helper_launch_failed'
  | 'handshake_failed'
  | 'helper_exited'
  | 'helper_transport_failed'
  | 'helper_shutdown_failed';

export type AppleBridgeStatus =
  | { state: 'disabled'; reason: AppleBridgeDisabledReason }
  | { state: 'starting' }
  | { state: 'ready'; helperVersion: string; protocolVersion: 1 }
  | {
    state: 'degraded';
    code: AppleBridgeDegradedCode;
    message: string;
  };

export interface AppleBridgeService {
  getStatus(): AppleBridgeStatus;
  request<T extends BridgeRequest>(
    request: T,
    timeoutMs?: number,
  ): Promise<BridgeResponse>;
  subscribe(listener: (event: BridgeEvent) => void): () => void;
}

export type AppleBridgeClientSource = {
  getStatus(): AppleBridgeStatus;
  getClient(): AppleBridgeClientApi | undefined;
};

export class SupervisedAppleBridgeService implements AppleBridgeService {
  constructor(private readonly source: AppleBridgeClientSource) {}

  getStatus(): AppleBridgeStatus {
    return this.source.getStatus();
  }

  async request<T extends BridgeRequest>(
    request: T,
    timeoutMs?: number,
  ): Promise<BridgeResponse> {
    const client = this.source.getClient();
    if (this.source.getStatus().state !== 'ready' || client === undefined) {
      throw new Error('Apple integration helper is unavailable.');
    }

    try {
      return await client.request(request, timeoutMs);
    } catch {
      throw new Error('Apple integration helper is unavailable.');
    }
  }

  subscribe(listener: (event: BridgeEvent) => void): () => void {
    const client = this.source.getClient();
    if (this.source.getStatus().state !== 'ready' || client === undefined) {
      return () => undefined;
    }
    return client.subscribe(listener);
  }
}
