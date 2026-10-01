import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { readStart } from './state.ts';

/**
 * The Slice 1 design prototype's entry. Development only (`scripts/prototype.ts`); it is
 * not in `BUNDLE_WINDOWS`, so no packaged build contains it.
 */
const container = document.querySelector('#prototype');
if (container instanceof HTMLElement) {
  createRoot(container).render(<App start={readStart(window.location.search)} />);
}
