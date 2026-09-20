import type { DesktopBridge, DesktopState } from '../shared/contract.ts';
import { buildScreenView } from './viewModel.ts';

/**
 * The window.
 *
 * Deliberately plain: no framework, no build step beyond a transpile, and every
 * value written to the page through `textContent` rather than `innerHTML`, so a firm
 * name that contains a tag is a firm name. The renderer holds no rule of its own —
 * it asks `buildScreenView` what to show and does that.
 */

const bridge = (): DesktopBridge => {
  const value = globalThis.callie;
  if (value === undefined) throw new Error('the Callie bridge is not present');
  return value;
};

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { readonly className?: string; readonly text?: string; readonly testId?: string } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className !== undefined) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.testId !== undefined) node.dataset['testid'] = options.testId;
  return node;
}

function renderSignIn(root: HTMLElement, busy: boolean, enabled: boolean): void {
  const form = element('form', { className: 'sign-in', testId: 'sign-in-form' });

  const workspaceLabel = element('label', { text: 'Workspace' });
  const workspace = element('input');
  workspace.name = 'workspaceId';
  workspace.required = true;
  workspace.autocomplete = 'off';
  workspace.dataset['testid'] = 'workspace-id';
  workspaceLabel.append(workspace);

  const labelLabel = element('label', { text: 'Name this Mac' });
  const deviceLabel = element('input');
  deviceLabel.name = 'deviceLabel';
  deviceLabel.required = true;
  deviceLabel.value = 'This Mac';
  deviceLabel.dataset['testid'] = 'device-label';
  labelLabel.append(deviceLabel);

  const submit = element('button', { text: busy ? 'Waiting for your browser…' : 'Sign in with Google' });
  submit.type = 'submit';
  submit.disabled = busy || !enabled;
  submit.dataset['testid'] = 'sign-in';

  form.append(workspaceLabel, labelLabel, submit);
  form.addEventListener('submit', event => {
    event.preventDefault();
    void (async () => {
      render(await bridge().signIn({ workspaceId: workspace.value.trim(), deviceLabel: deviceLabel.value.trim() }));
    })();
    render(null, { busy: true });
  });
  root.append(form);
}

function renderDevice(root: HTMLElement, state: DesktopState): void {
  if (state.device === null) return;
  const panel = element('section', { className: 'device', testId: 'device-panel' });
  panel.append(element('h2', { text: 'This Mac' }));
  const list = element('dl');
  for (const [term, value] of [
    ['Name', state.device.deviceLabel],
    ['Device', state.device.deviceId],
    ['Workspace', state.device.workspaceId],
    ['Role', state.device.role],
    ['Registered', state.device.registeredAt],
  ] as const) {
    list.append(element('dt', { text: term }), element('dd', { text: value }));
  }
  panel.append(list);

  const signOut = element('button', { text: 'Sign out' });
  signOut.dataset['testid'] = 'sign-out';
  signOut.addEventListener('click', () => {
    void (async () => {
      render(await bridge().signOut());
    })();
  });
  panel.append(signOut);
  root.append(panel);
}

function renderToday(root: HTMLElement, state: DesktopState, actionsEnabled: boolean): void {
  const panel = element('section', { className: 'today', testId: 'today-panel' });
  const refresh = element('button', { text: 'Refresh' });
  refresh.dataset['testid'] = 'refresh';
  refresh.addEventListener('click', () => {
    void (async () => {
      render(await bridge().refreshToday());
    })();
  });
  panel.append(refresh);

  const list = element('ul', { testId: 'today-cards' });
  for (const card of state.today?.cards ?? []) {
    const item = element('li', { text: `${card.firmName} — ${card.lane}` });
    item.dataset['testid'] = 'today-card';
    const act = element('button', { text: 'Open' });
    act.disabled = !actionsEnabled;
    act.dataset['testid'] = 'card-action';
    item.append(act);
    list.append(item);
  }
  panel.append(list);
  root.append(panel);
}

let lastState: DesktopState | null = null;

export function render(state: DesktopState | null, options: { readonly busy?: boolean } = {}): void {
  if (state !== null) lastState = state;
  const current = lastState;
  const root = document.querySelector('#app');
  if (!(root instanceof HTMLElement) || current === null) return;
  const view = buildScreenView(current);

  root.replaceChildren();
  root.append(element('h1', { text: view.heading, testId: 'heading' }));

  const banners = element('div', { className: 'banners', testId: 'banners' });
  for (const banner of view.banners) {
    const node = element('p', { className: `banner banner-${banner.tone}`, text: banner.text });
    node.dataset['testid'] = `banner-${banner.tone}`;
    banners.append(node);
  }
  root.append(banners);

  if (view.screen === 'upgrade_required') {
    // The one screen with nothing to press: the upgrade instruction and no controls.
    root.append(element('p', { testId: 'upgrade-only', text: 'Callie will work again once this Mac is updated.' }));
    return;
  }
  if (view.screen === 'sign_in') {
    renderSignIn(root, options.busy ?? false, view.signInEnabled);
    return;
  }
  renderDevice(root, current);
  renderToday(root, current, view.actionsEnabled);
}

export async function boot(): Promise<void> {
  render(await bridge().state());
}

if (typeof document !== 'undefined') {
  void boot();
}
