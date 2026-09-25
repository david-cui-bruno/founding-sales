// Release mutations that edit Terraform, the policies and the Dockerfiles (`infra/` outside `infra/scripts/`, `Dockerfile.*`).
//
// Loaded by `loadMutations` in scripts/releaseMutationRunner.mjs, which also holds the
// rule that decides an entry's area (MUTATION_AREAS). Each entry's fields are described
// at the top of scripts/releaseMutationCheck.mjs. Append to the end of this file.

/** @type {import('../releaseMutationRunner.mjs').Mutation[]} */
export const MUTATIONS = [
  {
    name: 'the worker image stops verifying the database\u2019s certificate',
    file: 'Dockerfile.worker',
    find: '    PGSSLMODE=verify-full \\\n',
    replace: '    PGSSLMODE=no-verify \\\n',
    suite: ['run', 'test:release'],
    because:
      'rds.force_ssl = 1 refuses a plain connection and Node\u2019s roots do not include Amazon RDS. no-verify would connect to anything that answers on the port; verify-full plus the RDS bundle is the contract. Run 35876269976 (23 September 2026) was the first process to reach the real database, and it was refused at the handshake.',
  },
  {
    name: 'the database stops forcing SSL',
    file: 'infra/modules/database/main.tf',
    find: '    name  = "rds.force_ssl"\n    value = "1"',
    replace: '    name  = "rds.force_ssl"\n    value = "0"',
    suite: ['run', 'test:release'],
    because:
      'The images verify TLS because the database demands it; a parameter group that stopped demanding it would let a misconfigured client fall back to plaintext unnoticed. The two are one contract.',
  },
  {
    name: 'the migration entry becomes readable by the services',
    file: 'infra/modules/cluster/main.tf',
    find: '  runtime_secret_arns = distinct(concat(values(var.secret_arns), [var.app_runtime_database_secret_arn]))',
    replace:
      '  runtime_secret_arns = distinct(concat(values(var.secret_arns), [var.app_runtime_database_secret_arn, var.migration_database_secret_arn]))',
    suite: ['run', 'test:release'],
    because:
      "David's first condition of 21 September is that the runtime task role has no path to DDL credentials. It is one line of a `locals` block, and nothing but the tftest stands between it and a service that can migrate its own database, so scenario 22's infrastructure assertions have to go red when the line changes.",
  },
  {
    name: 'a fresh environment starts its services before the schema exists',
    file: 'infra/modules/cluster/main.tf',
    find: '  api_desired_count    = var.bootstrap ? 0 : var.api_desired_count',
    replace: '  api_desired_count    = var.api_desired_count',
    suite: ['run', 'test:release'],
    because:
      'Both binaries refuse a database whose schema version is not exactly the range they declare, so an apply that created the API running would create it crash-looping against an empty database while the migration task that would fix it had not been launched. The bootstrap is the whole of condition 2 and it is one ternary.',
  },
  {
    name: 'the drill task stops fixing its dependency mode',
    file: 'infra/modules/cluster/main.tf',
    find: '  drill_environment = merge(local.worker_environment, { FSS_DEPENDENCIES = "recorded" })',
    replace: '  drill_environment = local.worker_environment',
    suite: ['run', 'test:release'],
    because:
      '`reconcile-sent`, `recover` and `watch-renew` all reach Gmail when dependencies are live, and a rehearsal that reached a real mailbox would send real mail. The tool refuses in any other mode, and the task definition is the second lock on the same door: with it gone the drill inherits the root\'s mode, which in production is `live`.',
  },
  {
    name: "the deployment role's KMS deny goes back to covering every key",
    file: 'infra/policies/deployment-role-policy.json.tftpl',
    find: '      "NotResource": "${state_kms_key_arn}",\n      "Condition": {\n        "StringNotLike": {\n          "aws:ResourceTag/NamePrefix": "${name_prefix}*"\n        }\n      }\n',
    replace: '      "Resource": "*"\n',
    suite: ['run', 'test:release'],
    because:
      'This is the 21 September failure exactly: `kms:GenerateDataKey*` and `kms:Decrypt` denied on every key but the Terraform state key, which Secrets Manager checks at CreateSecret, so all eight entries failed with "Access to KMS is not allowed" while the policy still carried an allow for them. A check that searched the document for the action would stay green; only an evaluation that reads the denies as well can go red, and that is what the coverage check does.',
  },
  {
    name: "the journal's write and read denies stop exempting the deployer",
    file: 'infra/modules/journal/main.tf',
    find: 'Condition = merge({ ArnNotLike = { "aws:PrincipalArn" = local.writer_principal_patterns } }, local.administrative_exemption)',
    replace: 'Condition = { ArnNotLike = { "aws:PrincipalArn" = local.writer_principal_patterns } }',
    suite: ['run', 'test:release'],
    because:
      'A deny that exempts the deployer from deletion but not from writes or reads is the 21 September shape with one statement fixed: the teardown could not even list the bucket versions it was about to bypass. `terraform test` proves this properly and runs in the offline gate rather than here, so the release suite asserts the merge expression verbatim and has to notice when it becomes a replacement.',
  },
  {
    name: 'the journal stops letting its deployer see that the bucket exists',
    file: 'infra/modules/journal/main.tf',
    find:
      'Condition = merge({ ArnNotLike = { "aws:PrincipalArn" = local.reader_principal_patterns } }, local.listing_exemption)',
    replace: 'Condition = { ArnNotLike = { "aws:PrincipalArn" = local.reader_principal_patterns } }',
    suite: ['run', 'test:release'],
    because:
      'This is the first production apply exactly (23 September 2026): `fss-prod-deploy` created the bucket, was refused its own HeadBucket \u2014 which S3 authorises as `s3:ListBucket` \u2014 and the provider read the 403 as "the bucket is gone", dropped it from state, planned to create it again and deleted the encryption configuration and the ownership controls on the way past. `terraform test` proves the rendered condition and runs in the offline gate rather than here, so the release suite asserts the merge expression verbatim and has to notice when the exemption leaves it.',
  },
  {
    name: 'the mailbox heartbeat alarm counts five-minute periods while the heartbeat promises one',
    file: 'infra/modules/alerts/main.tf',
    find: '      metric_name         = "MailboxCheckHeartbeat"\n      statistic           = "Sum"\n      comparison          = "LessThanThreshold"\n      threshold           = 1\n      period              = 60\n',
    replace:
      '      metric_name         = "MailboxCheckHeartbeat"\n      statistic           = "Sum"\n      comparison          = "LessThanThreshold"\n      threshold           = 1\n      period              = 300\n',
    suite: ['run', 'test:release', '--', 'test/release/mailboxHeartbeatCadence.check.ts'],
    because:
      'Raising the alarm to the old sweep\u2019s five minutes is the other way to stop the 24 September flapping, and it leaves the alarm and the sixty-second heartbeat disagreeing in the opposite direction: fifteen quiet minutes before anyone hears that a mailbox stopped being read. mailboxHeartbeatCadence.check.ts requires the period to equal the interval recordMailboxHeartbeat writes, so it has to go red.',
  },
  {
    name: 'an apply may move the worker\u2019s count again',
    file: 'infra/modules/cluster/main.tf',
    find: '  # As on the API service above: the apply replaces the task definition and leaves\n  # the count where the release scripts put it.\n  lifecycle {\n    ignore_changes = [desired_count]\n  }\n',
    replace: '',
    suite: ['run', 'test:release'],
    because:
      'release-stop.sh stops both services before a schema-change apply, and the apply after it puts the declared count back unless the service ignores changes to desired_count: the worker would start against the old schema and exit 12 before the migration. release_owns_the_count.tftest.hcl applies the difference but runs outside npm run test:release, so scenario22 reads the lifecycle inside each service block and has to go red.',
  },
  {
    name: 'the restore-mismatch alarm clears one quiet minute after the last line again',
    file: 'infra/modules/alerts/main.tf',
    find: '      evaluation_periods  = 3\n      datapoints_to_alarm = 1\n',
    replace: '      evaluation_periods  = 1\n      datapoints_to_alarm = 1\n',
    suite: ['run', 'test:release', '--', 'test/release/alarmIncidents.check.ts'],
    because:
      'This is audit O16 at the alarm: the worker logs the mismatch once per fixed-delay metric pass, a little over a minute apart, so one minute in many hundreds has no line, and a one-period alarm reads that minute OK and sends a second ALARM e-mail on the next. alarmIncidents.check.ts reads the restore_generation_mismatch entry of local.alarms and requires one datapoint in three; at one in one it has to go red.',
  },
  {
    name: 'a missing Gmail watch gauge is a breaching datapoint again',
    file: 'infra/modules/alerts/main.tf',
    find: '      treat_missing_data  = "notBreaching"\n      severity            = "critical"\n      description         = "A Gmail watch is within two days of expiry. Push stops when it lapses."\n',
    replace: '      treat_missing_data  = "breaching"\n      severity            = "critical"\n      description         = "A Gmail watch is within two days of expiry. Push stops when it lapses."\n',
    suite: ['run', 'test:release', '--', 'test/release/alarmIncidents.check.ts'],
    because:
      'This is audit O15 at the alarm: GmailWatchHoursToExpiry is published only while a mailbox is connected, so a breaching missing datapoint put an environment with no mailbox, or one disconnected on purpose, in critical ALARM. alarmIncidents.check.ts reads the gmail_watch_expiring entry and requires notBreaching and not breaching; with breaching back it has to go red.',
  },
  {
    name: 'each critical condition composite reads the whole roll-up instead of its own alarm',
    file: 'infra/modules/alerts/main.tf',
    find: '  alarm_rule        = "ALARM(\\"${each.value}\\")"\n',
    replace: '  alarm_rule        = aws_cloudwatch_composite_alarm.critical.alarm_rule\n',
    suite: ['run', 'test:release', '--', 'test/release/alarmIncidents.check.ts'],
    because:
      'This is audit O14: a composite over the OR of every critical alarm does not transition when a second member trips, so the second incident is silent while the first is open. alarmIncidents.check.ts requires each per-condition composite rule to be ALARM of its own alarm; built from the roll-up rule every one of them is the roll-up again and the suite has to go red.',
  },
  {
    name: 'every critical condition is held back while the worker heartbeat alarm is open',
    file: 'infra/modules/alerts/main.tf',
    find: '    if alarm.severity == "critical" && alarm.treat_missing_data == "breaching" && name != "worker_heartbeat_missed"\n',
    replace: '    if alarm.severity == "critical" && name != "worker_heartbeat_missed"\n',
    suite: ['run', 'test:release', '--', 'test/release/alarmIncidents.check.ts'],
    because:
      'This is audit O14 from the other side: suppression is for the four conditions the worker’s own silence trips; held back behind the worker alarm, a journal failure, a restore mismatch or an invariant failure during a worker outage would wait for the worker to recover before anyone heard. alarmIncidents.check.ts requires the derivation to keep the breaching clause; without it the safety conditions are suppressed too and the suite has to go red.',
  },
  {
    name: 'the load balancer polls liveness again',
    file: 'infra/modules/edge/variables.tf',
    find: '  default     = "/readyz"\n',
    replace: '  default     = "/healthz"\n',
    suite: ['run', 'test:release', '--', 'test/release/loadBalancerReadiness.check.ts'],
    because:
      'This is audit S14: /healthz answers 200 whenever the process runs, so a task on the wrong schema range or generation, or with no database connection free, was put in service. loadBalancerReadiness.check.ts compares the target group default with READINESS_PATH from apps/api/src/bootstrap/readiness.ts; back on /healthz it has to go red.',
  },
  {
    name: 'the worker is handed the session-signing key again',
    file: 'infra/modules/cluster/main.tf',
    find: '  worker_secret_names     = ["google-gmail-oauth-client", "llm-classifier-api-key"]\n',
    replace: '  worker_secret_names     = ["google-gmail-oauth-client", "llm-classifier-api-key", "session-signing-key"]\n',
    suite: ['run', 'test:release', '--', 'test/release/processSecrets.check.ts'],
    because:
      'This is audit S17: the worker never signs a session, and a worker that holds the key can mint one. processSecrets.check.ts requires the session-signing key, the device-credential pepper and the sign-in client in the API list and in no other; with the key on the worker it has to go red.',
  },
  {
    name: 'the worker task definition is built from the API secret map',
    file: 'infra/modules/cluster/main.tf',
    find: '      secrets = [for name in sort(keys(local.worker_task_secrets)) : {\n        name      = name\n        valueFrom = local.worker_task_secrets[name]\n',
    replace: '      secrets = [for name in sort(keys(local.api_task_secrets)) : {\n        name      = name\n        valueFrom = local.api_task_secrets[name]\n',
    suite: ['run', 'test:release', '--', 'test/release/processSecrets.check.ts'],
    because:
      'This is audit S17 at the definition: the lists are only true if each definition’s secrets block is built from its own map, and a worker built from the API map carries all of the API’s authentication material again. processSecrets.check.ts reads each task definition’s secrets block and requires its own map; built from api_task_secrets it has to go red.',
  },
  {
    name: 'the coverage warning waits half an hour while the gate holds after fifteen minutes',
    file: 'infra/modules/alerts/variables.tf',
    find: '  default     = 900\n\n  validation {\n    condition     = var.mailbox_coverage_stale_seconds > 0\n',
    replace: '  default     = 1800\n\n  validation {\n    condition     = var.mailbox_coverage_stale_seconds > 0\n',
    suite: ['run', 'test:release', '--', 'test/release/alarmIncidents.check.ts'],
    because:
      'Lane g81: the warning exists to say the send gate is holding for coverage, and a threshold other than COVERAGE_FRESHNESS_SECONDS would say it late, or say it while nothing is held. alarmIncidents.check.ts requires the variable default to equal the constant in packages/domain/mail/coverage.ts; at 1800 it has to go red.',
  },
  {
    name: 'the classifier key is handed to the worker under its logical name again',
    file: 'infra/modules/cluster/main.tf',
    find: '    "llm-classifier-api-key" = "FSS_LLM_CLASSIFIER_API_KEY"\n',
    replace: '    "llm-classifier-api-key" = "llm-classifier-api-key"\n',
    suite: ['run', 'test:release', '--', 'test/release/processSecrets.check.ts'],
    because:
      'Lane g81: the ECS secrets block names the environment variable, and the classifier reads FSS_LLM_CLASSIFIER_API_KEY, so a key injected as llm-classifier-api-key left the deployed worker with no classifier and classify.reply unclaimed forever. processSecrets.check.ts requires the cluster rename to name exactly CLASSIFIER_SECRET_ENVIRONMENT_VARIABLES.llm_classifier_api_key; mapped to its own name it has to go red.',
  },
  {
    name: 'a rehearsal worker is handed the classifier key',
    file: 'infra/modules/stack/main.tf',
    find: '  worker_reads_classifier_key = local.is_production\n',
    replace: '  worker_reads_classifier_key = true\n',
    suite: ['run', 'test:release', '--', 'test/release/processSecrets.check.ts'],
    because:
      'Lane g81: the classifier has no recorded seam and a rehearsal fills its entry with a fixture, so a rehearsal worker holding the key would send fixture replies to the provider under a key that cannot work and fail every classify.reply. processSecrets.check.ts requires the stack to hand it over in production alone; with true it has to go red.',
  },
  {
    name: 'research-provider-credentials, which nothing reads, is handed to the worker again',
    file: 'infra/modules/cluster/main.tf',
    find: '  worker_secret_names     = ["google-gmail-oauth-client", "llm-classifier-api-key"]\n',
    replace: '  worker_secret_names     = ["google-gmail-oauth-client", "llm-classifier-api-key", "research-provider-credentials"]\n',
    suite: ['run', 'test:release', '--', 'test/release/processSecrets.check.ts'],
    because:
      'Lane g81, audit S17: no process reads the research credential, and a secret in a process that never reads it is one more thing that process can leak. processSecrets.check.ts requires it in the unread list and in no process list; back on the worker it has to go red.',
  },
  {
    name: 'the worker log group is no longer filtered for suppression journal failures',
    file: 'infra/modules/observability/main.tf',
    find: '    suppression_journal_write_failed_worker = {\n      service     = "worker"\n',
    replace: '    suppression_journal_write_failed_worker = {\n      service     = "api"\n',
    suite: ['run', 'test:release', '--', 'test/release/alarmIncidents.check.ts'],
    because:
      'Lane g81: the worker journals the opt-outs mail sync records and logs its failures into the worker log group, so a filter on the API group alone never counts them. alarmIncidents.check.ts requires the worker entry to read the worker group; pointed at the API group it has to go red.',
  },
  {
    name: 'the production root declares the Google provider again',
    file: 'infra/roots/production/providers.tf',
    find: '# There is no Google provider here, and no plan of this root needs a Google login.\n',
    replace:
      'provider "google" {\n  project = "callie-fss"\n}\n\n# There is no Google provider here, and no plan of this root needs a Google login.\n',
    suite: ['run', 'test:release', '--', 'test/release/googleRoot.check.ts'],
    because:
      'Audit O01: Terraform configures every provider a root declares before it plans anything, so one provider block is every production plan asking for application-default credentials that lapse about every 17 hours, which is what held back a worker fix. The Google provider belongs to infra/roots/production-google alone (lane g85), and googleRoot.check.ts has to go red.',
  },
  {
    name: 'the production topic default drifts from the name the Google root gives the topic',
    file: 'infra/roots/production/variables.tf',
    find: '  default     = "projects/callie-fss/topics/fss-prod-gmail-push"\n',
    replace: '  default     = "projects/callie-fss/topics/fss-prod-gmail-push-v2"\n',
    suite: ['run', 'test:release', '--', 'test/release/googleRoot.check.ts'],
    because:
      'Since lane g85 the production root carries the topic id as a committed default rather than reading it from the object, so nothing but this check ties the two together. A drifted default is a worker renewing the Gmail watch on a topic that does not exist, found only when push stops. googleRoot.check.ts derives the id from the Google root’s project and prefix and the module’s naming, and has to go red.',
  },
  {
    name: 'the production root destroys the push objects it used to manage instead of forgetting them',
    file: 'infra/roots/production/main.tf',
    find: '    destroy = false\n',
    replace: '    destroy = true\n',
    suite: ['run', 'test:release', '--', 'test/release/googleRoot.check.ts'],
    because:
      'Between the merge and the migration’s state rm, a production plan still sees module.pubsub[0] in state. With destroy = true it proposes deleting the topic, the subscription, the push identity and Gmail’s publisher grant, and the grant needed an organisation-policy exception to be made at all (release.md 8.0n). googleRoot.check.ts requires destroy = false and has to go red.',
  },
  {
    name: 'the worker is handed the upgrade address too',
    file: 'infra/modules/stack/main.tf',
    find: '  worker_environment = {\n    FSS_RESEARCH_PROVIDERS = var.research_providers\n  }\n',
    replace:
      '  worker_environment = {\n    FSS_RESEARCH_PROVIDERS = var.research_providers\n    FSS_DESKTOP_UPGRADE_URL = var.desktop_upgrade_url\n  }\n',
    suite: ['run', 'test:release', '--', 'test/release/upgradeUrl.check.ts'],
    because:
      'Lane g86: the upgrade notice is the API’s alone, and a variable a process never reads is a variable that drifts. upgradeUrl.check.ts reads the worker block of infra/modules/stack and requires it not to name FSS_DESKTOP_UPGRADE_URL.',
  },
  {
    name: 'the production upgrade address stops pointing at the manifest the desktop reads',
    file: 'infra/roots/production/variables.tf',
    find: '  default     = "https://dlcmdaeskewt5.cloudfront.net/releases/darwin-arm64/latest.json"\n',
    replace: '  default     = "https://dlcmdaeskewt5.cloudfront.net/downloads/mac"\n',
    suite: ['run', 'test:release', '--', 'test/release/upgradeUrl.check.ts'],
    because:
      'Lane g86: the address production publishes is the signed manifest at CHANNEL_MANIFEST_PATH, releases/darwin-arm64/latest.json. upgradeUrl.check.ts compares the root default with the desktop constant, so a default at any other path has to go red.',
  },
  {
    name: 'the critical job-age alarm waits five minutes past its threshold again',
    file: 'infra/modules/alerts/main.tf',
    find:
      '      threshold           = var.oldest_job_age_critical_seconds\n      period              = 60\n      evaluation_periods  = 1\n      datapoints_to_alarm = 1\n',
    replace:
      '      threshold           = var.oldest_job_age_critical_seconds\n      period              = 60\n      evaluation_periods  = 5\n      datapoints_to_alarm = 5\n',
    suite: ['run', 'test:release', '--', 'test/release/jobAgeAlarm.check.ts'],
    because:
      'Audit O18: 13.3 says fifteen minutes is critical, and five of five one-minute breaches fired at about twenty. The age only grows while a job waits, so one breach is the target. jobAgeAlarm.check.ts requires one of one and has to go red.',
  },
];
