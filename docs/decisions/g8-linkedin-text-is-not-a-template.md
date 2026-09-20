# G8: a LinkedIn step carries its own text; only an email step references a template

**Date:** 20 September 2026 · **Lane:** G8 sequences · **Spec:** 11.1, 11.3, 12.6

## The tension

11.1 says "Email steps reference immutable approved template versions containing
subject, body, footer, required variables, and content hash". 11.3 says the salesperson
sees "the contact's LinkedIn URL and rendered text", and does not say where the text
comes from.

Reusing `template_versions` for LinkedIn steps is the obvious move, and it is wrong.

## Decision

`sequence_steps.linkedin_message` is a text column on the step, required on a LinkedIn
step and refused on any other. `template_version_id` is required on an email step and
refused on any other. Both are CHECK constraints, so a step of the wrong shape cannot
be written.

## Why

`template_versions` requires three things of an approved row that a LinkedIn message
does not have and must not be given: a subject, a postal footer, and the
reply-to-stop line. A LinkedIn message with a postal address and "Reply 'stop' and I
will not email you again" at the bottom would be absurd, and the alternative — making
those columns nullable for one kind of row — would weaken the constraint that stops an
*email* going out without a footer. That constraint is 12.6 and David's decision, and
it is the last thing in this schema that should be loosened for convenience.

Immutability is not lost. The step belongs to a `sequence_version`, and migration
0012's trigger refuses every insert, update and delete of a step whose version has left
`draft`. The text is frozen with the plan, which is what 11.2's "enrollments are frozen
to immutable versions" actually needs.

## What carries across anyway

`sequence_steps_no_unsubscribe_link` refuses a LinkedIn message mentioning an
unsubscribe link, in any case, exactly as `template_versions_no_unsubscribe_link` does
for email. David's decision is that there is no web unsubscribe *anywhere*, and a
channel that escaped the constraint would be the place it eventually appeared.
