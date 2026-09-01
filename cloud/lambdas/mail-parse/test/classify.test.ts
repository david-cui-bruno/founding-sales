import { describe, expect, it } from "vitest";
import { classifyMail } from "../src/classify";

describe("classifyMail", () => {
  it("classifies zillow sender domains (including subdomains)", () => {
    expect(
      classifyMail({ fromAddress: "alerts@zillow.com", subject: "New rentals" }),
    ).toBe("zillow_frbo");
    expect(
      classifyMail({ fromAddress: "alerts@mail.zillow.com", subject: "New rentals" }),
    ).toBe("zillow_frbo");
  });

  it("classifies apartments.com", () => {
    expect(
      classifyMail({ fromAddress: "alerts@apartments.com", subject: "New listing" }),
    ).toBe("apartments_frbo");
  });

  it("classifies f5bot by sender or subject", () => {
    expect(
      classifyMail({ fromAddress: "noreply@f5bot.com", subject: "anything" }),
    ).toBe("f5bot");
    expect(
      classifyMail({ fromAddress: "fwd@example.com", subject: "F5Bot found something!" }),
    ).toBe("f5bot");
  });

  it("classifies in.usecallie.com senders as test", () => {
    expect(
      classifyMail({ fromAddress: "test@in.usecallie.com", subject: "hi" }),
    ).toBe("test");
  });

  it("honors the test-only override header ONLY for in.usecallie.com senders", () => {
    expect(
      classifyMail({
        fromAddress: "test@in.usecallie.com",
        subject: "F5Bot found something!",
        testClassifyHeader: "f5bot",
      }),
    ).toBe("f5bot");
    // External sender cannot spoof the override.
    expect(
      classifyMail({
        fromAddress: "evil@example.com",
        subject: "whatever",
        testClassifyHeader: "zillow_frbo",
      }),
    ).toBe("unknown");
    // Garbage override value falls back to test.
    expect(
      classifyMail({
        fromAddress: "test@in.usecallie.com",
        subject: "hi",
        testClassifyHeader: "not-a-classification",
      }),
    ).toBe("test");
  });

  it("classifies everything else as unknown", () => {
    expect(
      classifyMail({ fromAddress: "news@example.org", subject: "digest" }),
    ).toBe("unknown");
    expect(classifyMail({ fromAddress: null, subject: null })).toBe("unknown");
    // Similar but non-matching domains do not match.
    expect(
      classifyMail({ fromAddress: "a@notzillow.com", subject: "x" }),
    ).toBe("unknown");
  });
});
