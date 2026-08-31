# Apple communications manual feasibility procedure

This is a consenting, manual-only procedure for a signed test package. It is
never run by `npm test`, `npm run test:swift`, `npm run verify`, `npm run
verify:e2e`, `npm run verify:package`, or CI. Those commands use synthetic
fixtures and an inert packaged smoke test; they never authorize a TCC prompt,
call, message, Notes export, recording, or read of personal Apple data.

Live Apple capability claims remain unproven until a human completes this
procedure on the exact signed package and another person reviews the minimized
results. A green package verifier is a prerequisite, not evidence that a live
Phone, Messages, Notes, or permission flow works.

## Preconditions

- Use a dedicated macOS test user on macOS 26.4+ Apple silicon. Do not use the
  founder's normal macOS account.
- Use an own secondary line or named consenting test partner. The partner must
  know which call or message row is being tested and may stop the test at any
  time.
- Use a stable-signed packaged build with the parent and helper bundle IDs,
  versions, and Team IDs recorded before any permission is granted. An ad-hoc
  package may prove packaging but cannot prove permission persistence.
- No real leads loaded in the isolated `--user-data-dir` profile. The dedicated
  user may contain only synthetic test Contacts, Notes, and Messages data made
  for this procedure.
- Confirm that `npm run test:swift`, `npm run verify`, `npm run verify:e2e`, and
  `npm run verify:package` have passed on the exact commit. Do not replace the
  manual rows below with an automated script.
- Agree on the exact test window with the consenting endpoint. Before a call
  row, both participants must explicitly agree to that call and any recording.
  Before a message row, the named recipient must explicitly agree to receive
  exactly one test message.
- Prepare a new isolated profile and record its absolute path outside the
  repository. In a terminal opened at the project root:

  ```bash
  export CALLIE_APP_PATH="/absolute/path/Callie Founder Sales System.app"
  export CALLIE_HELPER_PATH="$CALLIE_APP_PATH/Contents/Helpers/Callie Apple Bridge.app"
  export CALLIE_APP_EXECUTABLE="$CALLIE_APP_PATH/Contents/MacOS/Callie Founder Sales System"
  export CALLIE_TEST_PROFILE="$(mktemp -d -t callie-apple-feasibility.XXXXXX)"
  export CALLIE_STAGING_ROOT="$CALLIE_TEST_PROFILE/apple-bridge-staging"
  ```

  Stop if `CALLIE_TEST_PROFILE` is empty, is not an absolute path, or does not
  identify the newly created `callie-apple-feasibility.*` directory. Never set
  it to a home directory, the repository, or normal Application Support.

## Stop conditions

Stop the procedure immediately if any of these occur:

- The package identity, signature, version, or minimum OS check fails.
- A TCC prompt appears before the matching explicit control is pressed.
- macOS attributes a permission to an unsigned, unexpected, or differently
  identified binary.
- A real contact, message, note, transcript, recording, or normal founder-data
  path appears in the isolated profile or test UI.
- The consenting endpoint withdraws consent, the identity is not the prepared
  endpoint, or the requested communication is not the agreed test action.
- Callie claims recording success without both the Apple audible notice and an
  independently visible active-recording indication.
- Plaintext remains in the isolated staging directory after an export proof or
  app quit, or cleanup cannot be verified.

Record the row as failed with a sanitized code, quit the app, preserve no raw
content, and use the applicable fallback. Do not retry a send whose outcome is
ambiguous.

## Preflight verification

Run these exact checks against the exact package. The literal paths show the
required bundle locations; replace `/absolute/path` only with the absolute path
to this test package.

```bash
codesign --verify --deep --strict --verbose=4 "/absolute/path/Callie Founder Sales System.app"
codesign -dv --verbose=4 "/absolute/path/Callie Founder Sales System.app/Contents/Helpers/Callie Apple Bridge.app"
codesign -d --entitlements :- "/absolute/path/Callie Founder Sales System.app/Contents/Helpers/Callie Apple Bridge.app"
```

Also run the same checks through the prepared variables:

```bash
codesign --verify --deep --strict --verbose=4 "$CALLIE_APP_PATH"
codesign -dv --verbose=4 "$CALLIE_APP_PATH"
codesign -dv --verbose=4 "$CALLIE_HELPER_PATH"
codesign -d --entitlements :- "$CALLIE_HELPER_PATH"
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$CALLIE_APP_PATH/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$CALLIE_HELPER_PATH/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$CALLIE_HELPER_PATH/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$CALLIE_HELPER_PATH/Contents/Info.plist"
sw_vers -productVersion
sw_vers -buildVersion
```

