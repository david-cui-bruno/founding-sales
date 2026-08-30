# Callie Apple Bridge Protocol V1

This is the normative, fixed V1 JSON Lines protocol between Callie's Electron main process and its bundled Swift helper. Every frame is one UTF-8 JSON object followed by `\n`, must be at most 262,144 bytes including that newline, and must have `v: 1`. The helper runs only as Callie's app-open child process.

Each envelope is strict: unknown top-level fields and unknown parameter fields are invalid. Request and response `id` values are UUIDs. Events have a non-negative integer `seq`. The bridge accepts no generic AppleScript, shell, SQL, filesystem path, or Accessibility command. Opaque UUIDs identify calls and artifacts; a request cannot select an export destination.

## Requests

| Method | Exact `params` object |
| --- | --- |
| `bridge.hello` | `{ "supportedVersions": [1] }` |
| `capabilities.probe` | `{}` |
| `permissions.requestContacts` | `{}` |
| `permissions.promptAccessibility` | `{}` |
| `call.observe.start` | `{}` |
| `call.observe.stop` | `{}` |
| `recording.armOutgoing` | `{ "callId": "UUID" }` |
| `recording.disarm` | `{ "callId": "UUID" }` |
| `notes.scanCallRecordings` | `{}` |
| `notes.exportCallRecording` | `{ "artifactId": "UUID" }` |
| `messages.sendTest` | `{ "commandId": "UUID", "recipientHandle": "non-empty string up to 256 chars", "body": "non-empty string up to 4000 chars", "confirmation": "I CONSENT TO THIS TEST MESSAGE" }` |
| `messages.scanTestActivity` | `{ "recipientHandle": "non-empty string up to 256 chars" }` |
| `bridge.shutdown` | `{}` |

## Responses and errors

Successful responses are `{ "v": 1, "kind": "response", "id": "UUID", "ok": true, "result": { ... } }`. Failed responses replace `result` with `{ "ok": false, "error": { "code": "…", "message": "1–300 chars", "retryable": false } }`.

The only error codes are `protocol_mismatch`, `invalid_request`, `permission_denied`, `capability_unavailable`, `identity_unresolved`, `control_not_found`, `recording_verification_failed`, `artifact_not_found`, `schema_unsupported`, `timeout`, and `internal`.

## Events

Events are `{ "v": 1, "kind": "event", "seq": 0, "event": "…", "payload": { ... } }`. The fixed event vocabulary is `bridge.ready`, `capability.changed`, `call.stateChanged`, `call.identityResolved`, `call.identityUnresolved`, `recording.attempted`, `recording.verified`, `recording.failed`, `notes.artifactDiscovered`, `notes.exportCompleted`, `notes.transcriptUnavailable`, `messages.activityObserved`, and `bridge.warning`.

Fixture ownership lives in `fixtures/`. Fixtures use only synthetic IDs and non-sensitive data and are decoded by both runtimes.

`messages.sendTest` is a one-shot, explicitly consented test operation. Its `commandId` is distinct from the envelope correlation `id`; clients persist it before dispatch and must not automatically retry an ambiguous send. The helper accepts only the exact confirmation literal above.
