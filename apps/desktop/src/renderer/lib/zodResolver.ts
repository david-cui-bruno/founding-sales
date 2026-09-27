import type { FieldErrors, FieldValues, Resolver } from 'react-hook-form';
import type { z } from 'zod';

/**
 * A react-hook-form resolver over a Zod schema.
 *
 * `@hookform/resolvers` is the package that usually does this, and it is eleven lines of
 * work: this build would rather own them than take another dependency into the packaged
 * app for them. The message a field shows is the one the schema gives, so the sentence a
 * person reads and the rule that refused their input are the same thing.
 */
export function zodResolver<T extends FieldValues>(schema: z.ZodType<T>): Resolver<T> {
  return async values => {
    const parsed = schema.safeParse(values);
    if (parsed.success) return { values: parsed.data, errors: {} };
    const errors: Record<string, { type: string; message: string }> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.');
      // The first thing wrong with a field is the thing to say about it.
      if (key.length > 0 && errors[key] === undefined) errors[key] = { type: issue.code, message: issue.message };
    }
    return { values: {}, errors: errors as FieldErrors<T> };
  };
}
