// Release mutations that edit the Mac client (`apps/desktop/`).
//
// Loaded by `loadMutations` in scripts/releaseMutationRunner.mjs, which also holds the
// rule that decides an entry's area (MUTATION_AREAS). Each entry's fields are described
// at the top of scripts/releaseMutationCheck.mjs. Append to the end of this file.

/** @type {import('../releaseMutationRunner.mjs').Mutation[]} */
export const MUTATIONS = [
  {
    name: 'the Mac stops opening the Gmail consent screen',
    file: 'apps/desktop/src/main/mailboxBridge.ts',
    find: '        await deps.openExternally(url);\n',
    replace: '',
    suite: ['run', 'test:release', '--', 'test/release/desktopMailbox.check.ts'],
    because:
      'This is production\u2019s first sign-in exactly (24 September 2026, 15:08Z): desktop 1.0.0 signed in and had no way to connect Gmail, because nothing in apps/desktop called POST /gmail/connect or opened the consent URL it returns. A bridge that sends the command and never opens the browser is the same outcome with more code, and a check that searched for the path would stay green; desktopMailbox.check.ts drives the bridge and asserts the URL reached the system browser, so it has to go red.',
  },
  {
    name: 'the preload stops exposing the mailbox bridge to the window',
    file: 'apps/desktop/src/preload/preload.ts',
    find: "contextBridge.exposeInMainWorld('callieMailbox', mailbox);\n",
    replace: '',
    suite: ['run', 'test:release', '--', 'test/release/desktopMailbox.check.ts'],
    because:
      'The bridge can be complete and tested and the This Mac card still have nothing to call, which is 1.0.0 from where David sits. The preload is Electron wiring the release suite cannot run, so desktopMailbox.check.ts asserts the exposure line itself and has to go red when it is gone.',
  },
  {
    name: 'the preload stops exposing the calling-number control to the window',
    file: 'apps/desktop/src/preload/preload.ts',
    find: '  addCallingNumber: async input => await invokeAdmin(ADMIN_IPC_CHANNELS.addCallingNumber, input),\n',
    replace: '',
    suite: ['run', 'test:release', '--', 'test/release/callingNumber.check.ts'],
    because:
      'The bridge can be complete and tested and the Settings screen still have nothing to call, which is 24 September again from where David sits. The preload is Electron wiring the release suite cannot run, so callingNumber.check.ts asserts the exposure line itself and has to go red when it is gone.',
  },
  {
    name: 'the Settings screen attests a number the person did not attest',
    file: 'apps/desktop/src/main/settingsBridge.ts',
    find: '      if (!registered.ok || !input.attested) return await afterCommand(registered, loadCallingNumbers);\n',
    replace: '      if (!registered.ok) return await afterCommand(registered, loadCallingNumbers);\n',
    suite: ['run', 'test:release', '--', 'test/release/callingNumber.check.ts'],
    because:
      'In version one the attestation is the whole of the verification, so a page that sent it for an unticked statement would be verifying the number on the person’s behalf. callingNumber.check.ts presses Add with the statement unticked and has to go red when an attestation is sent anyway.',
  },
  // Lane g65: Today is the home, and the window says what needs you.
  {
    name: 'Home stops asking for a calling number when the person has none',
    file: 'apps/desktop/src/renderer/homeView.ts',
    find: '    if (admin.callingNumbers !== null && inUse(admin.callingNumbers) === null) {\n',
    replace: '    if (admin.callingNumbers === null) {\n',
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/home.test.ts'],
    because:
      'This is 24 September from where David sat: signed in, mailbox connected, and no Call button anywhere, because nothing had told him to attest a number. The Needs-you row is Home\u2019s way of saying so, and it must come from the server\u2019s usedForCalls answer rather than from a list nobody read. home.test.ts reads an empty list and a list with only a retired number, expects the row both times, and has to go red.',
  },
  {
    name: 'the main window may ask the main process to open any window it names',
    file: 'apps/desktop/src/shared/contract.ts',
    find: '  return WINDOW_TARGETS.find(target => target === value) ?? null;\n',
    replace: '  return typeof value === \'string\' ? (value as WindowTarget) : null;\n',
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/desktop.test.ts'],
    because:
      'openWindow is the one channel a page uses to reach past itself, and registerBridge opens only what windowTargetOf returns. A check that accepted any string would hand the main process names it has no opener for \u2014 today, __proto__, a file name \u2014 and the renderer\u2019s word would be taken for a shape. desktop.test.ts sends each of those and has to go red.',
  },
  {
    name: 'the Today lanes are re-sorted on the Mac instead of shown in the server\u2019s order',
    file: 'apps/desktop/src/renderer/todayView.ts',
    find: '  const cards = state.cards.map(card => ({\n',
    replace: '  const cards = [...state.cards].sort((left, right) => Date.parse(left.dueAt) - Date.parse(right.dueAt)).map(card => ({\n',
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/today.test.ts'],
    because:
      'Specification 8.2 orders the list by lane first and the snapshot decides it; Home draws its sections from runs of that order and never repairs it. A client sort by due instant is the plausible mistake \u2014 it puts a three-week-old new firm above today\u2019s callback \u2014 and a second implementation of 8.2 that would disagree with the first the day either changed. today.test.ts keeps the new firm second and has to go red.',
  },
  {
    name: 'Home asks a person with a saved, unattested number to add one again',
    file: 'apps/desktop/src/renderer/homeView.ts',
    find: '      rows.push(callingNumberNeed(missingNumber(admin.callingNumbers)));\n',
    replace: "      rows.push(callingNumberNeed('none'));\n",
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/home.test.ts'],
    because:
      'An unticked Add leaves a registered, unverified number, and before lane g69 Home answered it with Add your calling number, which invites a second registration of a number that is already there. home.test.ts expects Attest your calling number for a saved number and Re-attest for a retired one, and has to go red when every case reads Add.',
  },
  {
    name: 'a renewal keeps the credentials and drops the role the server sent',
    file: 'apps/desktop/src/main/sessionManager.ts',
    find: '        device = current;\n        await options.store.saveDevice(current);\n',
    replace: '',
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/desktop.test.ts'],
    because:
      'The renewal carries the membership’s current role, and a Mac that ignored it stayed a salesperson after an admin promoted it: no Domain row on Home, no sending section in Administration, until the next full sign-in. desktop.test.ts renews after a promotion and a demotion, reads the role in memory, on disk and through an open Administration bridge, and has to go red.',
  },
  {
    name: 'the updater stops checking at launch',
    file: 'apps/desktop/src/main/updater.ts',
    find: '  const launch = updater.atLaunch();\n',
    replace: "  const launch = Promise.resolve({ kind: 'nothing', decision: null } as const);\n",
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/updater.test.ts'],
    because:
      'Audit item G11: startUpdateWatch only armed a six-hour interval, so opening Callie never updated it. updater.test.ts starts the watch with an hour-long interval and expects the channel to have been asked once and the start recorded; with the launch check gone nothing asks and it has to go red.',
  },
  {
    name: 'the deep signature check stops naming the running team',
    file: 'apps/desktop/src/main/updateInstall.ts',
    find: '  return `=anchor apple generic and certificate leaf[subject.OU] = "${teamIdentifier}"`;\n',
    replace: "  return '=anchor apple generic';\n",
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/updateInstall.test.ts'],
    because:
      'codesign --verify alone proves a seal is intact, not who made it, and a self-signed certificate can carry any Team ID; the requirement is what ties the chain to Apple and to this team. The fake codesign passes a verify only when the requirement names the bundle’s team, so every install in updateInstall.test.ts is refused and it has to go red.',
  },
  {
    name: 'a bundle signed by another team is not compared with the running app',
    file: 'apps/desktop/src/main/updateInstall.ts',
    find: "  if ((await readTeamIdentifier(input.bundlePath, host.run)) !== runningTeam) return refuse('update_bundle_team_mismatch');\n",
    replace: '',
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/updateInstall.test.ts'],
    because:
      'The brief’s refusal is the Team ID from codesign -dv against the running app’s. updateInstall.test.ts offers a bundle signed by another team and an ad-hoc one and expects update_bundle_team_mismatch; without the comparison the refusal comes, if at all, from the deep verify under another name, and it has to go red.',
  },
  {
    name: 'the bundle’s version is not compared with the manifest’s',
    file: 'apps/desktop/src/main/updateInstall.ts',
    find: "  if (version !== input.releaseVersion) return refuse('update_bundle_version_mismatch');\n",
    replace: '',
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/updateInstall.test.ts'],
    because:
      'A signed manifest for 1.0.6 must not install whatever bundle its zip holds. updateInstall.test.ts ships a 1.0.7 bundle under a 1.0.6 manifest and expects nothing renamed in Applications; without the comparison the newer bundle is swapped in and relaunched and it has to go red.',
  },
  {
    name: 'a failed final rename does not put the running bundle back',
    file: 'apps/desktop/src/main/updateInstall.ts',
    find: '    const restored = await attempt(async () => { await host.files.rename(previous, running.path); });\n',
    replace: '    const restored = true;\n',
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/updateInstall.test.ts'],
    because:
      'The swap must never leave half an app: when the new bundle cannot be put in place, the running one goes back where it was. updateInstall.test.ts fails that rename and expects Callie 1.0.5 at /Applications/Callie.app and the undo in the rename log; without the undo Applications holds no Callie and it has to go red.',
  },
  {
    name: 'the previous bundle is removed even when the start could not be recorded',
    file: 'apps/desktop/src/main/updateInstall.ts',
    find: '  if (!recorded) return { confirmed: null, held, removed: [] };\n',
    replace: '',
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/updateInstall.test.ts'],
    because:
      'The previous bundle is the manual restore, and it may go only after the new version has recorded a start. updateInstall.test.ts makes launched.json unwritable and expects .Callie-1.0.5.previous still there; without the guard it is swept anyway and it has to go red.',
  },
  {
    name: 'the sweep beside the running bundle removes more than Callie’s own leftovers',
    file: 'apps/desktop/src/main/updateInstall.ts',
    find: '      if (!LEFTOVER_NAME.test(name)) continue;\n',
    replace: '',
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/updateInstall.test.ts'],
    because:
      'The sweep runs in /Applications. updateInstall.test.ts keeps another vendor’s app and a file named .Callie-notes beside Callie and expects both after the sweep; with the name filter gone the sweep deletes the whole folder, Callie included, and it has to go red.',
  },
  {
    name: 'a restored build reinstalls the version that never started',
    file: 'apps/desktop/src/main/updateInstall.ts',
    find: "          if (held.includes(manifest.releaseVersion)) return { kind: 'held', version: manifest.releaseVersion };\n",
    replace: '',
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/updateInstall.test.ts'],
    because:
      'install.md’s restore is useless if the next launch puts the broken version straight back. updateInstall.test.ts restores 1.0.5 by hand after 1.0.6 never started and expects the launch to answer held with nothing downloaded; without the check 1.0.6 is installed again and it has to go red.',
  },
  {
    name: 'a verified answer that withdrew the release leaves the staged copy installable',
    file: 'apps/desktop/src/main/updateInstall.ts',
    find: "  return decision.kind === 'up_to_date' || (decision.kind === 'refused' && decision.reason === 'update_downgrade_refused');\n",
    replace: '  return false;\n',
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/updateInstall.test.ts'],
    because:
      'The channel is the operator’s way to pull a release: a verified up_to_date after a hit means the staged copy is no longer offered. updateInstall.test.ts stages 1.0.6, then answers up_to_date at launch and expects Applications untouched; with the staged copy kept it is installed anyway and it has to go red.',
  },
  {
    name: 'the in-use check installs at once instead of offering Restart',
    file: 'apps/desktop/src/main/updateInstall.ts',
    find: '        if (await options.blocked()) {\n',
    replace: '        if (true) {\n',
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/updateInstall.test.ts'],
    because:
      'While Callie is in use a staged update waits for Restart to update or the next launch; only a build the raised minimum has blocked installs at once. updateInstall.test.ts runs the periodic check unblocked and expects ready with Applications untouched; installing regardless relaunches a working app mid-call and it has to go red.',
  },
  {
    name: 'a swap that failed relaunches anyway',
    file: 'apps/desktop/src/main/updateInstall.ts',
    find: "    if (swapped.kind === 'failed') {\n",
    replace: "    if (swapped.kind === 'failed' && false) {\n",
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/updateInstall.test.ts'],
    because:
      'An install that fails after verification falls back to the verified zip in Downloads and leaves the app running. updateInstall.test.ts fails each of the three renames and expects no relaunch, the zip revealed and G13a’s sentence; relaunching instead restarts into whatever the failed swap left and it has to go red.',
  },
  {
    name: 'Home’s sidebar drops the update line',
    file: 'apps/desktop/src/renderer/homeView.ts',
    find: '  return [mailboxStatus(input), ...adminRows(input), systemStatus(input), ...updateStatus(input)];\n',
    replace: '  return [mailboxStatus(input), ...adminRows(input), systemStatus(input)];\n',
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/home.test.ts'],
    because:
      'The in-use path has one affordance, Restart to update under the version row, and the launch path one notice. home.test.ts expects both rows from the update state; without them a staged update is invisible until the next launch and it has to go red.',
  },
  {
    name: 'every read of Today’s list redraws the lanes again',
    file: 'apps/desktop/src/renderer/todayView.ts',
    find: "  return state === null ? 'null' : JSON.stringify({ ...state, asOf: null });\n",
    replace: "  return state === null ? 'null' : JSON.stringify(state);\n",
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/todayRefresh.test.ts'],
    because:
      'Audit item G05: every read changes asOf, and a focus read that redrew the lanes for it dropped whatever somebody was typing in a snooze reason or a call note. todayRefresh.test.ts requires the same lanes key for two states differing only in asOf and has to go red.',
  },
  {
    name: 'the business day’s rollover no longer reads Today’s list',
    file: 'apps/desktop/src/renderer/todayView.ts',
    find: '  if (rollover !== null && input.lastAttempt < rollover) return true;\n',
    replace: '',
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/todayRefresh.test.ts'],
    because:
      'Audit item G05: a window left open overnight showed yesterday’s list at nine the next morning. todayRefresh.test.ts requires a read on the first tick after 05:00 and 05:10 in the business zone, and after a night asleep, and has to go red.',
  },
  {
    name: 'a read Home makes by itself clears the notice on screen again',
    file: 'apps/desktop/src/main/todayBridge.ts',
    find: '      if (input.quiet === true) {\n',
    replace: '      if (false) {\n',
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/today.test.ts'],
    because:
      'Audit item G05: coming back to the window reads the list again, and a read that cleared “Call recorded.” made the person wonder whether it was. today.test.ts requires a quiet refresh to keep the notice and a pressed Refresh to clear it, and has to go red.',
  },
  {
    name: 'the postures form sends a posture with a statement unticked',
    file: 'apps/desktop/src/renderer/postureView.ts',
    find: '  if (new Set(input.confirmedStatements).size < context.statementCount) {\n',
    replace: '  if (false) {\n',
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/postures.test.ts'],
    because:
      'Audit item G04: a posture is the founder confirming every statement statePosture.ts asks for, and the form says so before sending. postures.test.ts requires the statements issue for a partial confirmation and has to go red.',
  },
  {
    name: 'clearing a contact’s title is sent as “leave it unchanged” again',
    file: 'apps/desktop/src/main/crmBridge.ts',
    find: '      title: input.title,\n',
    replace: '      ...(input.title === null ? {} : { title: input.title }),\n',
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/founderGaps.test.ts'],
    because:
      'Audit item C20: the editor sent null for an emptied title and the bridge dropped the field, which in a patch means unchanged, so a title could never be cleared. founderGaps.test.ts requires the explicit null in the patch and has to go red.',
  },
  {
    name: '“Review and resume” resumes without showing the review',
    file: 'apps/desktop/src/main/sequenceBridge.ts',
    find: '      if (resumeReview?.preview.enrollmentId !== input.enrollmentId) {\n',
    replace: '      if (false) {\n',
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/founderGaps.test.ts'],
    because:
      'Audit item G06: 4.3 asks the salesperson to review the rendered future steps and then resume, and the button used to resume at once. founderGaps.test.ts requires the first press to load the review and send no resume, and has to go red.',
  },
  {
    name: 'a saved draft is numbered 1, 1, 1',
    file: 'apps/desktop/src/renderer/sequenceView.ts',
    find: '    ordinal: index + 1,\n',
    replace: '    ordinal: 1,\n',
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/founderGaps.test.ts'],
    because:
      'Audit item G03: a step’s number is its place in the editor, assigned at save, so a reorder can never leave the gap publishVersion refuses. founderGaps.test.ts requires ordinals 1..n on the wire and has to go red.',
  },
  {
    name: 'a template is written without the sign-off and the stop line',
    file: 'apps/desktop/src/renderer/sequenceView.ts',
    find: '  return `${body.trim()}\\n\\n${templateFooter(signOff)}`;\n',
    replace: '  return body.trim();\n',
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/founderGaps.test.ts'],
    because:
      'Audit item G03: 12.6 requires every automated email to end with the sign-off and the stop line, and the approval refuses a body that does not. The form appends it so the founder never has to type it. founderGaps.test.ts requires the composed body and has to go red.',
  },
  {
    name: 'a refused approval says only http_409',
    file: 'apps/desktop/src/main/sequenceBridge.ts',
    find: '        notice = (refusal?.success === true ? refusal.data.reason : answer.reason).slice(0, NOTICE_LIMIT);\n',
    replace: '        notice = answer.reason;\n',
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/founderGaps.test.ts'],
    because:
      'Lane g88: the approval’s refusal carries every issue after its code, and the transport keeps a code only up to 80 characters, so three issues became http_409 and the author was told nothing. founderGaps.test.ts requires the whole reason from the refusal body and has to go red.',
  },
  {
    name: 'choosing an ambiguous reply’s conversation also declares it human',
    file: 'apps/desktop/src/main/replyBridge.ts',
    find: '        { messageId: input.messageId, selectedOpportunityId: input.opportunityId, human: false },\n',
    replace: '        { messageId: input.messageId, selectedOpportunityId: input.opportunityId, human: true },\n',
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/reply.test.ts'],
    because:
      'Audit item G07: picking the conversation is not answering the reply. human: true would set the firm to manual and stop its enrollments before the person chose a disposition. reply.test.ts requires human false on the resolution and has to go red.',
  },
  {
    name: 'a firm whose opportunity is Lost is enrolled from its page',
    file: 'apps/desktop/src/main/crmBridge.ts',
    find: "      if (page === null || page.visibility !== 'assigned_or_admin' || page.opportunity?.status !== 'open') {\n",
    replace: "      if (page === null || page.visibility !== 'assigned_or_admin' || page.opportunity === null) {\n",
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/founderGaps.test.ts'],
    because:
      'Audit item G03: an enrolment serves an open opportunity (11.2), and the Firm page reads the latest one, open or closed. founderGaps.test.ts requires no enrol command for a Lost firm and has to go red.',
  },
  {
    name: 'turning sending off sends an empty release gate reference',
    file: 'apps/desktop/src/renderer/settingsView.ts',
    find: "    return { ok: true, value: { enabled: values['enabled'] === true, releaseGateReference: reference === '' ? null : reference } };\n",
    replace: "    return { ok: true, value: { enabled: values['enabled'] === true, releaseGateReference: reference } };\n",
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/founderGaps.test.ts'],
    because:
      'Audit item G08: the sending slice’s reference is null or a trimmed non-empty string (sendingEnabledSettingSchema), and an empty box is null. founderGaps.test.ts round-trips every slice through its typed controls and has to go red.',
  },
  {
    name: 'the update channel offers a build to a macOS below its minimum again',
    file: 'apps/desktop/src/main/updateChannel.ts',
    find: "  if (compareVersions(manifest.minimumSystemVersion, system) > 0) return { kind: 'refused', reason: 'update_system_too_old' };\n",
    replace: '',
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/packaging/updateChannel.test.ts'],
    because:
      'Audit N07: the signed manifest carried minimumSystemVersion and nothing read it, so a Mac below it was handed a bundle that cannot start. updateChannel.test.ts signs a manifest asking for 15.5.0 and requires a 15.4.1 Mac to be refused update_system_too_old.',
  },
  {
    name: 'the keychain error goes back to a constructor parameter property',
    file: 'apps/desktop/src/main/keychain.ts',
    find:
      "  readonly reason: 'unavailable' | 'write_failed' | 'remove_failed';\n\n  constructor(reason: 'unavailable' | 'write_failed' | 'remove_failed') {\n    super(`keychain_${reason}`);\n    this.reason = reason;\n",
    replace: "  constructor(readonly reason: 'unavailable' | 'write_failed' | 'remove_failed') {\n    super(`keychain_${reason}`);\n",
    suite: ['run', 'test', '--workspace', 'apps/desktop', '--', 'test/packaging/stripOnly.test.ts'],
    because:
      'The package step runs main-process files under Node’s strip-only TypeScript, which refuses a parameter property, and vitest compiles it happily, so nothing but a Mac noticed. stripOnly.test.ts runs Node’s own stripper over every file the step can reach and has to go red.',
  },
];
