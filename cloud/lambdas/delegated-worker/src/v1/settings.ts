/**
 * `GET /v1/settings`. Slice S1b served two keys from here (the postures and the clearance reference texts); slice S5
 * serves the whole view, and it lives in `settingsView.ts`. This file stays as the name every existing caller and
 * test already imports, so the move is one file added and no import changed.
 */
export { readSettingsView, referenceTexts } from './settingsView';
