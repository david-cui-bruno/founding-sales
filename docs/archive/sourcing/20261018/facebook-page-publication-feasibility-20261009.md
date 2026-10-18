# Facebook Page publication feasibility

Research for #463, informing #464. Checked October 9, 2026 against source `157b1afd9f28570b432994174df38f5f2a465cd0`. No account, grant, token, post or schedule was changed.

## Decision

Use explicit manual handoff for the Callie Page until its actual Page identity, content access and API read/write authority are verified. Official source confirms a Page publication/scheduling API surface; it does not establish that Callie has usable access. LinkedIn stays the execution priority without an artificial code dependency.

## Official evidence and research limitation

Meta's [Page access help](https://www.facebook.com/help/289207354498410/r.php/) distinguishes Facebook access from task access. Content access permits Page content management; task access uses management tools such as Meta Business Suite and does not permit switching into the Page on Facebook. [Viewing Page access](https://www.facebook.com/help/510247025775149/) is a supported read-only check. A personal-profile login or display name is insufficient Page identity or authority proof.

The [official Meta SDK at inspected commit](https://github.com/facebook/facebook-python-business-sdk/blob/efd8423a2e595ea8d4c04eb824ce113f2f1d68cd/facebook_business/adobjects/page.py) includes Page `GET /feed`, `POST /feed`, `GET /scheduled_posts` and photo operations. The feed creation parameters include `message`, `attached_media`, `published` and `scheduled_publish_time`. This confirms an API surface for content and future publication, not permission eligibility, exact supported scheduling bounds, media/alt-text persistence or an idempotency guarantee. In particular, the generated `client_mutation_id` field is not evidence of guaranteed deduplication.

The [Pages posts guide](https://developers.facebook.com/docs/pages-api/posts/), [Page feed reference](https://developers.facebook.com/docs/graph-api/reference/page/feed/), [getting-started guide](https://developers.facebook.com/docs/pages-api/getting-started/) and [token guide](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/) could not be retrieved in this run; the feed/token routes returned HTTP 429. Their contents are **not verified** here. Do not substitute old tutorials for current rules. `pages_show_list`, `pages_read_engagement` and `pages_manage_posts` are the scope checklist to verify against those accessible official docs and actual grant metadata before implementation; this report does not certify their sufficiency or current approval tier. Token lifetime, renewal, data-access expiry, app-review/business-verification requirements, rate allowance, costs and native scheduling bounds remain unverified. No “never expires” guarantee is justified.

## Existing source and observed account state

`packages/domain/social/accounts.ts` rejects Facebook personal profiles and saves Facebook destinations as unsupported. The desktop registers only LinkedIn. [Existing verification](social-adapter-verification.md) explicitly leaves Facebook Page inspection and product-runtime acceptance pending. No existing read-only account receipt in that document establishes Callie's numeric Page ID or current grants. This is unknown access, not a finding that David lacks Page access. No installed credential was inspected or reused.

## Implementation contract for #464

Keep unavailable destinations visibly unavailable. A manual handoff must bind the chosen Page identity, exact post revision/text/media/alt text and requested time, and explicitly say Callie has not scheduled it. Do not allow copying to set scheduled/published or add a retryable cloud delivery. Identifiable customer material still requires its own approval.

When supported authority is established, choose either native future scheduling or cloud due-time publication explicitly. Bind actual Page ID, role/task evidence, grant generation, adapter version and immutable approval fingerprint; never infer authority from a Page label or copy native desktop credentials. Media uploads are external actions too and need exact approval and durable recovery. Retain the first submission marker/receipt; after lost response inspect exact Page/time/content/media before considering another action. Incomplete pagination or access loss remains unknown. A scheduled receipt is not published acceptance. Preserve successes on LinkedIn/X when Facebook fails; a missed time needs rescheduling and new approval, without bursts.

Activation gates: readable official version/permissions/scheduling rules; read-only actual Page/grant metadata and expiry; supported media and alt-text readback; controlled-provider and real PostgreSQL tests through public commands/worker handlers for identity changes, stale approval, lost responses, concurrency and restart; separately approved exact native/provider test and release receipt. A missing grant is a fallback result, never permission to expand scope. Keep sending, admission, replies, caps and paid-attempt controls unchanged.
