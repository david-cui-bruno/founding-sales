# Gmail owner setup and separate capability approval

This procedure prepares ordinary authenticated owner settings for initial setup or a configuration change to #549 Gmail capture and #550 evidence extraction. It does not authorize activation. [Operating state](current-state.md) records the unchanged approved business-only incoming+Sent new-originals/no-history scope and its remaining readiness/usefulness limits. Locate the actual consent audit and verify current account/configuration bindings, deployed adapters and funding rather than asking again for unchanged valid consent after an ordinary release. Missing required consent evidence or a materially changed scope needs the applicable owner decision. Use the [release procedure](lean-release-workflow.md), not historical schema checkpoints here, for release decisions.

## Prepare without activation

Web owner configuration is currently a product gap. The retired desktop setup/bridge is removed under [ADR0027](../adr/0027-web-product.md); do not use installed credentials or native screens to complete it. Build the web flow from the capability decision and current server contracts, with ordinary owner sign-in.

The retained `/crm/processing/purpose/save` API enforces current administrator authority and expected revision. Its input is the exact provider/model/region, purpose, data categories, requested outputs, spending limits and retention configuration. Configuration must match the actual deployed adapter and existing owner-approved scope. No historical default, blank field or unrun credit claim supplies a missing value.

Saving always leaves extraction disabled, increments its revision and clears current authority/owner approval. It creates no consent audit or independent authority receipt and queues no provider work. If already enabled, saving disables extraction; make that consequence explicit. A stale revision or unknown outcome needs current readback and ordinary receipt recovery, never blind retry. Keep legacy strict1.0.51 response compatibility while its retained server readers exist.

Current configuration, consent evidence and capability readiness are separate. Ordinary releases preserve unchanged valid consent. A configuration save cannot bypass current account/generation, quality evidence, runtime funding, access/retention/source-erasure checks or a newer owner stop. No activation follows from this document.

## Distinct decisions and boundaries

- **Capture:** ongoing copying of qualified or explicitly included incoming and owner-Sent business originals requires its own current mailbox/account/generation, metadata policy, observed OAuth scopes and owner approval. Personal, excluded and unresolved conversations remain excluded. Metadata review is body-free and is not body-read authority.
- **Extraction:** needs/objections/commitments interpretation of authorized copies needs separate exact purpose/model/provider/data/spend approval and #550 evidence. Capture does not authorize hosted AI. Provisional usefulness, actual transport, controlled fixtures and representative quality are distinct claims.
- **Disable:** prevents fresh authorized work but cannot undo accepted provider requests. It retains approved copied history and documentary consent audit. Disconnect stops new capture and does not delete retained copies or grant processing.
- **Deletion:** the explicit scoped deletion flow erases affected Callie copies and dependent evidence, preserves terminal recapture barriers and does not modify Gmail originals. Disable is not deletion, and reconnecting does not restore erased content.
- **Backfill:** historical import requires a separate bounded interval/read allowance and approval. It is excluded from initial capture/extraction setup. Recovery coverage gaps are not proof of complete mailbox history.
- **Other capabilities:** Ask answering, embeddings/indexing, outreach, admission, calling and sending are outside this setup. Plain keyword/record search remains available. No CRM approval grants outreach permission or resumes sending.

## Root-owned activation and acceptance

After deployment and actual funding/adapter verification, root checks genuine owner consent for the exact capture and extraction scope before the supported explicit activation flow. Ordinary releases preserve unchanged valid consent; configuration saves still disable extraction as described above, and material changes require approval of the changed scope. No summary substitutes for a required durable consent audit. Current access, source ownership/deletion, cancellation, after-wait bindings, read/financial reservations and uncertain-dispatch conservation still apply. Actual authorized Gmail capture and reviewed extraction outputs, scenario results/misses/timing and human UI usefulness remain acceptance work, not claims established by local tests or saving settings. Empty captured bodies do not establish readable originals or useful extraction.

## History

[Earlier privileged-receipt procedure](../archive/operations/20261018/crm-capability-activation-history-schema88.md) is documentary history. ADR0009's lean-owner amendment supersedes independent per-release receipt provisioning. Neither historical receipts nor ordinary configuration fabricate current permission. This document makes no production, provider, funding, deployment, activation or sending observation.
