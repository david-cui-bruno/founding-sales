# Text and image social publishing implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task-by-task, inline. One independent whole-branch review per release. Steps use checkbox syntax for tracking.

**Goal:** Turn approved ideas and images into verifiably scheduled posts on David's LinkedIn/X profiles and Callie's Facebook Page, without paid social tools or taking over the mouse/screen.

**Architecture:** Store assets, draft revisions, approvals and delivery claims in the existing API/Postgres/private object storage. Generate bounded drafts with Bedrock and use a sandboxed hidden Electron browser per social account to submit approved posts to native scheduling. The platform owns publication after receipt; Callie tracks readback, cancellation and exceptions.

**Tech Stack:** Existing Electron 44/React/shadcn/Node 24/Postgres/AWS stack; sharp for bounded image normalization, macOS sips for HEIC conversion; no new browser fleet or paid provider. Codex browser tools are setup/testing tools, not the product runtime.

**Spec:** [Roadmap 5b](../specs/2026-10-05-sales-roadmap-design.md); [master constraints/release gate](2026-10-05-sales-roadmap.md). Uses E1 approved facts and existing call/meeting evidence. David confirms native free scheduling exists on his accounts; the S0 probe tests our runtime integration, not that claim.

## Global Constraints

- Text, screenshots, web images and phone photos; no videos. No paid X API, Premium, scheduler, ads, DMs or engagement automation.
- David approves exact content, image derivatives, account and scheduled instant. Regeneration/editing cannot retain approval. Publication isn't authorized merely by this implementation plan.
- Use anonymized themes, approved product facts and public research. No customer names, direct quotes, identifying combinations, invented performance or composites presented as real individual stories.
- No native mouse/keyboard automation. Show an account login window only after David chooses Connect/Reconnect. Keep session data out of repo/logs/cloud prompts.
- Metadata is workspace-scoped; objects are private. Browser/page content is data, never executable instructions from a model.
- Reuse cloud credit accounting for drafting. Do not create a new recurring cash allowance. Scheduling browser actions themselves incur no social API charge.

## Review Focus

1. Wrong profile/Page is selected after account switching: halt before submission (S0/S4).
2. Platform accepted a schedule but Callie lost the receipt: reconcile; never blindly repost (S4).
3. Scheduled post is edited/cancelled while offline or publishing: retain actual state and show pending/too late (S2/S4).
4. Phone EXIF rotation/location or private screenshot content leaks into published images: normalized reviewed derivatives only (S1/S3).
5. Transcript anonymization leaves indirect identifiers or generated claims: evidence links, redaction and exact approval (S3).

## File map

- Create `packages/contracts/src/social.ts`; `packages/domain/social/{assets,posts,approvals,delivery,settings,drafts}.ts`; `apps/api/src/routes/social.ts` and `apps/api/src/social/mediaStore.ts`.
- Create `apps/desktop/src/main/social/{runtime,adapters,deliveryLoop,assets,imageNormalize}.ts` and `adapters/{linkedin,facebook,x}.ts`. Extend desktop app startup, identity reset and packaging for the narrowly scoped runtime; no remote page gets the app preload.
- Create `apps/desktop/src/renderer/social/{SocialRoute,PostEditor,AssetLibrary,ContentCalendar}.tsx`; extend existing routes/App/Sidebar and closed operation registry.
- Create `apps/worker/src/handlers/socialDraft.ts`, `apps/worker/src/social/draftModel.ts`; extend existing reservation types, scheduler composition and retention.
- Add `social_content` and `social_delivery` migration stems. Create `infra/modules/social-assets/{main,variables,outputs,versions}.tf` and `tests/posture.tftest.hcl`; wire through `infra/modules/stack/{main,outputs}.tf` and `infra/modules/cluster/{main,variables}.tf`. Use one private S3 asset bucket with narrowly scoped signed-object operations. **Do not use the recordings bucket:** its lifecycle deletes every object after one day. Preserve that existing audio rule. No public bucket or cookie store on the server.

