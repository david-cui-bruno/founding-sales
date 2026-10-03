import { z } from 'zod';
import { instant, uuid } from '@fss/contracts';

/**
 * What the window is told about the demo recordings this Mac is importing (lane M4).
 *
 * The main process holds the import (`main/recordings/importer.ts`); the window reads this
 * view and sends three commands naming an item by its opaque id, never by a path. Only the
 * folders that overlapped a Callie meeting are items: a folder that overlapped none is never
 * listed, never read, and never in this view.
 */

/**
 * Only what is not registered yet (M4 reset, R4): a registered recording is the server's, and
 * the firm page reads it from there (`recordings.forFirm`), so a fold or another Mac's upload
 * shows. This Mac's import never shows an uploaded folder of its own.
 */
export const RECORDING_ITEM_STATES = ['waiting', 'needs_matching', 'uploading', 'failed'] as const;
export type RecordingItemState = (typeof RECORDING_ITEM_STATES)[number];

/** A meeting the person may choose for a folder: when it was and whom with. */
export const recordingChoiceSchema = z.strictObject({
  meetingId: uuid,
  startsAt: instant,
  firmId: uuid.nullable(),
  firmName: z.string().max(300).nullable(),
  attendee: z.string().max(320).nullable(),
});
export type RecordingChoice = z.infer<typeof recordingChoiceSchema>;

export const recordingItemIdSchema = z.string().regex(/^[0-9a-f]{32}$/u);

export const recordingItemSchema = z.strictObject({
  itemId: recordingItemIdSchema,
  /** The entry's version: an answer older than what the window shows is not drawn (K7). */
  version: z.number().int().min(1),
  /** The folder's name as Zoom wrote it: the date, the time and the topic. */
  folderName: z.string().max(300),
  startedAt: instant,
  state: z.enum(RECORDING_ITEM_STATES),
  meetingId: uuid.nullable(),
  /** Files sent so far and files to send, for "Uploading n/m". */
  uploaded: z.number().int().min(0),
  total: z.number().int().min(0),
  /** A code `reasonSentence` turns into a sentence, for a failed item. */
  failure: z.string().max(80).nullable(),
  /** The meetings this folder overlapped, for "Choose meeting". */
  choices: z.array(recordingChoiceSchema).max(20),
});
export type RecordingItem = z.infer<typeof recordingItemSchema>;

export const recordingsViewSchema = z.strictObject({
  folder: z.strictObject({
    path: z.string().max(1024),
    isDefault: z.boolean(),
    /** Whether the folder exists and could be listed at the last scan. */
    available: z.boolean(),
  }),
  items: z.array(recordingItemSchema).max(200),
  /** A command's refusal code (`recording_choice_stale`, say), or null. */
  notice: z.string().max(80).nullable(),
  /**
   * A command's answer about its own item (review M4R, finding 12): the item as it is now, or
   * null when it left the view (ignored), at its entry's version. The window applies this and
   * nothing else from a command's answer. Absent on a read.
   */
  answered: z
    .strictObject({ itemId: recordingItemIdSchema, version: z.number().int().min(0), item: recordingItemSchema.nullable() })
    .optional(),
});
export type RecordingsView = z.infer<typeof recordingsViewSchema>;
