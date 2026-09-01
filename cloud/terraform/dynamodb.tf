# All tables are on-demand (PAY_PER_REQUEST) with point-in-time recovery.

# Dedupe guard for event processing. Items carry an `expires_at` epoch-seconds
# attribute that DynamoDB TTL uses to garbage-collect old keys.
resource "aws_dynamodb_table" "idempotency" {
  name         = "${var.name_prefix}-idempotency"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "idempotency_key"

  attribute {
    name = "idempotency_key"
    type = "S"
  }

  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }
}

# Point-in-time snapshots of upstream source records, keyed by the source's
# natural key plus the snapshot date.
resource "aws_dynamodb_table" "snapshots" {
  name         = "${var.name_prefix}-snapshots"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "source_natural_key"
  range_key    = "snapshot_date"

  attribute {
    name = "source_natural_key"
    type = "S"
  }

  attribute {
    name = "snapshot_date"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }
}

# Resolved entities. GSI supports lookup by normalized name for entity
# resolution / dedupe across sources.
resource "aws_dynamodb_table" "entities" {
  name         = "${var.name_prefix}-entities"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "entity_id"

  attribute {
    name = "entity_id"
    type = "S"
  }

  attribute {
    name = "normalized_name"
    type = "S"
  }

  global_secondary_index {
    name            = "normalized_name-index"
    hash_key        = "normalized_name"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }
}

# Suppression list: contacts that must never be re-contacted.
# Deliberately NO TTL — entries never expire.
resource "aws_dynamodb_table" "suppression" {
  name         = "${var.name_prefix}-suppression"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "contact_hash"

  attribute {
    name = "contact_hash"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }
}

# Outreach outcomes observed per entity over time.
resource "aws_dynamodb_table" "outcomes" {
  name         = "${var.name_prefix}-outcomes"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "cloud_entity_id"
  range_key    = "observed_at"

  attribute {
    name = "cloud_entity_id"
    type = "S"
  }

  attribute {
    name = "observed_at"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }
}
