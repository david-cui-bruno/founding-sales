# G1: no VPC flow logs, and no CloudTrail trail, in these roots

**Date:** 19 September 2026 · **Lane:** G1 infrastructure · **Spec silence:** section 4.1 says "Load-balancer access logs and AWS control-plane audit logs are retained independently of application logs" but does not say which resource produces them.

## VPC flow logs

Not created. Flow logs are billed per GB ingested, and for this topology they would mostly record the API's own traffic to Gmail and to RDS, which the application logs already describe in business terms.

What version one actually needs from network telemetry is covered:

- **who reached the API** — ALB access logs, on their own bucket with their own 365-day lifecycle, retained independently of the application log groups;
- **what the API and worker did** — the structured application log groups, 90 days, bodies and secrets excluded;
- **whether anything unexpected can reach a task at all** — the security-group inventory, which is asserted offline: the ALB is the only internet-facing ingress and only on 443, the API admits only the ALB on the container port, the worker admits nothing.

If a real incident needs packet-level detail, flow logs can be turned on at the time against a specific ENI. Turning them on permanently, in advance, for one salesperson's traffic is paying every month for a log nobody reads.

## CloudTrail

Not created here either, for a different reason: it is an account-level decision, not an application-stack one.

A trail created inside the production root would be owned by the production root's lifecycle. A rehearsal run would either duplicate it (two trails logging the same account, billed twice) or not have one (rehearsal actions unaudited). Neither is right. Control-plane auditing belongs at the account level, alongside the state bucket and the deployment roles, which `cloud/scripts/bootstrap-terraform-state.sh` already establishes as the place where account-level things live.

**For David:** an account-level CloudTrail with a dedicated S3 destination and its own retention is worth having before production carries real prospect data, and it is the natural companion to the two deployment roles in section 1.1 of the apply runbook. It is not in these roots. If the coordinator wants it in G1's scope, say so and it can be added as a twelfth module with an `enabled` flag that only the production root sets.
