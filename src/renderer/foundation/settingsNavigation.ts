/** Convey section intent. The caller's ordinary Settings anchor owns routing. */
export function openSettingsSection(section: 'connections' | 'phone' | 'worker' | 'call-capacity'): void {
  try {
    window.sessionStorage.setItem('callie.settings.section', section);
  } catch { /* Mounted Settings can still receive the event without storage. */ }
  window.dispatchEvent(new CustomEvent('callie:open-settings-section', { detail: section }));
}