## Task S0: Prove the product-owned background runtime

**Files/tests:** runtime/adapters interfaces, `apps/desktop/test/socialRuntime.test.ts`, `apps/desktop/test/host/socialRuntime.test.ts`, `docs/sourcing/social-adapter-verification.md`.

**Interfaces:** `Platform='linkedin'|'facebook'|'x'`; `AccountIdentity={platform:Platform,externalId:string,displayName:string}`. `SocialAdapter` exposes `inspectAccount():Promise<AccountIdentity|null>`, `stage(input:ApprovedPost):Promise<{ready:boolean,reason?:string}>`, `submit(input:ApprovedPost):Promise<SubmissionResult>`, `inspect(input:{receiptId:string|null,fingerprint:string}):Promise<InspectionResult>`, `cancel(receiptId:string):Promise<InspectionResult>`.

`ApprovedPost={deliveryId:string,revision:number,account:AccountIdentity,text:string,images:{assetId:string,version:number,localPath:string,altText:string}[],publishAt:string,zone:string,fingerprint:string}`; localPath is main-process-only. `SubmissionResult={kind:'scheduled',receiptId:string}|{kind:'not_submitted',reason:string}|{kind:'unknown'}`. `InspectionResult={state:'scheduled'|'published'|'cancelled'|'absent'|'unknown',receiptId:string|null,permalink:string|null,observedAt:string,accountExternalId:string|null,observedFingerprint:string|null}`. Fingerprint hashes account, canonical text, derivative hashes and instant, not filenames. Where the site transforms media, retain its media identifiers from submission and compare those plus visible content; inability to establish identity yields unknown, not a made-up exact byte match.

- [ ] Build runtime tests with a local fixture composer: hidden window never activates/shows; separate persistent partitions per workspace/platform/account; remote content has no Node/preload/IPC; external navigation and permissions refused; selected account mismatch stops before schedule; file paths only resolve approved assets; sign-out stops pending work.
- [ ] Run `npm test --workspace apps/desktop -- test/socialRuntime.test.ts`; verify missing behavior fails.
- [ ] Implement one hidden `BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,partition}})` while a job is active. Use fixed code-owned DOM actions in an isolated world and bounded observed UI states; no arbitrary code supplied by server/model/page. Don't reuse Callie's authenticated renderer session or expose a remote debugging network port. Destroy idle windows; keep sessions in app userData and clear the specific partition on explicit disconnect, not unrelated accounts.
- [ ] Observe each real account's composer and scheduling view before coding platform selectors. Capture redacted fixture states for account selection, text/media, timezone, scheduled receipt and cancellation. Account challenges pause and show Reconnect; no challenge bypass or opportunistic UI clicks. Test scheduling/cancelling only with David-approved test text/image/time when execution reaches this probe.
- [ ] Prove the hidden runtime can stage media and verify account identity; obtain a native scheduled receipt and cancel/readback during an authorized test. A click without a receipt is unknown. If the native UI lacks a stable ID, require an unambiguous account/content/image/time match; multiple matches hold for review. Do not claim the adapter passes from manual native scheduling alone.
- [ ] Record per-platform pass/failure and adapter assumptions. If hidden Electron isn't accepted or scheduling cannot be read back, keep the platform unsupported in product and surface the finding before replacing the runtime; no paid fallback. Commit `feat: add isolated background social runtime` only for verified reusable code, not disposable probe hacks.

