type FounderConfirmationActivity = Readonly<{
  kind: string;
  observedOutcome: string | null;
}>;

export function qualifiesFounderInterviewed(activity: FounderConfirmationActivity): boolean {
  return activity.kind === 'interview'
    || (activity.kind === 'call' && activity.observedOutcome === 'answered');
}

export function qualifiesFounderOffered(activity: FounderConfirmationActivity): boolean {
  return activity.observedOutcome === 'price_said';
}
