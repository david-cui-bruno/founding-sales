import type { CallSessionRefusalCode, DialRefusalCode } from '@fss/contracts';

export type CallSessionRefusal = DialRefusalCode | CallSessionRefusalCode | 'invalid_input';
export type CallSessionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: CallSessionRefusal };