The parent identifier must be `com.callie.foundersales`. The helper identifier
must be `com.callie.foundersales.applebridge`, its version must match the helper
version displayed by the panel, and its minimum OS must be `26.4`. A
stable-signed package must show the same non-empty Team ID for parent and helper.
The helper entitlement output must contain only the Apple Events automation
entitlement required by the package verifier. Save only the identifiers,
versions, Team ID, and pass/fail result; do not save raw command output if it
contains a local path or account name. Keep this signing attribution as a
separate preflight record; it is not one of the per-row evidence records.

Before launch, inspect System Settings > Privacy & Security under the dedicated
test user and note the existing Contacts, Accessibility, Automation, and Full
Disk Access rows. This is the baseline for attribution. Do not reset or change
permissions belonging to any other app or account.

Launch the packaged executable exactly once with the isolated profile and the
manual spike gate:

```bash
"$CALLIE_APP_EXECUTABLE" --user-data-dir="$CALLIE_TEST_PROFILE" --apple-feasibility-spike
```

Verify all of the following before pressing a panel control:

- The panel is titled **Apple feasibility spike** and reports the expected
  helper version.
- No TCC prompt appeared on startup.
- The normal founder workspace was not opened or modified.
- `CALLIE_STAGING_ROOT` is beneath `CALLIE_TEST_PROFILE`.

If any check fails, stop. Never launch the nested helper directly and never
construct bridge requests by hand to bypass a missing panel control.

## Permission sequence

Perform permission work in this order. After every prompt, return to System
Settings and identify the exact signed bundle whose permission row changed.
Keep bundle ID, signing identity/Team ID, permission category, and observed TCC
attribution in a separate preflight/TCC attribution record. That attribution
record is not a matrix-row result. Never add bundle or signing metadata to a
row: every per-row result remains limited to exactly the seven fields under
**Minimized evidence record** below.

1. Launch with `--apple-feasibility-spike` and verify no prompt on startup.
2. Press **Probe capabilities**. It must report state without prompting.
3. Exercise Contacts denied, limited, then full states through explicit
   controls. Change the dedicated user's state in System Settings, then use
   **Request Contacts access** only when a prompt is intentionally expected and
   **Probe capabilities** to read the result. Limited and denied must never be
   interpreted as proof that an unknown caller is absent from Contacts.
4. Grant Accessibility only after pressing the explicit **Request
   Accessibility access** button. Confirm the attributed signed bundle before
   continuing.
5. Trigger one confirmed test Messages operation and record Automation
   attribution. The recipient must be the prepared consenting endpoint, the
   confirmation field must contain exactly `I CONSENT TO THIS TEST MESSAGE`,
   and the final send control must be pressed once. Do not retry an ambiguous
   outcome.
6. Trigger one Notes scan/export and record Automation attribution. Use **Scan
   recent call notes** for discovery. If the exact package does not expose a
   dedicated export-proof control, record `capability_unavailable`, do not
   launch the helper directly, and use manual recording export/import.
7. Grant Full Disk Access manually to the responsible signed bundle proven by
   the package. Revoke it again after its matrix row. Never grant it to a
   development shell, terminal, unsigned helper, or unexpected bundle merely
   to make a row pass.

Permission state changes are independent test rows. Quit and relaunch the same
signed package with the same isolated profile only where a row explicitly
requires persistence or revocation behavior.

## Consent gates

For each call-observation session, the founder must type exactly
`I CONSENT TO THIS TEST CALL` immediately before pressing **Start call
observation**. This phrase authorizes one observation start; it is not standing
consent, does not itself record a call, and does not replace the other
participant's informed consent. Press **Stop call observation** after the row.

For each permitted message row, the founder must enter only the prepared
endpoint, an agreed synthetic body, and exactly
`I CONSENT TO THIS TEST MESSAGE` in the confirmation field. Changing the
endpoint or body invalidates the confirmation. One press permits one send
attempt. Never retry when delivery is uncertain; inspect the agreed endpoint or
use **Scan test message activity** instead.

Apple's audible recording notice and an independent active-recording indicator
are both required before recording may be described as verified. In this build,
the spike exposes call observation but does not compose recording control; it
must report recording control unavailable. Treat any contrary claim as a stop
condition, not as proof. The current panel also exposes Notes discovery but not
an export-proof control or transcript extraction. Record those rows as `not
exposed`; do not launch the helper directly to bypass the panel.

## Fixture-only exclusions

