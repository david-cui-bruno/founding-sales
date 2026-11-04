import type {TableCoverage} from './coverage.ts';
const coverage=(dispositions:TableCoverage['dispositions'],note:string):TableCoverage=>({dispositions,note});
export const SOCIAL_PUBLISHING_RETENTION_COVERAGE:Readonly<Record<string,TableCoverage>>={
 social_publisher_runtime:coverage(['operational'],'Bounded native Chromium capability heartbeat, without owner identities, account cookies or content. Current worker heartbeat and independent account verification are required for unattended readiness.'),
 social_publisher_sessions:coverage(['retained','swept','departure_revokes'],'Only envelope-encrypted LinkedIn cookies and exact owner/account/profile binding. Explicit disconnect, owner loss and expiry physically clear ciphertext; existing Social cleanup sweeps expiry without reads. Opaque revision and revoked/expired state remain; retained metadata cannot restore credentials.'),
 social_standing_plans:coverage(['retained','departure_revokes'],'Current owner-explicit generation/publication configuration and opaque source/guide/calibration/account references, without private source prose or credentials. Pause, revision and owner loss invalidate unsubmitted work. Configuration cannot reset weekly admission or historical submission custody.'),
 social_standing_slots:coverage(['retained','deletion_redacts','departure_revokes'],'Stable owner/local-week/ordinal and target-instant admission, source lineage and native attempt custody. Source/guide/media/owner loss physically clears unsubmitted derived prose and images; submitted text and alt text also clear while hashes, account binding, marker and bounded inspection history prevent replay.'),
 social_standing_lineage:coverage(['retained'],'Opaque owner/input/slot consumption identities, without prose, credentials or image bytes. Source removal, policy revision, reconnect and week changes never make the same consumed founder story fresh again.'),
  linkedin_manual_ledgers: coverage(['retained'], 'Immutable body-free owner/account/Person/Firm and exact profile-claim/relationship revision bindings are retained as business history after source deletion or owner departure. No copied names, profile URLs or message bodies. Authorized reads recheck current membership, account and CRM access; deleted or stale evidence hides current identity projections rather than deleting wanted history. A binding never grants sending authority.'),
  linkedin_manual_entries: coverage(['retained'], 'Immutable body-free owner-asserted dated activity, connection state and correction revisions retain originals after source deletion or owner departure. No copied message bodies or profile literals. Current active membership and ledger access gate reads and writes; departure blocks access rather than removing history. Corrections do not release restrictive stops or resume sending.'),
  linkedin_manual_stops: coverage(['retained'], 'Immutable body-free opaque Person/Firm, entry and hold references preserve restrictive cross-channel reply/refusal history after source deletion, account disconnect or owner departure. No copied names, profile URLs or message bodies. Current authorization gates access; deletion, correction, time or rebinding never automatically releases a hold or resumes sending. Wanted stop evidence is retained, not swept.'),
  linkedin_recurring_slots:coverage(['retained'],'Body-free account/target uniqueness and exact owner/policy/source/draft/admission references conserve cadence and prevent replay after revision, revocation, source deletion or departure. No copied input text or credentials. Current membership, account, policy, source and runtime fences stop future publication without removing historical submission evidence.'),
    linkedin_outreach_settings: coverage(
      ["retained"],
      "Current owner/account-identifying standing-policy metadata, including approved action/data/model/budget bindings; no copied prospect conversations, private message bodies or credentials. Retained through disable/revoke, account disconnect, source deletion and departure. Current membership, policy revision and exact account binding are rechecked before use, so retained settings cannot restore authority; no automatic retention sweep or prospect-content deletion applies to this configuration.",
    ),
    linkedin_posting_settings: coverage(
      ["retained"],
      "Separate owner/account posting configuration and fixed content/voice/provider/data/spend scope. No private factual input bodies or credentials. Disable, revoke, account change and membership loss invalidate work without erasing documentary configuration.",
    ),
    linkedin_posting_candidate_bindings: coverage(
      ["retained"],
      "Immutable opaque delivery-to-owner policy revision fence. No draft body or credentials. Current membership, account and policy gate unattempted work. Retained submitted markers remain inspection-only after invalidation and cannot authorize replay.",
    ),
    linkedin_posting_policy_revisions: coverage(
      ["retained"],
      "Immutable posting approval and stop revision history, without private factual inputs or credentials. Retained through source deletion, disconnect and departure. Historical revisions cannot restore current posting authority.",
    ),
    linkedin_outreach_policy_revisions: coverage(
      ["retained"],
      "Immutable body-free owner-approval and disable/revoke history with exact account-identifying configuration metadata, policy rules, acquisition/model/grant versions and spending ceilings. No copied or derived prospect message content or credentials. Retained independently of source deletion, account disconnect and departure to preserve dated consent/stop audit. Old revisions are documentary only and cannot authorize work after a current revision, account or membership change.",
    ),
    social_weekly_settings: coverage(
      ["operational"],
      "Owner opt-in and next weekly draft check; active membership required, no transcripts or publication permission.",
    ),
    social_library_usage: coverage(
      ["operational"],
      "Workspace storage quota; released only after physical object deletion.",
    ),
    social_assets: coverage(
      ["retained"],
      "Owner-authored library metadata; explicit asset deletion tombstones it and queues private object removal.",
    ),
    social_asset_objects: coverage(
      ["retained"],
      "Version/hash tombstones remain; pending uploads expire after 24 hours and their objects enter the deletion queue.",
    ),
    social_object_deletions: coverage(
      ["operational"],
      "Idempotent object deletion and quota-release receipts; no image bytes.",
    ),
    social_accounts: coverage(
      ["retained"],
      "Profile/Page identity and adapter observations; disconnect invalidates the connection but retains native schedule reconciliation identity.",
    ),
    social_posts: coverage(
      ["retained"],
      "Owner-authored content identity, retained with revision and delivery history.",
    ),
    social_post_revisions: coverage(
      ["retained"],
      "Authored public content revisions; retained independently of prospect evidence.",
    ),
    social_post_approvals: coverage(
      ["retained"],
      "Immutable exact-content approvals; retained to reconcile external schedules and prevent duplicate publication.",
    ),
    social_manual_handoff_approvals: coverage(
      ["retained"],
      "Immutable owner-reviewed public content/account snapshots; no publication receipt or provider authority.",
    ),
    social_deliveries: coverage(
      ["retained"],
      "Native scheduling receipts and cancellation state; local deletion cannot recall an external schedule.",
    ),
};
