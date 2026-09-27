import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every command names a form, and every form's name is consumed (1.0.13, P1-4).
 *
 * The rule is that a person waits for the thing they pressed and for nothing else. It
 * is kept by two halves that live in different files: the hook gives each command a
 * form name, and the control that starts it asks `busy(thatName)` before it disables
 * itself. A name written on one side and not the other is the failure this catches —
 * the holiday Save took a key for two days and no control ever read it, so the button
 * stayed pressable while its own Save was on the wire.
 *
 * It reads the source rather than the rendered page on purpose: an e2e check proves one
 * control at a time, and there are twenty-odd of them. `trust.spec.ts` holds the
 * behaviour for the ones a person meets most.
 */

const here = dirname(fileURLToPath(import.meta.url));
const renderer = resolve(here, '..', 'src', 'renderer');

/** The hooks that hand out form names, and the views that consume them. */
const AREAS = [
  {
    area: 'Administration',
    hook: 'settings/useAdmin.ts',
    views: [
      'settings/Administration.tsx',
      'settings/SettingRow.tsx',
      'settings/SettingsView.tsx',
      'settings/PosturesSection.tsx',
      'settings/CallingNumberSection.tsx',
      'settings/SendingSection.tsx',
      'settings/Panels.tsx',
    ],
  },
  {
    area: 'Firms',
    hook: 'firms/useCrm.ts',
    views: ['firms/FirmsRoute.tsx', 'firms/FirmPage.tsx', 'firms/PipelineBoard.tsx'],
  },
  {
    area: 'Sequences',
    hook: 'sequences/useSequences.ts',
    views: ['sequences/SequencesRoute.tsx', 'sequences/StepEditor.tsx'],
  },
  { area: 'Today', hook: 'today/useToday.ts', views: ['today/Lanes.tsx', 'today/TaskRow.tsx', 'today/OutcomeForm.tsx'] },
] as const;

/**
 * The names a hook hands to `command(...)`, reduced to what a consumer can match on: a
 * literal key, or the constant part of a template like `setting:${...}` → `setting:`.
 */
function formsIn(source: string): readonly string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/command\(\s*'([a-z-]+)'/gu)) if (match[1] !== undefined) names.add(match[1]);
  for (const match of source.matchAll(/command\(\s*`([a-z-]+):\$\{/gu)) if (match[1] !== undefined) names.add(`${match[1]}:`);
  // Today names its forms through `todayForm`, which is the same agreement in one place.
  for (const match of source.matchAll(/^\s{2}([a-z]+): \(/gmu)) if (match[1] !== undefined) names.add(match[1]);
  return [...names];
}

async function read(path: string): Promise<string> {
  return await readFile(join(renderer, path), 'utf8');
}

describe('a command holds its own form and nothing else', () => {
  for (const { area, hook, views } of AREAS) {
    it(`${area}: every form name a command takes is read by a control`, async () => {
      const source = await read(hook);
      const forms = formsIn(source);
      expect(forms.length, `${hook} hands out no form names`).toBeGreaterThan(0);

      const consumers = (await Promise.all(views.map(async view => await read(view)))).join('\n');
      const unread = forms.filter(form => {
        // `busy('holidays')`, `busy(\`setting:${key}\`)`, or a named prop derived from
        // one — `busy('sending-cap')` threaded in as `capping`. All three are the same
        // question asked of the same map, so matching the name is what matters.
        const literal = `'${form}'`;
        const templated = `\`${form}`;
        const viaTodayForm = `todayForm.${form}(`;
        return !consumers.includes(literal) && !consumers.includes(templated) && !consumers.includes(viaTodayForm);
      });

      expect(unread, `${area} takes a form key no control waits on`).toEqual([]);
    });
  }

  it('Replies names its forms by the card, and every control on a card asks for that card', async () => {
    // The only area whose form name is an id rather than a word: one reply card is one
    // form, so its own `messageId` is the name and nothing else can match it.
    const hook = await read('replies/useReplies.ts');
    expect(hook).toContain('apply(api()?.command(\'replies.confirm\', input), input.messageId)');
    expect(hook).toContain('apply(api()?.command(\'replies.resolve\', input), input.messageId)');

    const view = await read('replies/RepliesView.tsx');
    for (const control of ['confirm', 'candidate-submit', 'reply-open']) {
      expect(view, `the ${control} control does not wait on its own card`).toContain(`data-testid="${control}"`);
    }
    expect(view).toContain('replies.busy(card.messageId)');
    expect(view).toContain('replies.busy(summary.card.messageId)');
  });

  it('no view disables itself on the whole view’s pending count', async () => {
    // What P1-4 replaced: `pending > 0` in a `disabled`, which is every command
    // anywhere in the view rather than this form's own.
    for (const { views } of [...AREAS, { views: ['replies/RepliesView.tsx'] as const }]) {
      for (const view of views) {
        const source = await read(view);
        expect(source, `${view} disables a control on the view's whole pending count`).not.toMatch(
          /disabled=\{[^}]*\bpending\b/u,
        );
      }
    }
  });
});
