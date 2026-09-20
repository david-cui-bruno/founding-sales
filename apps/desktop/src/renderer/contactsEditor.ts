import type { ContactDto } from '@fss/contracts';
import { button, element, textField } from './firmDom.ts';
import type { ContactEdit } from './firmWorkspaceContract.ts';

/**
 * Editing the people at a firm (specification 7.2).
 *
 * "one active primary contact per firm is permitted but not required."
 *
 * Promotion is a checkbox rather than a radio group, and the reason is worth
 * recording: `createContact`/`updateContact` demote the current primary inside the
 * same transaction that promotes the new one, so the client asks for "make this one
 * primary" and the server does both halves. A radio group would be the client
 * modelling a constraint it does not own, and it would be wrong the moment two
 * windows are open.
 *
 * Demoting without promoting anybody is deliberately not offered here: zero primary
 * contacts is legal, but "nobody is the main contact at this firm any more" is a
 * decision, and an unticked box is not one.
 */

export interface ContactsEditorOptions {
  readonly contacts: readonly ContactDto[];
  readonly enabled: boolean;
  readonly onSave: (edit: ContactEdit) => void;
}

export function renderContactsEditor(root: HTMLElement, options: ContactsEditorOptions): void {
  const panel = element('section', { className: 'contacts', testId: 'contacts-panel' });
  panel.append(element('h2', { text: 'Contacts' }));

  if (options.contacts.length === 0) {
    panel.append(element('p', { testId: 'contacts-empty', text: 'Nobody is recorded at this firm yet.' }));
    root.append(panel);
    return;
  }

  const list = element('ul', { testId: 'contacts-list' });
  for (const contact of options.contacts) {
    const item = element('li', { testId: 'contact-row' });
    item.dataset['contactId'] = contact.id;

    const name = textField(contact.fullName, 'contact-name', options.enabled);
    const title = textField(contact.title ?? '', 'contact-title', options.enabled);

    const primaryLabel = element('label', { text: 'Main contact' });
    const primary = element('input', { testId: 'contact-primary' });
    primary.type = 'checkbox';
    primary.checked = contact.isPrimary;
    // Already the primary: the box records that and there is nothing to ask for.
    primary.disabled = !options.enabled || contact.isPrimary;
    primaryLabel.append(primary);

    const status = element('span', { className: 'contact-status', testId: 'contact-status', text: contact.status });

    const save = button('Save', 'contact-save', options.enabled);
    save.addEventListener('click', () => {
      options.onSave({
        contactId: contact.id,
        fullName: name.value.trim(),
        title: title.value.trim().length === 0 ? null : title.value.trim(),
        makePrimary: primary.checked && !contact.isPrimary,
      });
    });

    item.append(name, title, primaryLabel, status, save);
    list.append(item);
  }
  panel.append(list);
  root.append(panel);
}
