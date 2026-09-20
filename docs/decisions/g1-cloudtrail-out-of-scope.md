# G1: control-plane audit logging is an account-level concern

**Date:** 19 September 2026 · **Lane:** G1 infrastructure

See `docs/decisions/g1-no-flow-logs.md`, section "CloudTrail", for the reasoning. This file exists because `docs/greenfield/infra-topology.md` cites it by name in its "what is deliberately not here" list.

Summary: no CloudTrail trail is created by either root. A trail owned by the production root would be duplicated or absent in a rehearsal run, and neither is correct. Control-plane auditing belongs beside the state bucket and the deployment roles, at the account level. It is recommended before production carries real prospect data and it is flagged in the apply runbook.