Never dial emergency numbers, short codes, or voicemail for this test. Test
these exclusions only in committed unit fixtures. Never make a live exclusion
call to “see whether the guard works.” The Never Record row below is also a
synthetic, no-call control row.

## Minimized evidence record

Create one result record per matrix row outside the repository. Every row may
contain only these fields:

| Field | Allowed value |
|---|---|
| Timestamp | UTC timestamp for the observation |
| OS build | `sw_vers -buildVersion` result |
| App/helper version | Package version and helper version only |
| Permission state | Contacts, Accessibility, Automation, and Full Disk Access enums or `not applicable` |
| Capability result | `pass`, `fail`, `degraded`, `unavailable`, or `not exposed` plus a fixed capability label |
| Sanitized error code | A fixed protocol/degradation code or `none`; no free-form error text |
| Artifact hash/byte count | SHA-256 and integer byte count from a successful export proof, otherwise `not applicable` |

Do not add an endpoint, phone number, contact name, local username, file path,
message body, note title/body, transcript, recording, screenshot, raw bridge
frame, raw command output, or free-form anecdote. Never record a phone number,
contact name, message body, transcript, or recording in the repository.

## Safe call, Notes, and Messages matrix

Run only rows whose prerequisites are satisfied by the consenting endpoint and
the exact signed build. “Unavailable” and “not exposed” are valid outcomes; do
not bypass the UI to force a pass. Unless a row says otherwise, start a fresh
single-use observation consent, perform only the named action, record the
minimized result, and stop observation.

| Manual row | Safe action | Expected outcome |
|---|---|---|
| App closed | With Callie fully quit, place one agreed test call between the two test endpoints and end it before voicemail. | No helper remains and Callie observes, records, or writes nothing. The staging directory stays empty. |
| outgoing Callie test call | Open Callie, start observation with the exact call phrase, then place one agreed outgoing call using the supported Callie/Phone surface if exposed. | A Mac-visible call may produce outgoing call-state evidence. Observation is not recording. If recording control is unavailable, use the manual Apple recording tap and record `unavailable` for automatic control. |
| known consenting incoming caller | Put the prepared endpoint in the dedicated user's Contacts, start observation, then accept one agreed incoming call. | The current signed spike may show sanitized call identity evidence but does not expose Contacts-membership or recording-eligibility decisions. Record that decision as `not exposed`, never infer membership from a resolved identity, and use the manual Apple recording tap only after consent. |
| safely classified unknown consenting caller | Remove the prepared endpoint from the dedicated user's Contacts, confirm full Contacts access, start observation, then accept one agreed incoming call. | The current signed spike does not expose the Contacts absence-classification or recording-eligibility result. Record `not exposed`; do not infer “unknown” from observation evidence and do not auto-record. |
| Limited Contacts | Select limited access that does not include the prepared endpoint, probe again, and perform only the agreed incoming observation. | Contacts may report `limited`, but the current signed spike does not expose the downstream eligibility decision. Record eligibility as `not exposed`; absence from the visible subset is not proof of “unknown,” so no auto-record action is allowed. |
| hidden/unresolved identity | The consenting endpoint hides caller ID for one agreed incoming test, where the carrier and endpoint support it. | Identity reports unresolved/ambiguous or the adapter degrades. No auto-record action is eligible; use manual handling only. |
| Never Record synthetic person | Keep this as a no-call control row; do not place a live call or treat committed unit fixtures as signed-package evidence. | The current signed spike does not expose Person-level Never Record policy or its eligibility result. Record `not exposed` and use the no-record fallback; never record fixture content or an endpoint. |
| declined call | Start observation, have the consenting endpoint place one agreed call, and decline it without answering. | Call state ends without connected/verified recording evidence. No artifact is expected. |
| unanswered call | Start observation and allow one agreed call to stop ringing without answering or reaching voicemail. End the test before voicemail. | No connected or verified-recording state is reported and no artifact is expected. |
| answer on Mac | Start observation and answer the agreed call in the Mac Phone/Continuity surface. | If the Phone UI is recognized, Callie reports a connected Mac-visible state. Recording remains manual unless a separate control is exposed and independently verifies active recording. |
| answer only on iPhone | Start observation but answer the agreed call only on the iPhone. | Callie reports no Mac-visible call or a degraded capability. It must not synthesize a connected or recordable call. |
| Mac-to-iPhone handoff | Start and answer the agreed call on the Mac, then perform one planned handoff to the iPhone. | Loss of Mac-visible state degrades observation; Callie must not claim recording continuity. Use the manual iPhone tap and later ingest only if the artifact reaches the Mac. |
| Notes audio export | Use one synthetic Apple call-recording artifact created during this procedure and the dedicated export-proof control, if present. | A successful proof exposes only SHA-256, byte count, and `plaintextRetained=false`; otherwise record `not exposed`/`capability_unavailable` and use manual recording export/import. The staging directory must be empty immediately afterward. |
| transcript present | Use a synthetic test artifact for which Apple created a transcript, only if transcript extraction is exposed. | Record only capability success/failure; never copy transcript text. If extraction is not exposed or structured data is unsupported, use founder-authorized cloud STT or manual transcript. |
| transcript unavailable | Use a synthetic audio artifact with no Apple transcript. | Audio discovery/export remains independent; transcript status is unavailable without fabricating text or treating audio as failed. |
| iCloud Notes unavailable | Disable or sign out of iCloud Notes only in the dedicated test user, then scan. | Notes reports unavailable or zero bounded candidates without crashing, reading another account, or claiming export success. |
| duplicate artifact scan | Press **Scan recent call notes** twice without creating another artifact. | The bounded scan remains idempotent at the artifact identity layer; the panel may show only a stable count. If identity-level proof is not exposed, record `not exposed` rather than infer deduplication. No duplicate export is created. |
| iMessage test | With the prepared iMessage endpoint selected, type the exact message phrase and press the final send control once. | Exactly one send attempt is made. The endpoint or activity result may confirm success, but the record contains only capability pass/fail; an ambiguous outcome is not retried. |
| SMS/RCS only when a consenting endpoint is available | Run only if the prepared endpoint and current Apple surface explicitly support the intended SMS or RCS route; use the exact message phrase once. | Exactly one consented attempt is made and logged as the observed route when unambiguous. If route or recipient is ambiguous, skip and record unavailable. |
| Messages Full Disk Access revoked | Revoke Full Disk Access from the proven responsible bundle, relaunch if macOS requires it, and use only **Scan test message activity** for the prepared endpoint. | The bounded history read reports unavailable/permission denied and does not send, retry, or fabricate activity. |
| helper crash | After no call or send is active, terminate only the exact helper process belonging to this isolated packaged app. | The panel reports a precise degraded helper state, no action succeeds, and the helper is absent after app quit. Do not kill by name or PID without proving package path and process identity. |
| permission revoked mid-call | During one agreed, already connected test call, revoke only the proven Accessibility permission for the signed bundle. | Observation degrades or stops; no new recording action or verified claim occurs. End the call manually and use the fallback. |

