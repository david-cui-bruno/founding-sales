# G0: `node:http` rather than an HTTP framework

**Spec silence.** Section 4.1 lists what the public API must enforce — request-size
limits, rate limits, strict content types, redacted error handling, endpoint-specific
authentication — and names no framework.

**Decision.** `apps/api` uses `node:http` directly. No Express, no Fastify, no plugin
ecosystem, for now.

**Why.**

* The skeleton has one route. A framework would be chosen for routes that do not
  exist yet, against requirements that later slices will discover.
* Everything section 4.1 asks for at this stage is a pure function of a request
  envelope. `checkEnvelope` and `redactError` in `apps/api/src/limits.ts` are twenty
  lines, are unit-testable without a socket, and cannot be bypassed by a route that
  forgets to install a middleware — the single handler calls them before it dispatches.
* It is the smallest thing that can be audited. The supply-chain surface of the API
  container is currently `pg` and the two workspace packages.
* `route()` is exported as a pure `(method, path, options) => RouteResult`, so the
  router is tested without binding a port. Adding a framework later means replacing
  the thirty lines in `server.ts` that turn a `RouteResult` into a response, not
  rewriting the routes.

**When to revisit.** The moment a slice needs streaming bodies, multipart, content
negotiation, or a plugin (OpenTelemetry, structured request logging) that is fiddly to
write by hand. That will probably be the slice that adds Gmail's Pub/Sub webhook or
the CSV import, and the decision should be taken then, with the requirement in view.

**Not deferred.** Rate limiting and endpoint-specific authentication are part of
section 4.1 and are **not** implemented here. The skeleton has one unauthenticated
route that reports health and nothing else, and the router refuses every other path
with a redacted `not_found` rather than falling through, so a business route cannot
be added by accident without its authentication.
