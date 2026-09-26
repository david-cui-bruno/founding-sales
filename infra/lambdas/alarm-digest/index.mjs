// The alarm digest's Lambda entry point (lane g99). `digest.mjs` holds everything that
// decides; this file only hands it the three AWS calls and the three settings.
//
// The AWS SDK for JavaScript v3 is part of the Node.js Lambda runtime, so the zip is these
// two files and nothing else: no build step, no node_modules.

import { CloudWatchClient, DescribeAlarmHistoryCommand, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { runDigest } from './digest.mjs';

const cloudwatch = new CloudWatchClient({});
const sns = new SNSClient({});

export async function handler() {
  const summary = await runDigest({
    prefix: process.env.FSS_ALARM_PREFIX,
    topicArn: process.env.FSS_ALERT_TOPIC_ARN,
    timeZone: process.env.FSS_DIGEST_TIME_ZONE,
    now: new Date(),
    describeAlarms: input => cloudwatch.send(new DescribeAlarmsCommand(input)),
    describeAlarmHistory: input => cloudwatch.send(new DescribeAlarmHistoryCommand(input)),
    publish: input => sns.send(new PublishCommand(input)),
  });
  console.log(JSON.stringify({ event: 'alarm_digest_published', ...summary }));
  return summary;
}
