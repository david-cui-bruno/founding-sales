import './schemaRuntime.ts';
import { createRoot } from 'react-dom/client';
import { BrowserApp } from './BrowserApp.tsx';
import './browser.css';

const element = document.getElementById('root');
if (element === null) throw new Error('Browser root is missing');
createRoot(element).render(<BrowserApp />);
