import { z } from 'zod';

/**
 * What the prepared-brief import shows (lane PB): the file's name, why the file as a whole
 * could not be read, and one row per element of the file — which firm it names and how,
 * or why it will not be imported, and after a commit what the set command answered. Never
 * the brief text or its sources: those stay in the main process until they are sent.
 */
export const briefImportRowSchema = z.strictObject({
  /** 1-based position in the file. */
  index: z.number().int().min(1),
  /** The row's firm as the file names it. */
  label: z.string().min(1).max(320),
  status: z.enum(['matched', 'unmatched', 'ambiguous', 'invalid']),
  /** The field at fault for `invalid`, or the key that named two firms for `ambiguous`. */
  issue: z.string().max(40).nullable(),
  firmName: z.string().max(300).nullable(),
  matchedOn: z.enum(['external_id', 'domain', 'name']).nullable(),
  briefLength: z.number().int().min(0),
  sourceCount: z.number().int().min(0),
  /** After a commit: `saved`, or the refusal code. Null before, and for rows never sent. */
  result: z.string().max(80).nullable(),
});
export type BriefImportRow = z.infer<typeof briefImportRowSchema>;

export const briefImportViewSchema = z.strictObject({
  fileName: z.string().max(500).nullable(),
  fileError: z.enum(['not_json', 'not_array', 'empty', 'too_many_rows', 'too_large']).nullable(),
  /** The match read did not answer: its code. */
  reason: z.string().max(80).nullable(),
  rows: z.array(briefImportRowSchema).max(2000),
});
export type BriefImportView = z.infer<typeof briefImportViewSchema>;
