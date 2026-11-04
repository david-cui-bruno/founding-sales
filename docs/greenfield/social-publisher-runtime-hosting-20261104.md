# Social publisher: Chromium sandbox hosting decision

Primary-source research November3; Root runtime verification November4,2026. No LinkedIn/live-account traffic. The single temporary AWS diagnostic task, definition, scoped role, image tag and log stream were cleaned up; production services and controls were untouched.

## Decision for integration

**The exact tested default-security ARM64 Fargate profile cannot launch this sandboxed Chromium build.** Actual Fargate1.4.0,512 CPU/1024MiB, UID1000, init enabled and no task credentials exited1 with `LAUNCH_OPERATION_NOT_PERMITTED` before page creation. No Fargate renderer-confinement PASS exists. This is not a claim about every possible Fargate profile or the specific denied syscall. Publication stays unavailable; no sandbox-disabling fallback.

The assignment supplies the current baseline: Linux Fargate ARM64, 512 CPU units / 1024 MiB. That is an AWS-valid task size, not evidence that Chromium fits alongside the API/worker or that its sandbox works. AWS documents ARM64 support and the 512/1024 combination. [1][2]

Constraints: no new paid browser SaaS; no `--no-sandbox`, `chromiumSandbox: false`, sandbox-disabling fallback, privileged-container workaround, or account/session borrowing. No new infrastructure/spend is authorized by this note. Preserve zero outbound to LinkedIn/live accounts during engineering. These are project requirements, not claims made by the vendor documentation.

David approved approximately$20/month for one isolated browser-only EC2 host, keeping API/worker on Fargate and reusing existing AWS networking/ECR/TLS edge. Finite native sandbox and authenticated six-client bridged transport/firewall/shutdown probes passed; their temporary AWS resources were removed. Protected phase-false provisioning and actual production TLS/native/log checks subsequently passed; Docker health, runtime readiness and genuine account/publication acceptance remain separate.

