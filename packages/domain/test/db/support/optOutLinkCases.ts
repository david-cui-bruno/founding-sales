/**
 * One table of examples for the no-visible-opt-out-link rule, run against **both**
 * spellings of it: `hasOptOutLink` in `@fss/contracts`
 * (`packages/domain/test/domain/optOutLink.test.ts`) and `email_has_optout_link` in
 * migration 0023 (`packages/domain/test/db/optOutLink.test.ts`). A rule written twice is
 * a rule that drifts; this file is what makes the two answers the same answer.
 *
 * Every row of the reviewer's table in the review of PR 311 is here, with the answer the
 * rule David decided on gives — including the three it deliberately gets "wrong", which
 * are named as accepted limitations in the migration header and in
 * `docs/greenfield/mail.md`.
 *
 * No real address or firm: `example`, `example.test` and `firm.example` throughout.
 */

export interface OptOutLinkCase {
  /** What the row is about, used as the assertion message. */
  readonly what: string;
  readonly text: string;
  /** True when the rule refuses these bytes. */
  readonly refused: boolean;
}

export const OPT_OUT_LINK_CASES: readonly OptOutLinkCase[] = Object.freeze([
  // ------------------------------------------------ the reviewer's table, row by row
  {
    what: 'a stop-these-messages label on the line above its link',
    text: 'To stop these messages, click here:\nhttps://short.example/a',
    refused: true,
  },
  {
    what: 'an unsubscribe label on the line above its link',
    text: 'To unsubscribe, click here:\nhttps://short.example/a',
    refused: true,
  },
  {
    what: 'a labelled mailto:, whatever the address is',
    text: 'Unsubscribe: mailto:help@example.test',
    refused: true,
  },
  {
    what: 'a non-breaking hyphen in opt-out, which the dash folding removes',
    text: 'Opt‑out: https://x.example/a',
    refused: true,
  },
  {
    what: 'a Cyrillic O in Opt out: an accepted limitation, NFKC folds no confusables',
    text: 'Оpt out: https://x.example/a',
    refused: false,
  },
  {
    what: 'a bare shortener with no phrase near it: an accepted limitation, the bytes cannot say where it goes',
    text: 'Have a look: https://short.example/a',
    refused: false,
  },
  {
    what: 'a tab and two spaces between the label and the link',
    text: 'Unsubscribe\t  https://x.example/a',
    refused: true,
  },
  {
    what: 'an unrelated website on the same line as a reply instruction: the price of a rule a CHECK can apply',
    text: 'You can opt out by replying. Our website is https://firm.example',
    refused: true,
  },
  {
    what: 'a same-line anchor, which approval refuses as markup anyway',
    text: '<a href="https://x.example/a">Unsubscribe</a>',
    refused: true,
  },
  {
    what: 'the same anchor with its label on another line',
    text: '<a href="https://x.example/a">\nUnsubscribe</a>',
    refused: true,
  },

  // ------------------------------------------------------- the rest of the phrase list
  { what: 'remove me above a link', text: 'Remove me from this list:\nwww.x.example/r', refused: true },
  { what: 'stop receiving under a link', text: 'https://x.example/s\nto stop receiving these', refused: true },
  { what: 'no longer receive', text: 'To no longer receive these, see https://x.example/n', refused: true },
  { what: 'a list-manage host', text: 'See https://firm.list-manage.com/u/1', refused: true },
  { what: 'manage your preferences', text: 'Manage your preferences at www.x.example/p', refused: true },
  { what: 'manage preferences without the your', text: 'Manage preferences: https://x.example/p', refused: true },
  { what: 'optout as one word', text: 'Optout here: https://x.example/o', refused: true },
  { what: 'a full-width space between the words', text: 'opt　out: https://x.example/a', refused: true },

  // ------------------------------------------------------------------ what still sends
  {
    what: 'a URL on the line above its label, which the same-line rule alone would miss',
    text: 'https://short.example/a\nUnsubscribe here.',
    refused: true,
  },
  {
    what: 'a phrase and a link two lines apart, which is neither a label nor next to one',
    text: 'To unsubscribe, just say so.\n\nhttps://firm.example',
    refused: false,
  },
  {
    what: 'the sentence the old word ban made unwritable',
    text: "just reply unsubscribe and I'll stop",
    refused: false,
  },
  {
    what: 'the word two lines away from a link, which is neither the label nor next to it',
    text: 'Reply unsubscribe and I will stop.\n\nSam Example\nOur work: https://firm.example',
    refused: false,
  },
  { what: 'an ordinary body with a sign-off', text: 'Hello.\n\nI work with property managers nearby.\n\nSam Example', refused: false },
  { what: 'a plain website mention', text: 'Our work is at https://firm.example, have a look.', refused: false },
  { what: 'the word with no link anywhere', text: 'Say the word unsubscribe and you are off the list.', refused: false },
  { what: 'an empty string', text: '', refused: false },
]);
