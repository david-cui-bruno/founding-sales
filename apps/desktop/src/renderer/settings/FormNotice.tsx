import { createContext, useContext, type JSX } from 'react';

/**
 * What the last command said, and which form sent it (S4R, criterion 6).
 *
 * The bridge answers every command with the whole page and one notice. That notice used to
 * be drawn in a banner under the tabs, far from the Save that earned it. `useAdmin` now
 * remembers which form's command was sent last (`lastForm`, the same names `busy(form)`
 * uses), and each section draws the notice beside its own control when the name is its own.
 */

interface Said {
  readonly text: string | null;
  readonly form: string | null;
}

const NoticeContext = createContext<Said>({ text: null, form: null });
export const NoticeProvider = NoticeContext.Provider;

/** Whether `form` is `family` itself or one of its members (`posture` and `posture:<id>`). */
export function inFamily(form: string | null, family: string): boolean {
  return form !== null && (form === family || form.startsWith(`${family}:`));
}

/** The families a section draws the notice for. Every one is listed in `FORM_FAMILIES`. */
export const FORM_FAMILIES = [
  'setting',
  'integration',
  'stage',
  'alert',
  'sending-cap',
  'sending-domain',
  'holidays',
  'calling-number',
  'postures',
  'posture',
] as const;

export function isAttributed(form: string | null): boolean {
  return FORM_FAMILIES.some(family => inFamily(form, family));
}

/**
 * The sentence, beside the control that sent it. `forms` are the families this spot owns;
 * `exact` narrows a family to one member, so two settings do not both show one's answer.
 */
export function FormNotice({ forms, exact }: { readonly forms: readonly string[]; readonly exact?: string }): JSX.Element | null {
  const said = useContext(NoticeContext);
  if (said.text === null || said.form === null) return null;
  const mine = exact === undefined ? forms.some(family => inFamily(said.form, family)) : said.form === exact;
  if (!mine) return null;
  return (
    <p data-testid="notice" role="status" className="text-xs text-muted-foreground">
      {said.text}
    </p>
  );
}
