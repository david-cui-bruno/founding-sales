/**
 * The four lines of DOM every CRM view shares.
 *
 * `textContent`, never `innerHTML`, everywhere and without exception: a firm name,
 * a contact's title and a Lost reason are all text somebody typed, and one of them
 * will contain a tag. The Today window made the same choice and its Playwright spec
 * proves it with `<img src=x onerror=…>`; the CRM specs do the same.
 */

export interface ElementOptions {
  readonly className?: string;
  readonly text?: string;
  readonly testId?: string;
}

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className !== undefined) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.testId !== undefined) node.dataset['testid'] = options.testId;
  return node;
}

/** A term/description pair, the shape every identity panel is made of. */
export function describe(list: HTMLElement, term: string, value: string): void {
  list.append(element('dt', { text: term }), element('dd', { text: value }));
}

export function button(label: string, testId: string, enabled: boolean): HTMLButtonElement {
  const node = element('button', { text: label, testId });
  node.type = 'button';
  node.disabled = !enabled;
  return node;
}

export function textField(value: string, testId: string, enabled: boolean): HTMLInputElement {
  const node = element('input', { testId });
  node.type = 'text';
  node.value = value;
  node.disabled = !enabled;
  node.autocomplete = 'off';
  return node;
}

/** An empty value, shown as a dash rather than as nothing at all. */
export function orDash(value: string | null): string {
  return value === null || value.length === 0 ? '—' : value;
}
