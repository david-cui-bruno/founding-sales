/**
 * Inbound mail classification by sender domain and subject.
 */

export const CLASSIFICATIONS = [
  "zillow_frbo",
  "apartments_frbo",
  "f5bot",
  "test",
  "unknown",
] as const;

export type Classification = (typeof CLASSIFICATIONS)[number];

/** Domain we send test mail from. Also gates the test-classify override. */
const TEST_SENDER_DOMAIN = "in.usecallie.com";

/**
 * TEST-ONLY header: `X-Callie-Test-Classify: <classification>` forces the
 * classifier's output so live E2E tests can exercise any parse path with a
 * self-sent email. Honored ONLY when the sender domain is in.usecallie.com,
 * so external mail can never spoof a classification.
 */
export const TEST_CLASSIFY_HEADER = "x-callie-test-classify";

function senderDomain(fromAddress: string | null): string | null {
  if (!fromAddress) return null;
  const at = fromAddress.lastIndexOf("@");
  if (at < 0) return null;
  return fromAddress.slice(at + 1).trim().toLowerCase() || null;
}

function domainMatches(domain: string, root: string): boolean {
  return domain === root || domain.endsWith(`.${root}`);
}

export interface ClassifyInput {
  fromAddress: string | null;
  subject: string | null;
  /** Raw value of X-Callie-Test-Classify, if present. */
  testClassifyHeader?: string | null;
}

export function classifyMail(input: ClassifyInput): Classification {
  const domain = senderDomain(input.fromAddress);
  const subject = (input.subject ?? "").toLowerCase();

  if (domain && domainMatches(domain, TEST_SENDER_DOMAIN)) {
    const override = input.testClassifyHeader?.trim().toLowerCase();
    if (override && (CLASSIFICATIONS as readonly string[]).includes(override)) {
      return override as Classification;
    }
    return "test";
  }

  if (domain && domainMatches(domain, "zillow.com")) return "zillow_frbo";
  if (domain && domainMatches(domain, "apartments.com")) return "apartments_frbo";
  if (
    (domain && domainMatches(domain, "f5bot.com")) ||
    subject.includes("f5bot found something")
  ) {
    return "f5bot";
  }

  return "unknown";
}
