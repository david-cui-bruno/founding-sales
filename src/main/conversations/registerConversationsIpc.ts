import {
  mutationReceiptSchema,
  type MutationReceipt,
} from '../../shared/contracts/commonContract';
import {
  attachTranscriptRequestSchema,
  conversationDetailRequestSchema,
  conversationDetailSchema,
  conversationsListRequestSchema,
  conversationsListResponseSchema,
  type AttachTranscriptRequest,
  type ConversationDetail,
  type ConversationDetailRequest,
  type ConversationsListRequest,
  type ConversationsListResponse,
} from '../../shared/contracts/conversationsContract';
import { registerValidatedIpc } from '../ipc/registerValidatedIpc';
import type { ConversationsProvider } from './conversationsService';

export const CONVERSATIONS_LIST_CHANNEL = 'conversations:list';
export const CONVERSATIONS_GET_CHANNEL = 'conversations:get';
export const CONVERSATIONS_ATTACH_TRANSCRIPT_CHANNEL =
  'conversations:attach-transcript';

/**
 * Registers exactly the three conversation channels. Requests and responses
 * are re-validated against the strict contracts on both sides of the
 * boundary.
 */
export function registerConversationsIpc(
  provider: ConversationsProvider,
  isTrustedRendererUrl?: (url: string) => boolean,
): () => void {
  const unregisters = [
    registerValidatedIpc<ConversationsListRequest, ConversationsListResponse>({
      channel: CONVERSATIONS_LIST_CHANNEL,
      requestSchema: conversationsListRequestSchema,
      responseSchema: conversationsListResponseSchema,
      handler: (request) => provider.list(request),
      isTrustedRendererUrl,
    }),
    registerValidatedIpc<ConversationDetailRequest, ConversationDetail>({
      channel: CONVERSATIONS_GET_CHANNEL,
      requestSchema: conversationDetailRequestSchema,
      responseSchema: conversationDetailSchema,
      handler: (request) => provider.get(request),
      isTrustedRendererUrl,
    }),
    registerValidatedIpc<AttachTranscriptRequest, MutationReceipt>({
      channel: CONVERSATIONS_ATTACH_TRANSCRIPT_CHANNEL,
      requestSchema: attachTranscriptRequestSchema,
      responseSchema: mutationReceiptSchema,
      handler: (request) => provider.attachTranscript(request),
      isTrustedRendererUrl,
    }),
  ];

  let registered = true;

  return () => {
    if (!registered) {
      return;
    }

    registered = false;
    for (const unregister of unregisters) {
      unregister();
    }
  };
}
