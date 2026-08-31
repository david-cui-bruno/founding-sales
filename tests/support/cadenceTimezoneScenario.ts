import { BUILTIN_CADENCES } from '../../src/main/domain/cadence/builtinCadences';
import {
  FOUNDER_CHANNEL_POLICIES_V1,
  scheduleComponent,
} from '../../src/main/domain/cadence/cadenceScheduler';

const definition = BUILTIN_CADENCES[0]!;
const step = definition.steps[2]!;
process.stdout.write(JSON.stringify(scheduleComponent({
  step,
  component: step.components[0]!,
  anchorAt: '2026-10-31T14:30:00.000Z',
  evaluationAt: '2026-10-31T14:30:00.000Z',
  timezone: 'America/New_York',
  policies: FOUNDER_CHANNEL_POLICIES_V1,
  priorCallWindow: null,
})));
