# FSS greenfield secret material.
#
# Two customer keys and a set of EMPTY Secrets Manager entries.
#
# This module deliberately contains no aws_secretsmanager_secret_version and no
# random_password. Terraform creates the container; a human puts the value in
# once, following docs/greenfield/infra-apply-runbook.md. Nothing secret is ever
# in the repository, in a plan, or in state.
#
# The envelope key is separate from the application key. Per-mailbox Gmail
# refresh tokens are envelope-encrypted before they reach PostgreSQL, so the
# key that unwraps them is used only by the two task roles and is rotated and
# audited independently of the general application secrets.

locals {
  # Every environment's entries, each created empty. Terraform never writes, reads
  # or plans a value: the values are entered once by hand under the apply runbook.
  secret_names = [
    "google-oidc-client",
    "google-gmail-oauth-client",
    "session-signing-key",
    "device-credential-pepper",
    "llm-classifier-api-key",
    # Reused encryption key for Buffer credentials and retained browser ciphertext.
    # Keep the existing value/container; never rotate away outstanding custody.
    "social-publisher-session-key",
    # Retained browser recovery host only; never injected into Buffer API/worker.
    "social-publisher-control-token",
    # Call-to-booking (slice W): Twilio Voice (account, API key, TwiML app, auth token,
    # caller id) and Cal.com (webhook secret, API key), each a JSON object the API reads
    # (`apps/api/src/integrations/providers.ts`). Only read once a workspace turns its
    # switch on; see the note in `infra/modules/cluster` about entering a value first.
    "twilio-voice",
    "calcom",
    "zoom-meetings",
    "sourcing-search",
    # Call transcription (slice C2): `{"provider": "deepgram", "api_key": "..."}`. The
    # worker alone reads it (`apps/worker/src/transcription/deepgramClient.ts`); the API
    # learns from the worker's heartbeat whether it is in place. `{}` until a key exists.
    "transcription",
    # Guessed-address verification (ADR0038): the MillionVerifier API key as a bare string, not JSON. The
    # worker alone reads it (`apps/worker/src/providers/millionVerifier.ts`); the container is created
    # empty and the key is entered once by hand, so the worker verifies nothing until it is.
    "millionverifier-api-key",
    # The two database identities (G12h, David's condition of 21 September).
    # Separate entries because the point is that the identity which may read one
    # may not read the other: `infra/modules/cluster` gives the first to the
    # migration execution role alone and the second to the two services, and
    # nothing in the cluster may read the RDS-managed master secret at all.
    "migration-database",
    "app-runtime-database",
  ]
}

resource "aws_kms_key" "secrets" {
  description             = "${lookup(var.tags, "DisplayName", var.name_prefix)} application secrets in Secrets Manager."
  enable_key_rotation     = true
  deletion_window_in_days = 30

  tags = merge(var.tags, { Name = "${var.name_prefix}-secrets" })
}

resource "aws_kms_alias" "secrets" {
  name          = "alias/${var.name_prefix}-secrets"
  target_key_id = aws_kms_key.secrets.key_id
}

resource "aws_kms_key" "envelope" {
  description             = "${lookup(var.tags, "DisplayName", var.name_prefix)} envelope key for per-mailbox Gmail refresh tokens stored in PostgreSQL."
  enable_key_rotation     = true
  deletion_window_in_days = 30

  tags = merge(var.tags, { Name = "${var.name_prefix}-envelope" })
}

resource "aws_kms_alias" "envelope" {
  name          = "alias/${var.name_prefix}-envelope"
  target_key_id = aws_kms_key.envelope.key_id
}

resource "aws_secretsmanager_secret" "this" {
  for_each = toset(local.secret_names)

  name                    = "${var.name_prefix}/${each.value}"
  description             = contains(keys(var.tags), "DisplayName") ? "${var.tags["DisplayName"]}/${each.value}. Created empty by Terraform. The value is entered by hand under the apply runbook." : "Created empty by Terraform. The value is entered by hand under the apply runbook."
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = var.recovery_window_days

  tags = merge(var.tags, { Name = "${var.name_prefix}-${each.value}" })
}
