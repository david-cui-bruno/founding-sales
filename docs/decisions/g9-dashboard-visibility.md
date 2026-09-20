# G9: a dashboard is computed over the firms the caller may see at row-2 visibility

**Date:** 20 September 2026 · **Lane:** G9 · **Spec:** 13.4, Appendix F, Appendix G 7

Section 13.4 ends: "Dashboard queries use aggregate/redacted DTOs and respect the read
matrix." Appendix F is a matrix about *records*. It does not say what an aggregate
over records a caller may not see amounts to, and the answer matters more in this
system than in most.

## Why it matters here specifically

FSS begins as a tool for one salesperson and grows to a few. In a workspace of two
people with one firm each, a workspace-wide count **is** the other person's count. A
"reply rate" over two firms tells you your colleague's reply rate by subtraction. The
aggregation that makes a figure safe in a large organisation does nothing here.

## The decision

Every figure is computed over the firms the caller may see at Appendix F's *row-two*
visibility: the workspace for an admin or the system, the caller's assigned firms for
a salesperson. `readDashboard` decides that from the scope; the request cannot name an
audience, and a request that tries is malformed.

The answer says which it was (`audience: 'workspace' | 'assigned'`), so a person
comparing two numbers can see that they are not the same question.

## What is given up

A salesperson cannot see how the workspace as a whole is doing. In a two-person
company that is a real loss and an admin can see it. The alternative — a colleague's
outreach results readable by subtraction from a page nobody thought of as a read of
their firms — is the kind of thing Appendix G 7 exists to prevent, and the
conservative option under spec silence is the one that refuses.

One figure is scoped differently and says so in the code: open holds are filtered by
the hold's own `owner_user_id`, because a hold scoped to a mailbox or an owner has no
firm to join through, and an unowned workspace hold is an operational fact rather
than a fact about anybody's firm.

Suppressions are counted by *scope* (`firm` or `handle`) and never by canonical key,
because a canonical key is an address or a telephone number.