Technical basis: [Electron hidden windows and partitions](https://www.electronjs.org/docs/latest/api/browser-window), [isolated-world execution](https://www.electronjs.org/docs/latest/api/web-contents), [session storage](https://www.electronjs.org/docs/latest/api/session). These establish runtime primitives, not social-site compatibility.

## Task S1: Private image library and publication derivatives

**Files/tests:** assets domain/contract/API/object store, desktop assets/imageNormalize, package/lockfile; `packages/domain/test/social/assets.test.ts`, `apps/desktop/test/socialImages.test.ts`, `apps/api/test/socialAssets.test.ts`.

**Interfaces:** `AssetOrigin={kind:'upload'|'phone'|'web'|'screenshot',sourceUrl:string|null,usageNote:string|null}`; `registerSocialAsset(ctx,{sha256:string,bytes:number,mime:string,origin:AssetOrigin}):Promise<Result<{assetId:string,uploadId:string}>>`; `completeSocialAsset(ctx,{assetId,uploadId}):Promise<Result<{version:number}>>`. `normalizeSocialImage({inputPath:string,crop:{x:number,y:number,width:number,height:number}|null,redactions:{x:number,y:number,width:number,height:number}[],outputPath:string}):Promise<{sha256:string,width:number,height:number,mime:'image/png'|'image/jpeg',bytes:number}>` runs locally under fixed allowed paths.

- [ ] Test JPEG EXIF orientations including mirrored cases, transparent screenshot, GPS metadata, HEIC phone photo, oversized/damaged/polyglot file, animated media, invalid crop and redaction persistence. Assert orientation-correct pixels, no GPS metadata in derivative, opaque redaction, unchanged original, bounded memory/time and no executable image format. Test cross-workspace object IDs and interrupted upload.
- [ ] Run focused suites; confirm expected failures.
- [ ] Accept PNG/JPEG/WebP/HEIC still images up to 20 MiB and 48 megapixels; refuse SVG, video and animation with a readable message. Check bounds before full decode; process one image at a time. Convert HEIC through `/usr/bin/sips` using fixed executable/argument arrays, private temporary paths and a 30-second timeout; the local formats inspection supports HEIC but fixtures must prove orientation. Normalize/crop/redact with sharp, explicit pixel limits, auto-orientation and metadata stripping. Produce PNG for transparency/screenshots, JPEG otherwise, at most 4,096 pixels on the longest side and 5 MiB; if lossless content cannot fit, show an edit-needed result rather than silently destroy screenshot legibility. Platform-specific validation occurs before approval. Test packaged macOS native dependencies, not only development Node.
- [ ] Originals and versioned derivatives use separate private keys; derivative hashes bind approval. Use checksum/size-validated signed upload/download operations scoped to one object, maximum 10-minute expiry. The API verifies completion metadata and never accepts an arbitrary bucket/key. Retain completed library assets until user/workspace deletion; uncompleted uploads expire after 24 hours. Test lifecycle isolation from the audio bucket. Add object deletion retries and a 1 GiB per-workspace initial library quota so storage cannot grow silently without bound. Deleted referenced assets block unscheduled drafts rather than publishing another image.
- [ ] Provide upload/paste and phone-to-Mac file input with preview. For a web URL, use a bounded image fetch with public-DNS/redirect/size checks derived from the existing fetch protections; store the original source URL and usage note without claiming rights. Redirects to private hosts fail. No wholesale photo-library access or automated online image scraping.
- [ ] Run focused tests, package verification for the new native dependency and affected storage/IAM tests. Commit `feat: add private social image assets and safe derivatives`.

## Task S2: Versioned drafts and exact approval

**Files/tests:** posts/approvals/settings modules, contracts/routes/operation registry; `packages/domain/test/social/approvals.test.ts`, `apps/api/test/social.test.ts`.

**Interfaces:** `PostRevision={postId:string,revision:number,account:AccountIdentity,text:string,images:{assetId:string,version:number,altText:string}[],publishAt:string|null,zone:string,state:'draft'|'approved'|'submitting'|'scheduled'|'published'|'cancellation_pending'|'cancelled'|'failed'|'unknown'}`. `saveSocialPost(ctx,{postId?:string,expectedRevision?:number,account,text,images,publishAt,zone}):Promise<Result<PostRevision>>`; `approveSocialPost(ctx,{postId,expectedRevision}):Promise<Result<{approvalId:string,fingerprint:string}>>`; `requestSocialCancellation(ctx,{postId,expectedRevision}):Promise<Result<PostRevision>>`.

- [ ] Test approval binds exact revision/account/image hash/time; changing alt text/crop/asset/time invalidates it; older client/stale revision refuses; selecting Facebook profile instead of Page refuses; text-only is valid; deleted image or changed identity prevents scheduling. Cancel while already published must not falsely report cancelled.
- [ ] Run focused domain/API suites and confirm failure.
- [ ] Persist immutable post revisions, approval snapshots and one delivery per approved revision/destination. Use actual IANA timezone plus UTC instant; DST-ambiguous input requires the displayed offset to be selected. No automatic post time or frequency is approved by draft generation. Scheduling time must fit the adapter's observed supported range.
- [ ] Implement editing: unscheduled changes return to draft; for an already scheduled revision, preserve that actual schedule and request cancellation before replacing it. Only after absence/cancellation is confirmed can a newly approved revision be submitted. If publication wins, show Published and ask David whether to create a new post; don't silently delete a live post.
- [ ] Add audited authenticated-owner commands and read APIs with workspace scoping. Deleting local draft history does not imply removal from a platform; retain the minimum receipt/cancellation state needed to finish pending work. Commit `feat: bind social approvals to exact scheduled content` after focused tests.

## Task S3: Anonymized drafting and a useful content workspace

**Files/tests:** drafts module, socialDraft worker/draftModel, SocialRoute/PostEditor/AssetLibrary/ContentCalendar, app/routes/Sidebar; `packages/domain/test/social/drafts.test.ts`, `apps/worker/test/socialDraft.test.ts`, `apps/desktop/test/social.component.test.tsx`.

**Interfaces:** `requestSocialDrafts(ctx,{sourceRefs:{kind:'call'|'meeting'|'public',id:string,revision:number}[],factBlocks:{id:string,version:number}[]}):Promise<Result<{requestId:string}>>`; `DraftSuggestion={theme:string,sourceRefs:string[],variants:{platform:Platform,text:string}[],suggestedAssetIds:string[]}`. Output contains no schedule approval or browser actions.

- [ ] Test removal of names, addresses, exact identifying portfolio/client combinations and direct customer quotes; no invented metric/testimonial/integration; invalid source revisions held; anonymous composite not framed as a named incident. Test platform-specific variants, no videos, empty asset library and full navigation/draft preservation.
- [ ] Run focused suites, then implement bounded source selection and de-identification before generation. Use public research and approved facts; exclude raw email bodies and tenant contact details from social inputs. Show provenance privately to David, never insert internal CRM links into public copy. If a theme cannot be anonymized adequately, omit it.
- [ ] Use Bedrock Haiku with a 24 KiB input bound, 4,096 output-token cap, at most two dispatched attempts and a 30-minute expiry; add social_draft to existing reservation/accounting limits. Generate at most three concepts/request with platform variants. Default periodic drafting off; when enabled, propose one three-concept batch weekly, subject to the shared credit allowance. This creates drafts only, not three approved posts or a publication commitment.
- [ ] Build one Social sidebar route with Drafts/Calendar/Assets subviews. Provide editable platform previews, crop/opaque cover controls, alt text, exact account/time selection and Approve & schedule. Preserve original images and drafts across navigation. Show only actionable connection/unknown/cancellation failures; no implementation jargon or permanent status clutter.
- [ ] Enforce the adapter's current text/media limits before approval. Keep X within ordinary free-account limits; if a variant doesn't fit, ask for an edit rather than split into an unapproved thread. Content generation never approves reusable facts or reuses a customer's screenshot without David's explicit asset selection.
- [ ] Run focused tests and master R1; drafts/assets can ship with delivery disabled. Commit `feat: draft and review social content with image previews`.

## Task S4: Durable scheduling, cancellation and recovery

**Files/tests:** domain delivery and API commands, desktop deliveryLoop/platform adapters; `packages/domain/test/social/delivery.test.ts`, `apps/desktop/test/socialDelivery.test.ts`.

**Interfaces:** `claimSocialDelivery(ctx,{deviceId:string,postId:string,expectedRevision:number}):Promise<Result<{claimId:string,approvalId:string,fingerprint:string,expiresAt:string}>>`; `beginSocialSubmission(ctx,{claimId,approvalId,fingerprint}):Promise<Result<{submissionId:string}>>`; `recordSocialObservation(ctx,{submissionId,observation:InspectionResult}):Promise<Result<PostRevision>>`. All commands require the authenticated registered device, workspace and owning user.

- [ ] Test two devices/retries claim once; expired preparation can be reclaimed but submitted/unknown work cannot; cancellation during staging stops submission; crash after platform acceptance recovers by inspection; same text on two accounts stays distinct; device offline never marks a schedule published; login expiry and wrong account cannot publish; changed media invalidates fingerprint.
- [ ] Run focused suites and confirm these races fail before delivery persistence.
- [ ] Use a 5-minute pre-submit lease, with a committed submitting marker before the final external action. Recheck exact approval/revision, account and cancellation immediately before that marker and again in the adapter before clicking. Never reclaim submitting/unknown by timeout alone. Report unavoidable late cancellation races honestly; already accepted platform work requires verified cancellation.
- [ ] While Callie is running, check pending work every 60 seconds and on app/network resume, one external action per account at a time. Submit approved future posts promptly to native scheduling so publication can occur while the Mac sleeps. If still unscheduled when its time passes, mark missed/review; never publish immediately on wake. Display Pending scheduling separately from Scheduled on platform.
- [ ] Reconcile native scheduled/post lists by receipt and full fingerprint. Check again at publish time if online or next app resume. A missing first-page result is not absence: exhaust relevant date/pagination ranges or a definitive receipt lookup before concluding not submitted. Test delayed visibility and paginated lists; an incomplete lookup remains unknown and cannot authorize a retry. Uncertain/ambiguous state remains unknown and notifies once; inspection retries use bounded backoff, stopping after 24 hours until reviewed. Never infer publication solely because the clock passed. Persist verified permalink and actual observed time when available.
- [ ] Implement cancellation as its own idempotent action: pending cancellation remains visible while offline; confirm absence/state change before cancelled. Replacing a scheduled post cannot create a second live native schedule. If its native content changed outside Callie, show conflict and require review rather than overwrite it.
- [ ] Keep sessions only on the designated Mac under account-specific partitions, with no cookie export to cloud or Codex dependency. Explicit disconnect stops local claims and explains that existing native schedules remain until cancelled; do not falsely promise a local pause recalls platform schedules. Commit `feat: schedule approved social posts with durable readback` after focused tests.

## Task S5: Platform acceptance and delivery release

**Files/tests:** S0 adapter report, package fixtures, `apps/desktop/test/e2e/social.spec.ts`, affected API/domain tests and release ledger.

- [ ] For each enabled destination, run approved text-only and image tests through schedule/readback, edit-by-cancel/replace, cancellation, expired login, restart and eventual publication. Distinguish local fixture tests from real account checks. Test a phone image and a redacted product screenshot, not only an empty text post.
- [ ] Verify the native scheduled receipt while Callie is closed, then reopen to reconcile the actual publication. No mouse/screen takeover; David handles any explicit login. Keep X at zero charge and record no paid fallback.
- [ ] Run full R1 gate, desktop package/signing verification and object-store access tests. Ship supported destinations individually; a failed adapter is visibly unavailable while Drafts/Assets remain usable. Do not describe manual draft handoff as automatic publishing.
- [ ] Record the exact account, adapter version, supported formats/time range, last real verification and recovery limitations without credentials. Commit the release report. No automated DM, ads, video or broad browser agent work enters this release.

Implementation references: [sharp orientation](https://sharp.pixelplumbing.com/api-operation/#autoorient) and [output metadata behavior](https://sharp.pixelplumbing.com/api-output/). The host's `/usr/bin/sips --formats` lists HEIC read/write support; actual derivative fixtures are still required.

**Status:** planned. No account sessions, assets, drafts or scheduled posts were created by writing this plan.
