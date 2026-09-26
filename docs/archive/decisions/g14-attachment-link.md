# G14: the attachment link is an authorization, not a proxy

**Date:** 20 September 2026 · **Lane:** G14 retention · **Spec:** 10.3, Appendix F, 5.2

## The sentence

> Attachments are not copied into FSS. FSS stores filename, media type, size,
> content hash when available, Gmail message reference, and authorization metadata.
> Authorized users open the original Gmail message to retrieve the file.

Section 17 lists "attachment storage, preview, search, and independent retention" as
deferred. So there is no byte to protect — but there is still something to
authorize, and the specification does not say what.

## Decision

**FSS authorizes the metadata and the link; Gmail authorizes the file.**

`POST /attachments/open` answers with the reference and a `mail.google.com`
permalink for the mailbox the message arrived in. The caller must be the assigned
salesperson of a firm the message matched, the mailbox owner, or an admin — Appendix
F's classes for message content, plus the mailbox owner because it is their mailbox.

This matters even though no byte passes through. A filename is message content: FSS
must not tell an unassigned salesperson that a firm sent something called
`2026-term-sheet.pdf`. Gmail's own check then decides whether the person opening the
link can see the message at all, and neither check substitutes for the other.

**Both refusals are 404.** `message_unknown` and `not_authorized` answer identically,
because telling an unassigned salesperson that the message exists but is not theirs
is the same disclosure the authorization exists to prevent (Appendix G 7).

**The link names the account.** `?authuser=<address>` rather than `/u/0`, because a
person signed into several Google accounts in one browser opens `u/0` as whichever
they signed into first, and for a shared Mac that is how one salesperson's link
opens in another's mailbox and fails with a permission error they cannot explain.
The address is public identity, not a credential.

**An admin read is audited.** 5.2: "Admin reads of message bodies, drafts, mailbox
diagnostics, and exports create access audit events". The event names the message
and never the filename — an audit record that quoted the thing it was recording
access to would be a second copy of it. An admin who is also the mailbox owner is
not audited twice; they are reading their own mail.

**The route file is `routes/retentionAttachments.ts`.** The brief gave this lane
`routes/retention*` and `routes/departure*`; the attachment link is neither a
retention operation nor an admin command, and naming the file for the lane rather
than inventing a fourth ownership prefix keeps the file list checkable.

## Proving the negative

"No code path stores attachment bytes" is asserted four ways rather than once,
because it is the kind of claim that stays true only while somebody is checking:

* the whole schema has exactly one `bytea` column, and it is the envelope-encrypted
  refresh token in `mailbox_tokens`;
* `mail_messages.attachment_references` is `jsonb` with a bounded-array CHECK, and a
  stored reference has exactly four keys, none of which is a payload;
* no source file outside tests names `attachments.get`, `getAttachment` or
  `fetchAttachment`, nor composes `/attachments/` while talking to Gmail;
* the `GmailClient` port has no method whose name mentions an attachment, so an
  adapter cannot be asked for one.

The third check is scoped to files that speak to Gmail, because this lane's own
`POST /attachments/open` is a path in *this* API; matching it would have made the
assertion about a string rather than about a request.
