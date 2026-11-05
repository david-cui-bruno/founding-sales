import type { JSX } from 'react';

const paths = {
  today: 'M4 13 6.5 6h11L20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-5h5a3 3 0 0 0 6 0h5',
  prospects: 'M9 6h11 M9 12h11 M9 18h11 M4 6h.01 M4 12h.01 M4 18h.01',
  calling: 'M5 3h4l2 5-3 2a15 15 0 0 0 6 6l2-3 5 2v4a2 2 0 0 1-2 2C10 21 3 14 3 5a2 2 0 0 1 2-2',
  email: 'M3 5h18v14H3z M3 5l9 7 9-7',
  social: 'M21 11a8 8 0 0 1-8 8H7l-5 3 2-6a8 8 0 1 1 17-5z',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',
  search: 'M16 16 21 21 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  reply: 'M9 14 4 9l5-5 M4 9h10a6 6 0 0 1 6 6v5',
  clock: 'M12 7v5l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
  close: 'M18 6 6 18 M6 6l12 12',
} satisfies Record<string, string>;

export function WorkspaceIcon({ name }: { name: keyof typeof paths }): JSX.Element {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