All five publisher security-group rule instances explicitly carry the module's `NamePrefix`, overriding conflicting caller labels; provider default tags alone do not satisfy the deployment role's tag-on-create condition. The generic request-tag creation grant no longer directly authorizes ingress/egress against existing groups. Owned-group authorization and separate rule-resource authorization remain required. This bounded repair does **not** close the pre-existing retagging/default-group adoption paths tracked in [#932](https://github.com/david-cui-bruno/founding-sales/issues/932). Native Terraform regression and IAM simulation qualify these prerequisites; actual protected provisioning and production transport acceptance remain separate.

**Docker health command:** systemd consumes one quoting layer before Docker's shell interprets the health command. The old unit rendered unescaped JavaScript URL quotes into the saved Docker command, producing a persistent syntax error despite HTTP200 from the broker. The corrected unit argument uses outer double quotes, escaped shell-program double quotes and a single-quoted JavaScript URL. A finite native systemd parser probe reproduced the exact current command/exit1 and the corrected command/exit0 inside the unprivileged production container; its temporary units/files were removed without restarting the publisher. Keep the existing health interval/timeout/retries and `/health` path. This command proof is not a passing Docker healthcheck: a fresh fixed-source protected rollout must observe actual Docker health before readiness-true.

### Controlled-DOM Linux CI browser dependency

The Greenfield `ubuntu-24.04` job explicitly selects the hosted runner's installed
Google Chrome at `/opt/google/chrome/chrome` using the existing
`FSS_SOCIAL_PUBLISHER_CHROMIUM_PATH` setting. Both initial and replacement
controlled-DOM fixture runtimes use that executable. Local runs may select their
own installed browser with the same setting; when unset, Playwright still requires
its matching browser to be installed separately. `npm ci --ignore-scripts` does not
provision that browser, and the previous job had no browser-install/selection step.

The publisher package's test command first runs an owned browser preflight using the production private launch
options and native Linux renderer-sandbox attestation, then closes the browser and
removes its temporary home. Startup errors are bounded to 12,000 characters in
this account-free fixture diagnostic only; production still sanitizes failures.
No host sandbox-policy changes, disabled confinement or Linux test skips are
permitted. A runner image missing Chrome or unable to attest confinement fails the
preflight rather than silently falling back. These CI changes do not alter the
remote-only production boundary or establish production-host acceptance.

The first November4 failure log exposed only `runtime_unavailable`, so it did not
prove a missing browser. Run41786606583 subsequently passed the installed-Chrome
Node preflight and all21 relay cases, while Vitest's11 native-runtime cases failed.
An actual Vite SSR transform showed the attestation callback's browser import
rewritten to `__vite_ssr_dynamic_import__`, a Node-only helper absent from WebUI.
The fixed attestation sends a static, non-interpolated browser program instead:
its Linux-only `chrome://` import and native strict boolean checks remain inside
Chromium. No source-text assertion substitutes for the real Linux runtime cases.
The post-marker test also surfaces submission failure and releases its authority
wait instead of leaving an unhandled rejection until timeout.

## What the primary sources establish

| Evidence | Consequence / boundary |
| --- | --- |
| Playwright's `chromiumSandbox` launch option enables sandboxing and defaults to `false`. [3] | Set it explicitly to `true`; setting it is a request, not an attestation of active renderer confinement. |
| Playwright Docker guidance says root disables Chromium sandboxing; for crawling/scraping it recommends a separate user plus its seccomp profile, adding permissions for `clone`, `setns`, `unshare` to permit user namespaces. It labels `SYS_ADMIN` a **local-development troubleshooting** suggestion. [4] | Non-root plus permitted namespace operations is the relevant path. The docs do not state `SYS_ADMIN` is universally required. The official image itself is intended for test/development and is not recommended for visiting untrusted sites: do not call the stock image a production security endorsement. |
| Chromium documents layered confinement and seccomp-BPF attack-surface reduction; its setuid helper creates PID/network namespaces, chroots, drops capabilities and returns to the invoking user's IDs. [5] | Merely installing/chmodding `chrome-sandbox` is insufficient: helper privilege transitions and namespace creation must actually be allowed. Setuid does not override the container capability bounding set or host syscall policy. |
| Chromium's historical design explicitly describes user namespaces as the non-setuid alternative. Current namespace source defaults to `CLONE_NEWUSER`, `CLONE_NEWPID`, `CLONE_NEWNET`, checks unprivileged namespace support, and writes `/proc/self/uid_map` and `/proc/self/gid_map` with setgroups handling. [6][7] | There is a real unprivileged route; the historical design is explanatory, while current source is not proof of the precise bundled Chromium revision's runtime behavior. |
| Linux allows unprivileged user namespace creation since 3.8; creation grants capabilities **inside the new namespace**, not the parent. Combining `CLONE_NEWUSER` with other namespace flags creates the user namespace first. [8] | Absence of host/container `CAP_SYS_ADMIN` alone does **not** prove Chromium's userns sandbox impossible. Kernel support, policy, mappings, limits and the actual syscall path still matter. |
| Kernel seccomp documentation permits filter installation after `PR_SET_NO_NEW_PRIVS`, alternatively with `CAP_SYS_ADMIN` in the caller's namespace. Filters may be layered; seccomp filtering by itself is not a complete sandbox. [9] | Chromium's inner renderer filter is distinct from the runtime's outer container filter. Inner policy cannot grant a syscall denied outside it. `Seccomp: 2` alone may describe inherited outer filtering, not prove Chromium confinement. |
| Fargate permits adding only `SYS_PTRACE`; `privileged`, `dockerSecurityOptions` and `ipcMode` are invalid, and `sharedMemorySize`/`tmpfs` are unsupported. [1][2] | Cannot add `SYS_ADMIN` or pass Playwright's `--security-opt seccomp=...` profile through supported Fargate task parameters. This establishes a configuration limitation, **not** the content of Fargate's actual host seccomp filter or a categorical denial of unprivileged namespaces. `SYS_PTRACE` is not a sandbox fix. |
| AWS says Linux containers use the host kernel/configuration, irrespective of their image distribution. [2] | Installing Ubuntu/browser dependencies in the image does not enable missing Fargate kernel features or loosen host policy. |
| Docker's own default seccomp profile restricts namespace-related calls; custom profiles can change its allowlist. [10] | Explains Playwright's Docker recipe, but Docker documentation is not evidence that Fargate uses that exact profile/version/arguments. Do not substitute local Docker restrictions for measured Fargate restrictions. |
| Fargate isolates each **task** in its own hardware-virtualized environment; AWS contrasts EC2 containers, which may access other colocated tasks' credentials/files. [11] | Fargate task isolation is useful but does not replace Chromium's renderer sandbox, nor isolate secrets colocated inside the same task. An EC2 fallback needs a browser-only instance, not a browser beside the app/DB secrets. |

### Native acceptance requirements and actual target result

The following remain required for a successful host. The actual Fargate probe failed at launch, so renderer conditions below were not successfully exercised:

1. Host kernel enables user namespaces and relevant PID/network namespace support; unprivileged creation is permitted by host security policy and namespace limits (including nesting/count limits).
2. Actual outer seccomp/LSM policy permits the Chromium build's required namespace syscalls **with its actual flags**; successful ordinary `clone` does not establish `CLONE_NEWUSER`/`CLONE_NEWPID`/`CLONE_NEWNET` support. `setns`, `unshare`, or clone variants matter only where that build uses them. [4][7][8][10]
3. UID/GID mapping and setgroups operations through `/proc` succeed for the chosen non-root UID; the image/browser has not silently selected an unusable setuid fallback. If using setuid instead, helper ownership/mode, mount flags, privilege-transition policy, bounding capabilities and namespace calls must all permit it. [5][7][8]
4. Chromium can install its own renderer seccomp-BPF policy, and the actual renderer has active namespace confinement and inner filters; a successful process launch alone does not prove both layers. [5][9]
5. The pinned Playwright/Chromium build and all dependencies run natively on the deployed ARM64 image. AWS ARM64 availability is not browser-binary compatibility proof. Playwright recommends its bundled browser and matching image/package versions. [2][3][4]
6. Browser process lifecycle, memory and shared-memory behavior fit the deployed task. Playwright recommends init and host IPC to avoid zombies/Chromium memory crashes; Fargate cannot reproduce host IPC or configure `sharedMemorySize`. These are separate operational risks, not proof the sandbox itself fails. No measurement establishes that the shared 1 GiB baseline is adequate. [1][2][4]

**Observed Root probe:** exact candidate image, Playwright1.64.0/Chromium156.0.8078.79, ARM64/non-root, Fargate1.4.0/default security,512 CPU/1024MiB. Strict launch failed with `Operation not permitted`; no page opened. Failed-start leaf-cgroup high-water was229,490,688 bytes, not publishing capacity or task-level memory proof. One finite zero-account task; no app/DB/session secrets. Successful hosting still requires native renderer namespaces and inner seccomp attestation, local-only image/lifecycle smoke and bounded resource observations. No successful launch, unshare result or outer `Seccomp:2` substitutes for that acceptance. [6][12]

A failure with explicit namespace `EPERM`/sandbox diagnostics narrows that particular environment's blocker; it never authorizes disabling the sandbox. A local Docker pass or failure qualifies only that local host/profile, not Fargate.

The implemented Linux startup guard reads Chromium's own `chrome://sandbox` native WebUI booleans before accepting operations or writing a runner heartbeat: `sandboxGood`, SUID/user namespace, PID namespace, network namespace and seccomp-BPF. Chromium's current native implementation computes `sandboxGood` from exactly these two required layers. [17] Missing/unavailable/nonaffirmative status fails closed; this source guard is not a claim that the target host passed it, and Root's deployed-host probe still owns namespace/filter and resource observations.

Runtime observations are persisted separately by adapter and execution side (`api` / `worker`), with a90-second deadline derived from the same database wall-clock instant as the observation. Insert/upsert preserves that pair; waiting to persist cannot renew its freshness. API login/verification health cannot refresh or overwrite the worker observation. Unattended `runnerAvailable` requires a currently fresh worker observation; API self-account verification remains a separate live account signal and can succeed while unattended execution is unavailable. These bounded observations are not a guarantee of future uptime or publication.

### Observed local diagnostic — not Fargate or Chromium proof

The available Docker engine reported **29.3.1, aarch64, Docker Desktop**, with its builtin seccomp profile and cgroup namespace isolation. Using an already-cached API image (`fss-sentry-api-context-sol:privacy`, local image ID prefix `8ca7a0d253dc`), a network-disabled/read-only container under UID/GID1000 with all capabilities dropped and0.5CPU/1GiB limits ran `/usr/bin/unshare --user --map-root-user --pid --net /bin/true`. It exited1 with **“unshare failed: Operation not permitted.”** No image pull/build, mounts, secrets, published ports or external network were used.

This local namespace diagnostic does not identify the denying layer or substitute for Chromium's actual syscall path. Root subsequently built the native ARM64 API/worker images and proved real JPEG encode/decode; strict local Docker Chromium also failed. The actual Fargate result above is the separate target observation, not an extrapolation from Docker.

## Approved isolated host — finite native and authenticated transport acceptance passed

**Approved candidate:** one browser-only EC2 Linux `t4g.small` (ARM64,2vCPU/2GiB), Standard CPU credits, encrypted20GiB gp3, keeping app/DB/provider credentials on Fargate. Native probe used AL2023 AMI `ami-0f11e0e04ccb60d0a`, kernel6.1.189 and Docker25.0.18. Chromium156's own `sandboxGood/userNs/pidNs/netNs/seccompBpf` were affirmative; renderer processes had two seccomp filters, CapEff0 and NNP1. Owned PNG rendering/screenshot, context/tempdir cleanup passed; cgroup peak416.15MiB within1280MiB, no cgroup throttling/OOM observed. This tiny network-none diagnostic does not prove LinkedIn capacity or bridged-network isolation. The temporary instance, volume, role/profile/policy, SG and image tag were removed. Native evidence: Root's private `social-ec2-probe-20261104.md`. [18]

The implemented host uses a direct non-root browser-only container, not an ECS custom daemon. The outer profile starts from Moby's pinned modern Docker default (`b08a51fe16eed67de3861c03b363ba403643b12e`) and additionally allows only `clone`, `setns`, `unshare` and `chroot`. Actual Chromium required `chroot` for its child user-namespace `/proc/self/fdinfo/` jail while host capability sets remained empty; no SYS_ADMIN, privileged, unconfined or sandbox-disabling fallback. The exact native-passing profile is vendored in `infra/modules/social-publisher/seccomp.json`. [4][10]

**Final actual broker acceptance:** the production `hostMain.ts` and rendered systemd/network helper passed on the same approved AMI, using the final ARM64 API image. Six authenticated real Playwright clients rendered owned images; native confinement, cookie isolation, seventh-client503, disconnect/replacement, heartbeat survival and clean shutdown passed. Direct OS requests to IMDS, private forwarding and a known-live owned host service timed out with corresponding firewall DROP-counter increases; AWS resolver UDP/TCP53 passed. No LinkedIn page/account action. All temporary instance/volume/SG/role/profile/policy/image-tag resources were removed. Root's private `social-host-final-probe-20261104.md` retains exact observations.
  
PID256 exhausted its cgroup during six-client-plus-attestation work; PID512 passed without changing1280MiB/1.5CPU/instance/security bounds. Final memory peak789.49MiB, no OOM; CPU quota throttling occurred. These owned-fixture measurements do not establish sustained workload/Standard-credit capacity. Actual production ALB/TLS, Secrets Manager delivery and CloudWatch logging remain unverified.

The application supplies only minimal browser launch environment. The supported Debian wrapper adds distribution `GOOGLE_*`/`CHROME_*` defaults; no values were logged. Actual Chromium had no application FSS/control-token/AWS/PG/DB/DEBUG keys. Do not claim its environment contains exactly five names.

Implemented/reviewed controls keep app DB/provider/session keys and Docker socket out of the browser host; native listener is loopback-only, authenticated relay ingress is bounded, bridged IMDS/private/host requests are denied, account state is encrypted/minimized separately in PostgreSQL, and revocation/no-repeat/uncertain-outcome semantics remain enforced by the app. AWS assigns host/agent/browser patching and EC2 isolation to the customer. [11] Finite sandbox/transport acceptance does not prove account identity, native submission/inspection/cancellation or production deployment.

### Funding evidence — credits are applied, but balance and expiry are access-blocked

**Observed November4,2026 (UTC), using the existing account/principal and read-only requests:** AWS Cost Explorer returned applied credit line items for November1–3 (`2026-11-01` inclusive through `2026-11-04` exclusive), grouped by record type and service. These are credits already offsetting reported costs, **not a credit balance, a future coverage commitment, or a zero-cost host quotation**. Cost Explorer's service-level grouping does not establish which individual EBS or IPv4 usage types received a credit. [19]

| Relevant service grouping | Observed applied credit (USD) | What this establishes |
| --- | --- | --- |
| Amazon Elastic Compute Cloud - Compute | -$5.1817884352 | Existing EC2 compute charges have received credits in this period; remaining funding for another instance is unknown. |
| EC2 - Other | -$0.2706646888 | This service grouping received credits; it does not separately prove eligibility for the proposed gp3 volume. |
| Amazon Virtual Private Cloud | -$2.441122765 | This service grouping received credits; it does not separately prove eligibility for the proposed public IPv4 address. |

Credits also appeared for existing ECS, ECR, RDS and other infrastructure. This supports answering **“yes, AWS credits are being used”**, not **“the new host is free.”**

The installed AWS CLI **2.36.22** supports the current official `billing get-credits` operation. A real request for this account, start date `2026-11-01T00:00:00Z`, region `us-east-1`, with the end date omitted, reached AWS and returned **`AccessDeniedException: IAM user access not activated`**. This is the proved blocker, not a missing CLI command or an empty credit list. No new SDK/install, credentials, account grants, activation changes, provisioning or spending was performed. A different SDK invoking the same operation with the same principal would not resolve this account-access denial [INFERENCE]. The signed-out browser console was not used.

The supported API would return `remainingAmount` (unused balance), optional `estimatedAmount` (including in-flight open bills), `applicableProductNames`, validity/expiry dates and `creditStatus`. **None of those account-specific values was returned: remaining balance, estimated balance, expiration, enabled status and explicit EC2/EBS/IPv4 eligibility remain unknown, not zero.** [20][21] AWS documents root-controlled activation of IAM Billing access plus the relevant IAM permissions; its documented Cost Explorer API exception explains why successful Cost Explorer access does not prove Credits access. The exact observed Billing denial is the evidence here; no IAM policy or activation setting was changed or independently inspected. [22]

**Funding boundary:** David approved the approximately$20/month host budget after Root explicitly distinguished applied credits from free hosting. Remaining credit details are an optional billing-owner information dependency, not another provisioning-approval gate. An authorized billing owner can supply sanitized balance/estimated balance, expiry, enabled status and applicable products or enable the necessary read access; never request passwords/redemption codes. Do not assume EC2/gp3/IPv4 coverage or T4g trial eligibility. AWS credits apply only to eligible designated services and expire; taxes and charges beyond available credit remain payable. [23]

### Resource and cost assumptions — illustration, not spending approval

Assume Linux on-demand US East (N. Virginia), no reservations/free-tier/Spot, 730 running hours/month, a 20 GiB gp3 disk and one public IPv4 **only if** the approved network design needs it:

| Component | Primary-source rate and illustrative calculation |
| --- | --- |
| `t4g.small` | AWS Price List API, us-east-1 Linux/shared/on-demand, effective November1: **$0.0168/hour**, or **$12.26/month** at730hours;2vCPU/2GiB. No reservation, trial or credit eligibility assumed. [18] |
| gp3 storage | AWS's pricing example uses $0.08/GB-month in a region charging that rate: 20 × $0.08 = **$1.60/month assumption**, not a region-specific price fetched from the dynamic rate table. Storage is charged while provisioned, not just while the host runs. [15] |
| Public IPv4 | $0.005/address-hour: **$3.65/month** at 730 hours; idle addresses are also charged. Not needed if an already-approved egress path serves this host. [16] |
| Illustrative subtotal | **$17.51/month** compute/disk/IPv4; approximately **$18–20/month** allowing small control-secret/log costs, before taxes, credits, ECR, snapshots and variable transfer. Estimate, not a spending approval or hard billing cap. |
| CPU-credit risk | T4g defaults to Unlimited; sustained above-baseline use can add$0.04/vCPU-hour. Choose Standard mode to avoid surplus-credit billing, accepting throttling when earned credits run out. [18] |
| Networking risk | Actual production tasks use public subnets/public IPs. Include one IPv4 for the host; no new NAT gateway, load balancer or endpoints. Authenticated ingress and network guards are implemented/reviewed and finitely exercised; production ALB/TLS acceptance remains. [16] |

For comparison only, AWS's Fargate ARM/N. Virginia example gives $0.0000089944/vCPU-second and $0.0000009889/GiB-second. An **additional** continuously running 0.5-vCPU/1-GiB task at 730 hours is about **$14.42/month compute**, excluding networking/logs; 1 vCPU/2 GiB is about **$28.83/month**. These prices do not establish sandbox feasibility, spare capacity in existing tasks, or authorization to increase their footprint. Fargate bills requested resources from image download through task termination, per second with a one-minute Linux minimum. [12]

Stopping/on-demand operation may reduce compute but introduces startup and session/inspection availability risks; disk and retained public addresses may continue billing. Treat the EC2 route as a separately authorized AWS infrastructure decision, not a loophole in the no-new-SaaS rule or the existing application budget.

## Sources

1. [AWS ECS Fargate task definition parameters](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html), especially runtime platform, task size and Linux parameters.
2. [AWS ECS task definition differences for Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-tasks-services.html), unsupported parameters and host-kernel note.
3. [Playwright BrowserType launch: chromiumSandbox](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-chromium-sandbox).
4. [Playwright Docker documentation](https://playwright.dev/docs/docker), root/non-root, seccomp profile, recommended configuration and image warning.
5. [Chromium current Linux sandbox README](https://chromium.googlesource.com/chromium/src/+/main/sandbox/linux/README.md?format=HTML).
6. [Chromium Linux Sandboxing, historical source revision](https://chromium.googlesource.com/chromium/src/+/ab75a4aa586045c047b29d8ba5f5aae7163366f9/docs/linux/sandboxing.md?format=HTML), explicitly historical rather than current deployment proof.
7. [Chromium current namespace sandbox implementation](https://chromium.googlesource.com/chromium/src/+/main/sandbox/linux/services/namespace_sandbox.cc?format=HTML).
8. [Linux man-pages: user_namespaces(7)](https://man7.org/linux/man-pages/man7/user_namespaces.7.html).
9. [Linux kernel: Seccomp BPF](https://www.kernel.org/doc/html/latest/userspace-api/seccomp_filter.html).
10. [Docker: Seccomp security profiles](https://docs.docker.com/engine/security/seccomp/).
11. [AWS ECS shared responsibility: Fargate versus EC2](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/security-shared-model.html).
12. [AWS Fargate pricing](https://aws.amazon.com/fargate/pricing/), ARM example, billing duration and additional charges.
13. [AWS EC2 T3 instance specifications and N. Virginia Linux pricing](https://aws.amazon.com/ec2/instance-types/t3/).
14. [AWS ECS container instance bootstrap: Docker daemon](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/bootstrap_container_instance.html#bootstrap_docker_daemon).
15. [AWS EBS pricing](https://aws.amazon.com/ebs/pricing/), gp3 example and provisioned-storage billing.
16. [AWS VPC pricing](https://aws.amazon.com/vpc/pricing/), public IPv4 rates and NAT gateway examples.
17. [Chromium native SandboxInternalsUI status calculation](https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/ui/webui/sandbox/sandbox_internals_ui.cc).
18. [AWS EC2 T4g specifications and CPU-credit pricing](https://aws.amazon.com/ec2/instance-types/t4/); regional on-demand compute rate additionally read from AWS Price List `GetProducts`, service `AmazonEC2`, instance `t4g.small`, region `us-east-1`, Linux/shared/NA/Used, SKU `9GWX7R3VJUG9P8Y8`, November4,2026.
19. [AWS Cost Explorer GetCostAndUsage](https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_GetCostAndUsage.html), record/service grouping and inclusive-start/exclusive-end period semantics; account-specific evidence was a successful read-only November1–3 response, inspected November4,2026.
20. [AWS CLI billing get-credits](https://docs.aws.amazon.com/cli/latest/reference/billing/get-credits.html), current supported command and credit balance, estimated balance, applicable products, validity and status fields.
21. [AWS Billing GetCredits API](https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_billing_GetCredits.html), request/response and access-denied semantics; actual CLI request returned `AccessDeniedException: IAM user access not activated` on November4,2026.
22. [AWS Billing access control](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/control-access-billing.html), root-controlled IAM activation, separate policy requirement and Cost Explorer API exception.
23. [AWS Promotional Credit Terms and Conditions](https://aws.amazon.com/awscredits/), updated September24,2026; designated eligible services, excess usage charges, tax exclusion and expiry.
