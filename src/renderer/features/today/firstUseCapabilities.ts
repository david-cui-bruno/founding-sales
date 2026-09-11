import type { DailyAnswer } from '../../../shared/contracts/dailyContract';

/** Presentation only: retain every saved object and its order within each group. */
export function partitionFirstUseAnswers(answers: readonly DailyAnswer[]) {
  const continuations: DailyAnswer[] = [];
  const history: Extract<DailyAnswer, { kind: 'reply' }>[] = [];
  for (const answer of answers) {
    if (answer.kind === 'reply') history.push(answer);
    else continuations.push(answer);
  }
  return { continuations, history };
}
