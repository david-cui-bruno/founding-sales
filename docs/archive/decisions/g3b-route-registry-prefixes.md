# G3b: the route registry grew prefixes, and why that is not a fall-through

**Date:** 20 September 2026 · **Lane:** G3b CRM surface · **Spec:** 14.1

G5b's registry takes exact paths only: "No prefixes and no patterns: a route is
mounted or it is not." The coordinator's note asked this lane to move G2's and G3a's
routers onto it. Those routers cannot be expressed that way, and one of them cannot be
expressed that way in principle:

* `routeFirms` serves `GET /firms/<uuid>`. The last segment is an identifier, so the
  set of paths is not finite.
* `routeAuth`, `routeAdminMemberships`, `routeAdminDevices`, `routeContacts`,
  `routeOpportunities` and `routeMerges` each answer a redacted `not_found` for an
  unknown path under their own root — deliberately, so that `POST /auth/sign-in/stop`
  is "no such endpoint" rather than "wrong method", and so that a future
  `/admin/memberships/anything` does not fall out of a `switch` into another module.

The two ways out were a regex in `server.ts` for the one dynamic path, or a prefix in
the registry. A regex in `server.ts` is exactly the thing the registry exists to
prevent: a path decided in the dispatcher rather than declared by the module that
owns it, invisible to `registry.paths()` and to the startup line an operator reads.

So `RouteModule` gained an optional `prefixes`, and `createRouteRegistry` gained three
more refusals to go with the one it had:

1. two modules claiming the same exact path (G5b's);
2. two modules claiming the same prefix;
3. a prefix that contains another module's prefix;
4. a prefix that contains another module's exact path.

That last one is the important one. `/admin/jobs/dead` is G5's exact path and
`/admin/memberships` is G2's prefix; a module that claimed `/admin` would swallow both
and is refused when the registry is built. Resolution is exact-match first, then the
unique prefix match — unique because overlaps are refused, so there is no
"longest wins" rule for a reader to hold in their head.

A prefix matches on whole segments (`path === prefix` or `path.startsWith(prefix + '/')`),
not on string prefix. `/firmsomething` is nobody's path and answers `not_found`; the
`startsWith('/firms')` guards it replaced would have taken it.

`BootstrapRequest` also gained an optional `query`, because `GET /auth/google/callback`
receives Google's `state` and `code` in the URL and there is no body to put them in,
and `BootstrapResponse` gained an optional `contentType`, because that same callback
serves an HTML page a person reads in their browser. Both are optional: a module that
does not ask for the query cannot take a workspace id out of a URL by accident.

**Every new endpoint should still be an exact path.** The prefixes here are a record
of the seven routers that already existed in that shape, not an invitation. The search,
import and export routes this lane adds are exact paths.

## The cost that was accepted

`dispatch` authenticates once, before the registry, so a module is handed a principal
rather than a credential. G3a's CRM modules authenticate again for themselves, so an
authenticated CRM request now performs two session reads instead of one. `authenticate`
is a pure indexed read with no side effect, and the alternative was editing seven route
modules that belong to two other lanes while they are still in flight. When those
modules next change they should take the principal from the request.
