# Owner settings in the web product

[Web Settings](../../apps/web/src/client/BrowserSettings.tsx) currently exposes account, workspace/role/access expiry, explicit access refresh and page-local appearance. [ADR0027](../adr/0027-web-product.md) retires desktop. Missing owner controls are web product work, not a desktop setup prerequisite.

Calling setup #820 must expose the existing owner number, personal state confirmations, provider switch and unchanged budget around the calling journey. A genuine personal confirmation cannot be authored by an agent. Until that source is implemented and delivered, the current web Settings screen cannot enable Calling. Keep provider OFF and all server execution/registry/refusal/unknown gates.

Other owner capabilities retain their authenticated API/domain owners: [settings routes](../../apps/api/src/routes/settings.ts), [calling identities](../../packages/domain/dial/identities.ts), [sending safeguards](sending.md) and [CRM capability configuration](../operations/crm-capability-activation.md). Do not fabricate UI paths or infer consent from configured values. Gmail business-only new-originals/no-history, exact provider/model/data/spending bindings, suppression and owner OFF stay unchanged.

Every web owner mutation needs exact current principal/version, explicit action, durable metadata-only unknown custody and current readback. A draft or successful release grants no capture, contact, recording, sending or publication authority.
