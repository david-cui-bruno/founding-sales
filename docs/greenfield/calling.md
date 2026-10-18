# Calling and recording outcomes

Callie supports human-chosen calling from Today and a firm's record. A stored phone route is not permission or a guarantee that somebody will answer. Start with the [selling guide](../operations/how-to-sell.md), [calling policy](policy.md) and current server refusals. This document describes source behavior, not installed setup or a live call acceptance.

## Before calling

Settings → Calling holds the calling number, personal state-rule confirmations, in-app calling switch, daily budget and voicemail script. The server decides eligibility from the current firm, actor, route, applicable holds, suppression, calling window, posture and configured number. A state on a list is not a substitute for the salesperson's own required confirmation. Opening the phone app does not establish a completed provider call.

The dialing boundary is `packages/domain/dial/`, with call sessions, recording and interpretation under `packages/domain/calls/`. Use those modules and the wire contracts for exact outcome values rather than inventing a new consent category. Paid provider work has separate budget, reservation and uncertainty handling. Do not retry an unknown provider outcome as if it never happened.

## After the call

Record the actual outcome, notes and callback information on the firm. Reached outcomes stop the old active sequence. A human may choose a supported post-call follow-up, but an outcome label by itself does not authorize a send. An agreed-sequence choice attempts the matching enrollment immediately. A single-email permission requires explicit enrollment in the matching one-step sequence. See [sequences](sequences.md). Corrections are auditable and must not erase original contact history or revive a cancelled follow-up.

Do-not-call and refusal facts remain effective across later edits, imports and channel changes. Call summaries and analysis are suggestions until their supported confirmation boundary is used. A recording, transcript or inferred promise is not fresh outreach authority.

## Recordings and recovery

Recording, transcription and analysis have separate configuration, source access and spending boundaries. Current startup registers only adapters actually present. Keep private audio/transcripts out of logs and public artifacts. Retention and deletion must close dependent work and preserve uncertain charges, not merely hide a recording in the UI. See [retention](retention.md).

## Verification seams

Use the existing API call, worker call and domain dial/calls tests, plus actual rendered outcome flows when changing the UI. Controlled providers and disposable PostgreSQL prove policy and race behavior, not a real call, a valid telephone number or legal permission. [Sending safeguards](sending.md) and [suppression](suppression.md) remain independently applicable.
