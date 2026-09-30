import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { liveWorkNotice, noticeText } from '../src/renderer/firmWorkspaceView.ts';

/**
 * No window shows a reason or refusal code on its own (call-to-booking R2). A code reaches
 * a person as `reasonSentence(code)`; a string built from the code itself is the bug.
 * This is a static check over the renderer sources, so a new view cannot bring one back
 * without this test naming it.
 */
const RENDERER = fileURLToPath(new URL('../src/renderer', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/u.test(name) ? [path] : [];
  });
}

/** What shows a code as it is: a fallback to the code, or the code interpolated into text. */
const RAW = [
  /\?\? (code|reason|reasonCode|refusal)\b/u,
  /\$\{(code|reasonCode)\}/u,
  /\$\{[A-Za-z.]*\.reasonCode\}/u,
  /\{[A-Za-z.]*\.reasonCode\}/u,
  /: (code|reason);/u,
];

/**
 * Sources owned by another slice that still have a raw fallback, named so the test stays
 * honest: `today/followUpView.ts` (C1) has `ENROL_REFUSALS[code] ?? code`. Remove the entry
 * when that slice lands its own change.
 */
const OWNED_ELSEWHERE = new Set(['today/followUpView.ts']);

describe('the renderer never shows a raw code', () => {
  it('has no fallback to, or interpolation of, a reason code', () => {
    const found: string[] = [];
    for (const path of sources(RENDERER)) {
      const file = relative(RENDERER, path);
      if (OWNED_ELSEWHERE.has(file)) continue;
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return;
          // A React key is not displayed; a line that also calls `reasonSentence` puts the code
          // after a sentence (readError.ts), not on its own.
          if (line.includes(' key={') || line.includes('reasonSentence(')) return;
          if (RAW.some(pattern => pattern.test(line))) found.push(`${file}:${String(index + 1)}: ${line.trim()}`);
        });
    }
    expect(found).toEqual([]);
  });

  it('does not let the exemption outlive the fallback it names', () => {
    for (const file of OWNED_ELSEWHERE) {
      expect(readFileSync(join(RENDERER, file), 'utf8')).toMatch(RAW[0] as RegExp);
    }
  });
});

describe('the live_work_present message', () => {
  it('lists the live enrollments by name and step, never by id', () => {
    const message = liveWorkNotice([
      { sequenceName: 'Spring follow-up', stepNumber: 2 },
      { sequenceName: 'Intro', stepNumber: 1 },
    ]);
    expect(message).toContain('Spring follow-up, step 2');
    expect(message).toContain('Intro, step 1');
    expect(message).not.toContain('live_work_present');
  });

  it('answers a bare live_work_present code with its sentence, not the code', () => {
    const text = noticeText('live_work_present');
    expect(text).not.toBe('live_work_present');
    expect(text).toContain('live sequence');
  });
});
