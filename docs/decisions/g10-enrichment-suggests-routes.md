# G10: enrichment suggests contacts and routes; it does not create them

**Date:** 20 September 2026 · **Lane:** G10 research · **Spec:** 7.4, 9.1

## The tension

Section 7.4 says both of these:

> Enrichment may add evidence to existing firms and suggest canonical values,
> contacts, and routes.

> Email and phone routes become `usable` only when a versioned provider/source policy
> satisfies both technical-validation and association-confidence thresholds. Weaker
> routes remain `candidate`.

The first sentence says "suggest". The second implies a route row exists to be
promoted. The old build resolved this by *creating* the route: `companyPageProvider`
returned an evidence batch containing routes, and `admitEvidence` wrote them.

## Decision

Enrichment creates no `phone_routes` and no `email_addresses` row. It records a
`phone_route` or `email_route` **suggestion**, and a person accepting it calls
`addPhoneRoute` / `addEmailRoute`, where `decideRouteEligibility` decides what the
route becomes.

Discovery is the one exception, and a deliberate one: the number a business listing
publishes is recorded as a `candidate` phone route immediately, because it is the
firm's own switchboard number as published by the firm, and a firm with no route at all
is a firm a person cannot begin to work. It arrives as `candidate` with
`source = 'research_provider'`, which is not a trusted source, so it is not dialable.

## Why

Three reasons, in order of weight.

**A suggestion is reviewable and a route is not.** A route row is a thing the system
will act on: `authorizeDial` reads it, the send path reads it, and the card displays
its version. A suggestion is a queue entry. Section 7.4's whole shape — "lower
confidence or conflicting facts remain visible suggestions" — is about giving a person
the chance to look, and an address scraped off a `mailto:` link is exactly the kind of
finding that benefits from one.

**The threshold lives in one place.** If enrichment created routes, it would have to
consult the published policy to set their eligibility, and there would then be two
callers of that decision with two ways of getting the confidence wrong. With
suggestions there is one: the person's command. The invariant-8 test publishes the most
permissive policy it can and still no route is promoted by a research path, which is
the property this buys.

**It shrinks what research can do without shrinking what it can find.** The business
email finder, the fact extractor and the duplicate detector all still run and all still
record everything they learn. What changed is that none of it lands in a table the
outbound path reads.

## The cost, stated honestly

A person has to accept a suggestion before a firm has an email route, which is one more
click per firm than the old build. For a single salesperson working a morning list that
is the right trade: the click is where they look at the address and decide whether it is
the firm's inbox or somebody's personal mailbox, which is a judgement the `FREE_MAIL_DOMAINS`
list and the on-domain rule approximate but do not make.

If that ever becomes the bottleneck, the extension point is a policy flag — "accept
`email_route` suggestions from `company_page` automatically above confidence *x*" — on
`research_route_policies`, published as a new version with its history. It is not a
change to this file's shape.

## What a person's acceptance does and does not do

Accepting a route suggestion records agreement. It does not create the route: the
domain deliberately has no code path from `reviewSuggestion` to `addPhoneRoute`,
because the route command takes its own authorization, its own retrieval time and its
own technical-validation result, and inventing those from a suggestion would be
fabricating provenance. The API's review response is what tells the client to offer the
"add this route" command next.
