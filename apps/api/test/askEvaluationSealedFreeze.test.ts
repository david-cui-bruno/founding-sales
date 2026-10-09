import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { createAuthFixture } from "./support/authFixture.ts";
import { destroyEvaluationFixture } from "./support/askEvaluationFixture.ts";
import { prepareEvaluationSuite } from "./support/askEvaluationSealedFixture.ts";
it("freezes disjoint real canonical development and sealed holdout bindings without evaluating holdout", async () => {
  const fixture = await createAuthFixture();
  try {
    const { receipt } = await prepareEvaluationSuite(fixture);
    expect(receipt.suite.caseBindings).toHaveLength(120);
    expect(receipt.holdoutRetrievalExecuted).toBe(false);
    expect(receipt.holdoutCandidateExecuted).toBe(false);
    expect(receipt.realCalls).toBe(0);
    expect(receipt.activationAllowed).toBe(false);
    if (process.env["ASK_EVALUATION_EXPORT_FREEZE"] === "1")
      await writeFile(
        new URL(
          "../../../.context/492-full-suite-preparation.json",
          import.meta.url,
        ),
        JSON.stringify(receipt, null, 2),
      );
  } finally {
    await destroyEvaluationFixture(fixture);
  }
}, 120000);
