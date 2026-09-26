# G8: the handoff is recorded first, then copied and opened

**Date:** 20 September 2026 · **Lane:** G8 sequences · **Spec:** 11.3, Appendix A, Appendix G 9

## The tension

11.3 describes the gesture in the order a person experiences it: "'Open LinkedIn & copy
message' copies the text, opens the profile, completes the step ... and creates the
successor ... in one transaction."

Three of those four are the database's and happen together. Two of them — the clipboard
write and the browser open — are the Mac's, and either can fail.

## Decision

The order in `apps/desktop/src/main/sequenceBridge.ts` is: call the server, and only if
it accepted, copy the text and open the profile.

## Why

**The completion is the fact.** A clipboard write that succeeded while the completion
failed would leave a salesperson who has pasted a message into LinkedIn looking at a
step FSS still believes is due — and the worker would produce the next email as though
the LinkedIn touch never happened.

**The failure is visible and recoverable.** A completion that succeeded while the
clipboard failed leaves a person looking at a card that says "handed off" with nothing
pasted. They can see that, and the ten-minute undo exists for exactly this. The reverse
failure is invisible.

**The server's state never depends on the client's.** 14.2: "Electron owns
presentation ... it contains no authoritative sequence ... logic." A handoff whose
completion depended on the clipboard would be a step whose state the server could not
explain afterwards.

## What is opened

`isOpenableProfile` admits an `https:` URL whose host is `linkedin.com` or a subdomain
of it, and nothing else. `linkedin.com.example.test` is refused, because the check is on
the parsed hostname rather than on a substring. Anything refused is copied but not
opened, and the notice says so.
