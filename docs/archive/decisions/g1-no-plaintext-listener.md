# G1: no port 80 listener, and other small fail-closed choices

**Date:** 19 September 2026 · **Lane:** G1 infrastructure · **Spec silence:** section 4.1 says the load balancer is "the only inbound path to API tasks" and 4.2 says mutations fail closed, but the specification does not discuss an HTTP-to-HTTPS redirect.

Where the spec was silent, this lane took the conservative option. Each one, and why:

## No port 80 listener

The ALB security group admits 443 only. A port 80 listener would therefore be unreachable, so a redirect would be decoration. Leaving it out means there is no plaintext endpoint on the load balancer at all and nothing to misconfigure later. A client that tries `http://` gets a connection refusal rather than a redirect. The Electron client is configured with an `https://` origin and never discovers the API by typing a hostname, so nothing legitimate depends on the redirect.

## The database security group has no egress rule at all

RDS does not initiate connections. Giving it egress would be giving it a capability it has no use for. Combined with the private route table having no route off the VPC, the database has no path to the internet in either direction.

## The default security group is claimed and left empty

`aws_default_security_group` is managed with no rules, so the VPC's default group cannot silently carry the permissive rules AWS creates with it.

## Object lock is GOVERNANCE, not COMPLIANCE, by default

Both are available; the mode is a variable. GOVERNANCE is the default because COMPLIANCE cannot be shortened or removed by anyone, including the account root, for the whole retention period. Choosing an irreversible ten-year lock on a bucket whose first objects have not been written yet is a decision that should be made deliberately by David, with the retention period in front of him, not by this lane's default. The deny statements in the bucket policy already deny `s3:BypassGovernanceRetention` to every principal, so GOVERNANCE here is not weaker in practice unless someone edits the bucket policy — which the same statement list denies.

## Bucket policies are deny-first

Every bucket in this tree denies the dangerous action to `"AWS": "*"` and then allows the narrow case, rather than only allowing the narrow case. An allow-only policy leaves an account administrator able to delete suppression history; the deny does not.

## The API service keeps 100% minimum healthy, the worker keeps 0%

The API rolls forward without a gap because the client is talking to it. The worker replaces rather than overlaps. Overlapping workers are safe by design — the scheduler pass takes a transaction-scoped advisory lock and every handler is protected by business uniqueness, a fencing token or the outbound at-most-once fence — but a clean replacement keeps the dispatch-fence story simple during a deployment, and one worker is enough for one salesperson.

## The worker container gets a 120-second stop timeout

Twice the API's. A worker being stopped should be able to finish the claim it holds and release its lease rather than being killed mid-transaction.

## `idle_in_transaction_session_timeout` is set to five minutes

The scheduler holds a transaction-scoped advisory lock for one bounded pass. A session that dies holding an open transaction would otherwise block every subsequent pass indefinitely.

## `log_statement = ddl`

Migrations and schema changes are logged; the statement text of ordinary business writes is not, so prospect data does not reach CloudWatch through the database log. Slow queries are still captured by `log_min_duration_statement`.

## ECS Exec is off, and off harder in production

`enable_execute_command` defaults to false in both roots, and the stack module has a precondition that refuses to let a production stack set it true at all. A shell inside a production task that holds Gmail credentials is not a deployment-time option.
