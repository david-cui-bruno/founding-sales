# Coordinator: David's topology answers applied (20 Sep 2026)

**Source:** David's account-preparation report of 20 Sep 2026, answering `docs/greenfield/infra-topology.md` §9.

1. Line items approved as the complete bill for the production root; Route 53 and CloudTrail are account-level and outside it.
2. `db.t4g.small` Multi-AZ, two API tasks, one worker task at 0.5 vCPU / 1 GiB: the production root's defaults already say so; nothing changed.
3. ARM64 images, two API tasks kept: `cpu_architecture = "ARM64"` in both roots' `terraform.tfvars`; the images workflow already builds `linux/arm64`.
4. Five KMS keys: logs and alerts share one. The observability module gains `shared_with_alerts` (adds the CloudWatch-alarms and EventBridge statement to the log key's policy); the alerts module gains `kms_key_arn` (uses the given key and creates none); the stack wires them. Database, application secrets, refresh-token envelope and suppression journal keys stay separate.
5. WAF, Performance Insights, Enhanced Monitoring, Container Insights and flow logs stay off: the defaults already say so.

Also recorded in tfvars: `api.usecallie.com` and its certificate, `api.rehearsal.usecallie.com` (fixed rehearsal hostname, wildcard certificate) and its certificate, the `callie-fss` project for Gmail push. Image digests and `alert_emails` are apply-time inputs. Terraform state keys, deployment roles and the `fss-prod` / `fss-rh-` namespaces are unchanged.
