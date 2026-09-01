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
import type { IpcClient } from '../ipcClient';

const CONVERSATIONS_LIST_CHANNEL = 'conversations:list';
const CONVERSATIONS_GET_CHANNEL = 'conversations:get';
const CONVERSATIONS_ATTACH_TRANSCRIPT_CHANNEL =
  'conversations:attach-transcript';

export type ConversationsApi = {
  list(input: ConversationsListRequest): Promise<ConversationsListResponse>;
  get(input: ConversationDetailRequest): Promise<ConversationDetail>;
  attachTranscript(input: AttachTranscriptRequest): Promise<MutationReceipt>;
};

/** Typed preload API: conversation queries plus manual transcript attach. */
export const createConversationsApi = (client: IpcClient): ConversationsApi => ({
  list: (input) => client.request(
    CONVERSATIONS_LIST_CHANNEL,
    conversationsListRequestSchema,
    conversationsListResponseSchema,
    input,
  ),
  get: (input) => client.request(
    CONVERSATIONS_GET_CHANNEL,
    conversationDetailRequestSchema,
    conversationDetailSchema,
    input,
  ),
  attachTranscript: (input) => client.request(
    CONVERSATIONS_ATTACH_TRANSCRIPT_CHANNEL,
    attachTranscriptRequestSchema,
    mutationReceiptSchema,
    input,
  ),
});
