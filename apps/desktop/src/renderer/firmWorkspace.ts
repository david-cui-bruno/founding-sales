import { renderAddFirmForm } from './addFirmForm.ts';
import { button, element } from './firmDom.ts';
import { renderFirmMerge } from './firmMerge.ts';
import { renderFirmPage } from './firmPage.ts';
import { renderImportScreen } from './importScreen.ts';
import { renderPipelineBoard } from './pipelineBoard.ts';
import type { CrmBridge, CrmState, PipelineView } from './firmWorkspaceContract.ts';
import { buildFirmWorkspaceView } from './firmWorkspaceView.ts';

/**
 * The CRM window: the Firm page, the pipeline, and the merge conflict screen.
 *
 * A second entry point beside `renderer.ts` rather than a fifth screen inside it.
 * The Today window is the one a person leaves open all day and it has to stay small
 * and fast; the CRM windows are opened, used and closed. They share the stylesheet,
 * the bridge pattern and the rule that every value reaches the page through
 * `textContent`.
 *
 * Every state change is "ask the bridge, render what came back". There is no local
 * model to go stale, no optimistic update to reconcile, and no way for the window
 * to believe something the API did not say — which is 14.2's "contains no
 * authoritative sequence, suppression, policy, eligibility, or send logic" made
 * structural rather than promised.
 */

const bridge = (): CrmBridge => {
  const value = globalThis.callieCrm;
  if (value === undefined) throw new Error('the Callie CRM bridge is not present');
  return value;
};

let lastState: CrmState | null = null;

function apply(next: Promise<CrmState>): void {
  void (async () => {
    render(await next);
  })();
}

export function render(state: CrmState | null): void {
  if (state !== null) lastState = state;
  const current = lastState;
  const root = document.querySelector('#app');
  if (!(root instanceof HTMLElement) || current === null) return;
  const view = buildFirmWorkspaceView(current);

  root.replaceChildren();
  root.append(element('h1', { text: view.heading, testId: 'heading' }));

  const banners = element('div', { className: 'banners', testId: 'banners' });
  for (const banner of view.banners) {
    const node = element('p', { className: `banner banner-${banner.tone}`, text: banner.text });
    node.dataset['testid'] = `banner-${banner.tone}`;
    banners.append(node);
  }
  root.append(banners);

  if (current.screen === 'firm' && current.firm !== null) {
    renderFirmPage(root, {
      page: current.firm,
      actionsEnabled: view.actionsEnabled,
      redactionNotice: view.redactionNotice,
      onSaveContact: edit => {
        apply(bridge().saveContact(edit));
      },
    });
    return;
  }

  if (current.screen === 'add_firm' && current.addFirm != null) {
    renderAddFirmForm(root, {
      view: current.addFirm,
      actionsEnabled: view.actionsEnabled,
      onSubmit: draft => {
        apply(bridge().addFirm(draft));
      },
      onCancel: () => {
        apply(bridge().openPipeline());
      },
      onOpenFirm: firmId => {
        apply(bridge().openFirm({ firmId }));
      },
    });
    return;
  }

  if (current.screen === 'import' && current.import != null) {
    renderImportScreen(root, {
      view: current.import,
      // 5.2: import is an administrator's command. A salesperson is not offered the button
      // that opens this screen, and the domain refuses them if they reach it anyway.
      actionsEnabled: view.actionsEnabled && current.role === 'admin',
      onPreview: file => {
        apply(bridge().previewImport(file));
      },
      onCommit: () => {
        apply(bridge().commitImport());
      },
      onReset: () => {
        apply(bridge().openImport());
      },
      onDone: () => {
        apply(bridge().openPipeline());
      },
    });
    return;
  }

  if (current.screen === 'pipeline' && current.pipeline !== null) {
    renderCaptureToolbar(root, current, view.actionsEnabled);
    renderUnplacedFirms(root, current.pipeline);
    renderPipelineBoard(root, {
      pipeline: current.pipeline,
      actionsEnabled: view.actionsEnabled,
      onChangeStage: change => {
        apply(bridge().changeStage(change));
      },
      onOpenFirm: firmId => {
        apply(bridge().openFirm({ firmId }));
      },
    });
    return;
  }

  if (current.screen === 'merge' && current.merge !== null) {
    renderFirmMerge(root, {
      merge: current.merge,
      // 7.2 and 5.2: a merge is an explicit audited command and an admin's. A
      // salesperson sees the conflicts and cannot commit the choice.
      actionsEnabled: view.actionsEnabled && current.role === 'admin',
      onResolve: resolution => {
        apply(bridge().resolveMerge(resolution));
      },
    });
    return;
  }

  // A screen with nothing in it is a state the main process should not produce, and
  // saying so is better than an empty window that looks like an empty pipeline.
  root.append(element('p', { testId: 'nothing-to-show', text: 'There is nothing to show here yet.' }));
}

/**
 * Add firm and Import CSV, above the board (lane g84, audit item G02). Import is shown to
 * an administrator only, because 5.2 gives it to them; Add firm to everyone, because a
 * salesperson may create a firm assigned to themselves.
 */
function renderCaptureToolbar(root: HTMLElement, current: CrmState, actionsEnabled: boolean): void {
  const toolbar = element('div', { className: 'toolbar', testId: 'crm-toolbar' });
  const add = button('Add firm', 'open-add-firm', actionsEnabled);
  add.className = 'btn btn-primary';
  add.addEventListener('click', () => {
    apply(bridge().openAddFirm());
  });
  toolbar.append(add);
  if (current.role === 'admin') {
    const importing = button('Import CSV', 'open-import', actionsEnabled);
    importing.addEventListener('click', () => {
      apply(bridge().openImport());
    });
    toolbar.append(importing);
  }
  root.append(toolbar);
}

/**
 * Firms with no open opportunity, which the board has no column for (lane g84). A firm
 * just added or imported is one, and until g84 the board dropped them, so what had just
 * been added was nowhere on screen.
 */
function renderUnplacedFirms(root: HTMLElement, pipeline: PipelineView): void {
  const firms = pipeline.unplacedFirms ?? [];
  if (firms.length === 0) return;
  const section = element('section', { className: 'unplaced', testId: 'unplaced-firms' });
  const heading = element('h2', { className: 'section-head' });
  heading.append(element('span', { text: 'Not in the pipeline yet' }), element('small', { text: String(firms.length) }));
  section.append(heading);
  const list = element('ul', { className: 'rows' });
  for (const firm of firms) {
    const item = element('li', { testId: 'unplaced-firm' });
    item.dataset['firmId'] = firm.id;
    const open = button(firm.name, 'unplaced-open-firm', true);
    open.className = 'btn btn-quiet';
    open.addEventListener('click', () => {
      apply(bridge().openFirm({ firmId: firm.id }));
    });
    item.append(open);
    list.append(item);
  }
  section.append(list);
  root.append(section);
}

export async function boot(): Promise<void> {
  render(await bridge().state());
}

if (typeof document !== 'undefined') {
  void boot();
}
