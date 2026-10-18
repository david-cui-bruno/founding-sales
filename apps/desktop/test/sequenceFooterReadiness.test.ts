import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SENDING_STOP_LINE } from '@fss/contracts';
import { EMPTY_SEQUENCE_STATE, sequenceScreen } from '../src/renderer/sequenceView.ts';
import { templateVersionAnswer } from './support/sequenceAnswers.ts';

const signOff = 'Sam Example';

function panel(body: string, footerSignOff = signOff, approvedAt: string | null = null) {
  const template = templateVersionAnswer({ body, footerSignOff, approvedAt });
  return {
    template,
    panel: sequenceScreen({
      ...EMPTY_SEQUENCE_STATE, online: true, mayMutate: true, isAdmin: true, templates: [template],
    }).templates[0]!,
  };
}

describe('template footer readiness follows server composition, without changing stored copy', () => {
  it.each([
    ['footerless', 'Hello,\n\nCould we compare notes?', signOff],
    ['trimmed configured sign-off', `Hello.\n\n${signOff}`, `  ${signOff}\n `],
    ['name mentioned in prose', 'Hello.\nSam Example discussed repairs.', signOff],
    ['signed', `Hello.\n\n${signOff}`, signOff],
    ['blank separator whitespace', `Hello.\n \t\n${signOff}`, signOff],
    ['recognised legacy block', `Hello.\n\n${signOff}\n${SENDING_STOP_LINE}`, signOff],
  ])('allows %s without rewriting the template', (_name, body, footerSignOff) => {
    const result = panel(body, footerSignOff);
    expect(result.panel.footerPresent).toBe(true);
    expect(result.panel.canApprove).toBe(true);
    expect(result.panel.body).toBe(body);
    expect(result.panel.footer).toBe(footerSignOff);
    expect(result.panel.contentHash).toBe(result.template.contentHash);
    expect(result.template.body).toBe(body);
    expect(result.template.footerSignOff).toBe(footerSignOff);
  });

  it.each([
    ['postscript', `Hello.\n\n${signOff}\n\nP.S. Call Tuesday.`],
    ['single newline', `Hello.\n${signOff}`],
    ['unknown address', `Hello.\n\n${signOff}\nUnknown address`],
    ['legacy line in prose', `Hello.\n${SENDING_STOP_LINE}\nMore text.`],
  ])('retains the genuine %s warning', (_name, body) => {
    const result = panel(body);
    expect(result.panel.footerPresent).toBe(false);
    expect(result.panel.canApprove).toBe(false);
    expect(result.panel.body).toBe(body);
  });

  it('does not warn on an approved footerless version or change its approval', () => {
    const approvedAt = '2026-10-01T00:00:00.000Z';
    const result = panel('Hello,\n\nCould we compare notes?', signOff, approvedAt);
    expect(result.panel.footerPresent).toBe(true);
    expect(result.panel.approved).toBe(true);
    expect(result.panel.canApprove).toBe(false);
    expect(result.template.approvedAt).toBe(approvedAt);
  });

  it('bundles the real renderer view model for the browser without Node built-ins', async () => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL('../src/renderer/sequenceView.ts', import.meta.url))],
      bundle: true, platform: 'browser', format: 'esm', target: 'es2023', write: false, metafile: true,
    });
    expect(Object.keys(result.metafile!.inputs).some(input => input.startsWith('node:'))).toBe(false);
    expect(result.outputFiles[0]!.text).not.toContain('node:crypto');
  });
});
