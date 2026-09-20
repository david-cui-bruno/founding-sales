# G3b: three reads are POSTs, on purpose

**Date:** 20 September 2026 · **Lane:** G3b CRM surface · **Spec:** 14.1, 5.2

`POST /search/firms`, `POST /export/firms` and `POST /crm/firm-page` write nothing
between them except one audit event. They are POSTs anyway.

## The reason

A search term in this system is a prospect's name, their email address, their
telephone number or their street. A query string is the one part of a request that
leaves the request:

* the load balancer writes it to its access log;
* a proxy keeps it in its history;
* an error page quotes it back;
* a bug report screenshot contains it.

Section 14.1 asks that "responses are typed and redacted for the caller's visibility
class". That is about what comes back. Putting the thing being searched for into the
URL leaks it on the way *in*, where no response shape can help, and it leaks it into
systems that have no idea they are holding personal data and no retention rule that
covers it.

`/crm/firm-page` takes only a firm id, which is not personal data, and is a POST for
consistency: a rule that applies to two of three endpoints in a family is a rule
somebody will get wrong on the fourth.

## What is given up

* **Cacheability.** Nothing this API says is cacheable anyway: every response carries
  `cache-control: no-store` and every one of them is about right now.
* **Bookmarkable searches.** A saved search is a stored object with an id, not a URL,
  and it is not in version one either way.
* **`GET` semantics.** A POST that is a read is not idempotent by convention, and a
  client that retries one gets a second read. For search and the firm page that is
  harmless. For export it is correct: two exports are two copies taken, and the
  auditor should see both.

## The counter-argument, and why it lost

REST says a read is a GET. The specification does not; it says the API's job is
redacted responses and stable refusals. Between a convention about HTTP verbs and a
prospect's address in a log file that nobody will ever grep, the convention loses.

## Export is not a command either

Every mutation in this API carries a command id so a replay returns the original
result instead of repeating the effect. Export deliberately does not, for two
reasons that both point the same way:

* the effect worth recording *is* the audit event, and a replay answered from a
  receipt would hide the second copy from the auditor — the opposite of what 5.2
  wants;
* the result is the exported data, and `command_receipts.result` is not where a few
  hundred firm records belong.

So an export is an audited read: authenticated, scoped, redacted by construction, and
recorded once each time it happens.
