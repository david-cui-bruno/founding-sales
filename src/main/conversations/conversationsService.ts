import type { MutationReceipt } from '../../shared/contracts/commonContract';
import type {
  AttachTranscriptRequest,
  ConversationDetail,
  ConversationDetailRequest,
  ConversationsListRequest,
  ConversationsListResponse,
} from '../../shared/contracts/conversationsContract';

/**
 * Narrow surface the conversations IPC registrar depends on. The final
 * composition owner injects a delegate backed by the encrypted domain.
 */
export type ConversationsProvider = {
  list(input: ConversationsListRequest): Promise<ConversationsListResponse>;
  get(input: ConversationDetailRequest): Promise<ConversationDetail>;
  attachTranscript(input: AttachTranscriptRequest): Promise<MutationReceipt>;
};

/**
 * The conversation queries and the manual transcript-attach command exposed
 * by the encrypted founder-sales domain.
 */
export type ConversationsCommandSource = {
  listConversations(
    input: ConversationsListRequest,
  ): ConversationsListResponse | Promise<ConversationsListResponse>;
  getConversationDetail(
    input: ConversationDetailRequest,
  ): ConversationDetail | Promise<ConversationDetail>;
  attachTranscript(
    input: AttachTranscriptRequest,
  ): MutationReceipt | Promise<MutationReceipt>;
};
