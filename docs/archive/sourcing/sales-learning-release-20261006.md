# Sales-learning release — 6 October 2026

Production runs `9ec7ba93ab6bd9201095d3e86e7eea96c65dffa2`, schema 51. API definition 93 has two tasks; worker definition 94 has one. Migration, runtime database read/write verification, release-record readback, drain removal and all six production smoke checks passed. Release record `ci-gate-37398306079-9ec7ba93ab6b` does not enable sending. Existing domain pause and automatic-admission settings were not changed.

Gate 37398306079, images 37398306312 and complete cloud rehearsal 37398723056 passed. Signed desktop **1.0.46**, build 37400378227, was size/SHA256 checked, published artifact first, then verified through CloudFront. Its SHA256 is `17ba35bdccee3b2ebbec4f6538790b8043abc1dd9b2d37e41eff819fed7aff72`.

The API's sending-enabled health field is the existing global runtime capability, not evidence that the domain pause was lifted. No live prospect cohort was enrolled or emailed. Email attribution completion remains part of E; actual qualification-to-held-demo yield needs real sales outcomes. Discovery provider-attempt readback remains a separate V1 check.