## Staging-cleanup proof

For a build that exposes a dedicated Notes export-proof control, run the check
below immediately after every export result and again after Callie fully quits:

```bash
find "$CALLIE_STAGING_ROOT" -mindepth 1 -maxdepth 1 -print
```

Expected output: no lines. The staging directory itself may remain. If the
directory is absent, that is also clean after app quit; if any entry is printed,
record a sanitized cleanup failure, do not open or copy the entry, and stop.
Do not claim a successful proof when `plaintextRetained` is true, cleanup is
unknown, the path changed, or the export control was not exposed.

After the final row:

1. Press **Stop call observation** if the helper is still ready.
2. Quit Callie and wait until both the parent and its exact nested helper have
   exited.
3. Run the staging check again; it must print nothing.
4. Review the minimized records against the allowed-field table.
5. Remove any forbidden field before review. If raw Apple content was written
   to the repository, stop and treat it as an incident; do not commit it.
6. Remove the isolated profile only after visually confirming its absolute path
   is the newly created `callie-apple-feasibility.*` directory. Never use a
   wildcard, home directory, repository path, or normal Application Support as
   the deletion target.

## Capability decision

A capability is **proven for this exact package and OS build** only when its
required rows pass, the TCC attribution matches a verified signed bundle, the
evidence record contains no forbidden data, and cleanup is proven. “Degraded,”
“unavailable,” “not exposed,” an ambiguous send, an iPhone-only call, or a
missing cleanup proof is a failure to prove that capability, not permission to
retry or broaden access.

| Failed capability | V1 fallback |
|---|---|
| Phone AX start/verify | Manual Apple recording tap |
| Notes discovery/export | Manual recording export/import |
| Apple transcript extraction | Founder-authorized cloud STT or manual transcript |
| Messages history read | Send-only plus manual activity logging |
| Incoming identity resolution | No auto-record for that call |
| Mac-to-iPhone recording continuity | Manual iPhone tap and ingest when artifact reaches Mac |
