# G9: the settings editor is a JSON textarea per slice

**Date:** 20 September 2026 · **Lane:** G9 · **Spec:** 10.1, 14.2

The administration window renders each configuration slice as a textarea containing
the slice's JSON, plus a required change note. There is no bespoke form for the postal
footer, none for the ten alarm thresholds, none for the holiday calendar.

## Why

The server chooses the validator from the setting key and answers `invalid_value`
with nothing written. So a form buys exactly one thing — a better error before the
round trip — and costs seven hand-built editors that have to be kept equal to seven
Zod schemas in `packages/contracts/src/settings.ts`. Seven places for the contract to
drift, in a lane whose job is to stop configuration drifting.

The person using this is the founder, on their own Mac, changing a threshold a few
times a year. A textarea of JSON they can see all of is not a hardship, and it shows
them the *whole* slice rather than the fields somebody remembered to put in a form.

A JSON parse failure never reaches the API: the field is marked `aria-invalid` and
nothing is sent. That is not a refusal from the server, so it is not a notice.

## When this should change

When a slice grows a field whose valid values a person cannot be expected to know —
the first one will probably be the holiday calendar, where a date picker is genuinely
better than typing `"2026-12-25"`. At that point build a form for *that* slice and
leave the rest as they are. The view model already carries the parsed value rather
than a string, so a form is a rendering change and not a contract change.
