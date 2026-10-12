# More tokens versus Gemini — actual diagnostic results

David authorized a synthetic comparison under a combined60-call/$10 ceiling and approved using existing project `colormyworld-prod-dc824`. The frozen diagnostic normalized the five previously reviewed contexts into identical supplied-data messages. It ran one final generation per case, with only `emit_answer` available: Sonnet4.6 at1,000 and4,096 output tokens, thinking disabled; Gemini3.8Flash through the Vertex US endpoint at4,096 tokens, LOW thinking and no thought summaries. No retrieval, worker publication, acquisition or activation was performed.

The first run completed ten Sonnet generations, then stopped on GeminiHTTP403 without retry. Read-only access checks showed the active Framewise account lacked prediction permission. The existing David Gmail account had prediction and service-use permissions. A fresh five-call Gemini-only scope used that existing account and an explicit quota-project header; no IAM, API-enablement, project or billing changes were made. The earlier403/allocation remains retained. Both scope/transport/budget reviews passed; funding hardening checks the preserved baseline and exclusively claims the campaign before dispatch.

| Arm | Completed candidates | Useful without material repair | Outcome |
| --- | --- | --- | --- |
| Sonnet4.6 /1,000 | 2/5 | 2/5 | Three output-limit truncations. Juniper and current Qualified state useful. |
| Sonnet4.6 /4,096 | 2/5 | 1/5 | Three output-limit truncations; Harbor useful with minor wording concerns; completed North answer has a dangling final clause. |
| Gemini3.8Flash /4,096 LOW | 5/5 | 5/5 | All five useful and substantively supported by supplied context; all select construction. |

Root and independent reviews inspected every candidate against original supplied evidence and expected/forbidden outcomes. Truncated results remain failures. Gemini preserved cancellation/no replacement date, anonymous conditional offer/next-week demonstration timing, unidentified pilot ambiguity, and SQL-owned new/qualified stages. Harbor is somewhat repetitive. Its source quotes, interpretation and opportunity-record selections use available handles/IDs. These are model selections, not observed host-rendered or published answers.

One completed Sonnet candidate selected source-quote construction; the other completed candidates used legacy prose. The4K North answer ended “This is for the opportunity:” despite normal tool-call termination, illustrating a presentation failure distinct from output cutoff. The larger ceiling did not improve completion count in this sample. This does not prove a universal model defect, constrained-decoder cause or impossibility of improvement with tokens.

Gemini returned122,226,164,118 and120 output tokens with zero reasoning tokens reported. Generation wall times were2,884ms,3,008ms,2,097ms,4,007ms and1,942ms. LOW is the requested policy, not a claim that thinking is disabled; zero reported thought tokens here does not generalize. These are generation latencies, not full product/polling/load latency. Both follow-up contexts lacked their prior question and supplied the current exact result; this is not session-continuity proof.

## Conserved budget and scope limits

The original run consumed11 slots/215c conservative allocation, including the failed403. The fresh Gemini child consumed5 slots/120c. Combined16 slots/335c, within60/$10; no allocation released and no automatic retries. Allocation is not an invoice. The project's billing and Vertex service were verified enabled; promotional-credit balance, restrictions and eligibility remain unverified. Actual usage, candidate/native records, scope/approval and ledger are retained privately under `.context/ask-provider-comparison-20261012/` and `.context/ask-gemini-access-repair-20261012/`.

Gemini's SDK converts provider grammar differently from Bedrock, and its thinking policy differs. Therefore this is a pragmatic configured-provider comparison, not a clean isolation of weights alone. The Sonnet1K/4K pair uses identical normalized context and protocol except ceiling; one stochastic run per case is not repeatability or representative quality. None of these candidates proves provider-neutral tool turns, thought-signature handling, canonical citation navigation, deletion/current-authority enforcement or ordinary worker usefulness.

## Next decision

Favor a narrow Vertex integration experiment through the existing AI SDK/registered-worker boundaries. Preserve host-executed tools, source/access/deletion controls, bounded accounting and current SQL facts. Add opaque thought-signature round trips and usage/endpoint handling appropriate to Gemini, then run the actual configured journey on the same cases under approved scope. No new retrieval framework or wholesale architecture change follows. Given Gemini's observed construction adoption, do not force a protocol rewrite merely to fix Sonnet's optional-path behavior before testing this simpler provider choice.

PR597's union correction merged as `2cbda374` after all required checks; source merge is not deployment or acceptance. #551 remains open. Provider switching in production, Gmail data, new credentials/privileges, rollout and activation require their applicable checks and consent. Sending safeguards and the release hold remain unchanged.
