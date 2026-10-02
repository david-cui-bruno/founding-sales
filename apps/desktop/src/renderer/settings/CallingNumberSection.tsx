import { useState, type JSX } from 'react';
import type { CallingNumberSectionView } from '../settingsView.ts';
import { inertSentence } from '../settingsView.ts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Field, Row, RowActions, RowMain, Rows } from '../ui/layout.tsx';
import { useKept } from '../replies/kept.ts';
import { FormNotice } from './FormNotice.tsx';
import { Section } from './Group.tsx';

/**
 * "Your calling number" (9.1; lane g60), first on the page because it is the one setting
 * without which Today cannot call anybody.
 *
 * Every role sees it: the number is the person's own, and 9.2 refuses a dial from
 * anybody else's. **Adding it attests it** (wave 2, S4.3) — the number is verified,
 * enabled and usable for calls the moment it is added — so the statement to tick and the
 * Attest button are gone, and what is left is a field and a button. The number goes as
 * typed; the server's `number_invalid` comes back as the page's notice.
 */
export function CallingNumberSection({
  section,
  adding,
  retiring,
  onAdd,
  onRetire,
}: {
  readonly section: CallingNumberSectionView;
  /** This section's own Add is on the wire. Nothing else on the page waits for it. */
  readonly adding: boolean;
  /** Whether this row's own Stop using this number is on the wire (P1-4). */
  retiring(identityId: string): boolean;
  onAdd(input: { readonly e164: string; readonly label: string }): void;
  onRetire(identityId: string): void;
}): JSX.Element {
  const [e164, setE164] = useKept('settings:calling-number:e164', '');
  const [label, setLabel] = useKept('settings:calling-number:label', '');
  const [missing, setMissing] = useState(false);

  return (
    <Section data-testid="calling-number" title="Your calling number" count={section.numbers.length}>
      <p data-testid="calling-number-summary" className="py-1 text-sm">
        {section.summary}
      </p>
      {section.numbers.length === 0 ? null : (
        <Rows data-testid="calling-numbers">
          {section.numbers.map(number => (
            <Row key={number.id} data-testid={`calling-number-${number.id}`} data-status={number.status}>
              <RowMain line={number.line} />
              {number.canRetire ? (
                <RowActions>
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid={`calling-number-retire-${number.id}`}
                    disabled={retiring(number.id)}
                    {...(retiring(number.id) ? { 'aria-busy': true } : {})}
                    onClick={() => {
                      onRetire(number.id);
                    }}
                  >
                    Stop using this number
                  </Button>
                </RowActions>
              ) : null}
            </Row>
          ))}
        </Rows>
      )}

      <div className="mt-3 flex items-end gap-2">
        <Field
          label="Number"
          htmlFor="calling-number-e164"
          hint={section.hint}
          issues={missing ? [{ testId: 'calling-number-missing', text: 'Type the number first.' }] : []}
        >
          <Input
            id="calling-number-e164"
            data-testid="calling-number-e164"
            type="tel"
            placeholder="+1 401 555 0123"
            autoComplete="off"
            disabled={!section.canAdd || adding}
            {...(missing ? { 'aria-invalid': true } : {})}
            value={e164}
            onChange={event => {
              setE164(event.target.value);
            }}
            className="w-56"
          />
        </Field>
        <Field label="A name for it (optional)" htmlFor="calling-number-label">
          <Input
            id="calling-number-label"
            data-testid="calling-number-label"
            type="text"
            placeholder="Mobile"
            autoComplete="off"
            maxLength={80}
            disabled={!section.canAdd || adding}
            value={label}
            onChange={event => {
              setLabel(event.target.value);
            }}
            className="w-44"
          />
        </Field>
        <Button
          data-testid="calling-number-add"
          disabled={!section.canAdd || adding}
          {...(adding ? { 'aria-busy': true } : {})}
          onClick={() => {
            if (e164.trim() === '') {
              setMissing(true);
              return;
            }
            setMissing(false);
            onAdd({ e164, label });
            setE164('');
            setLabel('');
          }}
        >
          Add number
        </Button>
      </div>
      <div className="mt-2 empty:hidden">
        <FormNotice forms={['calling-number']} />
      </div>
      {section.notEditableBecause === null ? null : (
        <p className="mt-2 text-xs text-muted-foreground">{inertSentence(section.notEditableBecause)}</p>
      )}
    </Section>
  );
}
