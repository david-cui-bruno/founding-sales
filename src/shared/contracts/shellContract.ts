import { z } from 'zod';

/**
 * Desktop shell affordances. Reveal takes no request payload on purpose: the
 * main process resolves the database location itself, so the renderer can
 * never point `showItemInFolder` at an arbitrary path.
 */
export const revealDatabaseResultSchema = z.object({
  revealed: z.literal(true),
}).strict();

export type RevealDatabaseResult = z.infer<typeof revealDatabaseResultSchema>;

export const revealLogDirectoryResultSchema = z.object({
  revealed: z.literal(true),
}).strict();

export type RevealLogDirectoryResult = z.infer<typeof revealLogDirectoryResultSchema>;
