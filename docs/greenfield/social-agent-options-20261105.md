# Dots and Muse: a founder's LinkedIn editorial assistant

Decision snapshot: 2026-11-05, based on public primary sources retrieved for this comparison. Scope: issue #935 under #783; editorial/operating assistance for Callie's college founder, not publishing activation. No account access, signup, connection, credentials, publishing, paid calls, infrastructure changes, or checks were performed. Actual account eligibility, subscriptions, connector inventories, and output quality remain unverified.

**Selected outcome:** David chose the existing custom editorial app/Bedrock plus Buffer Free for publication under [ADR0040](../adr/0040-buffer-managed-social-publication.md). No Dots/Muse trial, GPT Pro subscription or external editorial-agent dependency is required. The comparison below retains its sourced alternative analysis, not an outstanding route decision.

## Decision

**Use an agent as the research desk and editor, not as an assumed LinkedIn publisher.** Both products document ongoing work, web research, preferences/memory, and review controls. Dots explicitly demonstrates learning a creator's voice and drafting social posts; Muse documents content planning and learning a business's voice. Neither the reviewed official pages nor targeted official-domain searches established a **personal LinkedIn connector, personal-member write scope, or a supported unattended LinkedIn publishing contract**. That capability is **unknown**, not proven impossible. A cloud browser, custom connector, or agent subscription is not evidence of official LinkedIn write rights or a solution to the observed provider security denial. [Dots launch][Dots start][Muse design][Muse business]

**Recommendation [INFERENCE]:** if David already has eligible Dots access, trial that first because it can reuse existing ChatGPT context and has explicit creator-drafting documentation. Otherwise Muse's free allowance is a sensible editorial-only comparison if already available; do not buy a subscription merely to test the hypothesis. Keep publication on a separately evidenced supported publisher/approved existing route. This preserves the accepted standing goal of three personal LinkedIn posts/week without pretending the editorial trial establishes delivery capability. Neither agent was exercised here.

## 1. Current availability, price, and allowances

| Product | Documented position | What remains unverified |
| --- | --- | --- |
| Dots personal | Gradual rollout to Pro users aged 18+ outside the EEA, Switzerland, and UK. Business Premium is available in supported ChatGPT regions subject to workspace eligibility. Enterprise/Edu/Healthcare access has a November 4–18 admin preview; November 18 default availability unless admin opts out, with residency restrictions. One personal dot per member. [Dots start] | David's plan, region, workspace settings, and whether rollout reached his account. |
| Dots cost | Launch says first dot is included in eligible Pro/Business Premium with no extra cost, with an allowance for deeper work. Pro tiers are $100/$200/$500 USD per month. Business Premium is $125/user/month monthly or $100/user/month billed annually; Business requires at least two Standard/Premium seats total, not necessarily two Premium seats. [Dots launch][Pro tiers][Business] | Numeric Dots deeper-work allowance is not supplied by these reviewed sources; do not translate “24/7” into unlimited deep work. Launch's first-month extended limits are not a promise of an ongoing promotion. |
| Dots delegated work | Conversations with a dot do not count toward ChatGPT conversation limits; Codex or ChatGPT Work tasks it starts/manages count against those products' limits. Enterprise pricing/billing differs; its November 4–18 free preview should not be generalized to personal plans. [Dots launch][Dots start] | Actual remaining quota, task consumption, and any extra charges. Do not purchase credits or enable spending. |
| Muse | Official launch was US rollout; current business FAQ says US/Canada age 18+, and an October 27 official announcement identifies Singapore availability. Help warns region/account/feature availability varies. Web, iOS, Android are documented; current landing page also names Mac and WhatsApp. [Muse launch][Muse Singapore][Muse business][Muse home][Muse help] | These sources are not a comprehensive current country list. David's actual eligibility/access is unknown. |
| Muse cost | Free usage has a limit; wait for refresh or subscribe after reaching it. Official subscription help lists Power **$20/month, 500M Muse tokens/week** and Maximum **$100/month, 3B/week**; benefits vary by account/region and subscriptions auto-renew. [Muse subscriptions] | Numeric free allowance is not stated there. “Muse tokens” are not a guaranteed number of drafts or an apples-to-apples comparison with Dots. No paid plan or additional usage is authorized. |

Source hygiene: search results for `muse.ai/pricing` included a video-hosting product labelled Skiv. Those prices are **not** evidence of Meta Muse pricing; use Meta's subscription Help Center instead. Meta's own announcement links to muse.ai, establishing the product identity. [Muse launch][Muse subscriptions]

## 2. Capabilities versus a proposed workflow

All capabilities below are **vendor-documented**, not observations of this account or guarantees of editorial quality.

| Need | Dots | Meta Muse |
| --- | --- | --- |
| Public-source research | Protected cloud computer can browse, analyze, create files, and run tools. Explicit example: follow a developing story and prepare a newsletter draft. [Dots safety] | Full browser can search/navigate sites; agent can produce documents, PDFs, web pages, and artifacts. [Muse design] |
| Scheduled/background work | Reminders and recurring checks with editable schedules/notifications; work continues between conversations. Important distinction: **proactive research** is read-only on permitted connected sources and cannot itself control browser/computer, send, or change app content; authorized continuing tasks follow ordinary action rules. [Dots start][Dots privacy] | Works after app closes; scheduled/event-driven progress is documented. Recurring tasks can run daily, weekly, or custom intervals; they continue until canceled. [Muse design][Muse schedule] |
| Persistent voice/preferences | Starts with ChatGPT memory, learns from feedback, creator voice and audience, and carries edits across materials. Individual dot memories currently cannot be directly viewed/deleted/edited; do not mistake shared ChatGPT memory controls for dot-context editing. [Dots feature][Dots privacy] | Persistent conversational memory; memory files can be read/edited directly. Business page explicitly claims voice learning and content planning. These are not proof it already knows David's voice. [Muse design][Muse business] |
| App connections | OpenAI claims over 4,000 apps through plugins. Existing plugin connections and permissions are shared across ChatGPT, Work, Codex, and Dots; supported apps/actions vary. A read permission is not a write permission. [Dots launch][Dots privacy][Dots start] | Business page lists Notion, Granola, Canva, Slack, Dropbox, Figma, Asana, and others, plus Meta business accounts. Full available inventory is in account settings; custom connectors can be created but are not reviewed by Meta. [Muse business][Muse connectors] |
| Account/browser access | Separate cloud Chrome session, not automatically signed in when local browser is. Secure supported login flows hide passwords from model; user may need verification/takeover. Optional local computer access starts off. Docs explicitly say a blocked cloud site may remain unavailable even with a connected local computer. [Dots start][Dots privacy] | Dedicated persistent Secure VM and Chromium browser with credential store, audit trail and user takeover. Browser agent pauses during takeover/secure credential filling. No reviewed source proves successful LinkedIn login or exempts provider controls. [Muse security][Muse browser] |
| Human approval | Custom Rules allow/block/require approval; separate Auto-review checks consequential actions. Some bounded actions can be preapproved; core safeguards and handoffs cannot be overridden. Asking for a draft does not authorize sending. [Dots privacy][Dots start] | Permissions distinguish reads/writes and web defaults; action cards offer scoped approval. Platform connector guidelines require sensitive writes to ask **every use**, with no Always allow option. Do not infer all future publications qualify for standing approval. [Muse approvals][Muse platform] |

**Personal LinkedIn remains an evidence gap for both.** Reviewed Dots launch/feature/help and Muse launch/business/connector docs do not name a personal LinkedIn publishing integration. Official-domain searches for Dots LinkedIn plugins and Muse LinkedIn connectors did not establish one; absence from these results is not a complete app-catalog audit. A tool-building capability cannot create provider entitlement. Actual member identity, supported text/image writes, approvals, schedule semantics, post confirmation, and ambiguous-outcome/duplicate handling would all need route-specific evidence before relying on either for delivery. This does not reopen the already accepted browser permission or extrapolate self-service API limitations to a managed publishing partner.

## 3. Data, retention, and operational controls

- **Dots:** Business/Enterprise/Edu content is not used for training by default. On personal plans, “Improve the model for everyone” controls eligible conversations/work, including connected information incorporated into tasks. Proactive research/notes are not trained on directly, but information brought into an eligible task may be. Turning off training is not a promise that no authorized human safety review occurs. [Dots privacy]
- **Dots retention:** context can remain for the life of the dot; disconnecting an app stops future access but does not erase learned context. Deleting the dot starts context deletion, while separate conversations, files, Codex threads, and ChatGPT memories need their own management. Pausing is not deletion and separate delegated/scheduled tasks may continue. Use the current detailed FAQ rather than assuming the launch blog's broad “reset” wording provides selective memory deletion. [Dots privacy][Dots start]
- **Muse:** model-training setting is **on initially**; Data controls can turn it off, including for previous interactions and connector information. Conversations/VM data are not shared with Meta ad systems, but this is not a blanket “no cross-product use” guarantee: optional common Accounts Center can enable combining other information; browsing can also indirectly affect ads through third parties. [Muse privacy][Muse security]
- **Muse retention:** disconnecting a connector does not remove previous memories/history. Messages, side chats and VM files can be deleted; deleting source material may leave memory. Forget works “to the best of its ability”; a full reset deletes Muse data/active tasks. Neither reviewed policy establishes a universal numeric purge/backup-retention deadline. Memory files are inspectable/editable, unlike current Dots individual memories. [Muse privacy][Muse approvals]
- **Muse confidentiality:** current Secure VM isolation and credential separation are documented, but security docs say Meta can access data when necessary to operate/secure/support the service. **Confidential VM is described as future/tester functionality**, not a protection to assume for this account. [Muse security][Muse privacy]

**Suggested controls [INFERENCE]:** use only a deliberately public-safe briefing packet; do not connect Callie's customer research, inbox, internal analytics, prospect/customer identities, private recordings, or repository. Do not connect other accounts or grant local-machine access for an editorial trial. In particular, “redacted” research should be genuinely safe to disclose, not a raw transcript with only names removed.

## 4. Useful delegation ideas — proposals, not measured product results

1. **Story accountant:** keep a fact ledger linking each firsthand statement to one of the five genuine notes, each outside claim to a primary URL/date, and every unknown to a question. Convert one real event into alternative angles, never alternative invented events.
2. **Research-to-operator bridge:** weekly select two public research/news developments, explain the evidence and uncertainty, then propose one concrete Callie product decision to investigate. A proposed decision is not a claim that David already ran the experiment.
3. **Five-minute founder interview:** ask at most three specific questions that fill holes in a real note: decision, tradeoff, observed consequence. “Not enough facts yet” is an acceptable output; motivational filler is not.
4. **Anti-sameness editor:** compare candidate posts to the accepted three private drafts/guide4 calibration; flag repeated openings, forced lessons, recycled themes, and exaggerated claims. Keep a mix of personal/college-founder experience, research/news interpretation, and genuine PM decisions rather than turning everything into Callie promotion.
5. **Editorial operator:** prepare the week's three-post packet, label sources and uncertainties, track which drafts were accepted/rejected and why, and suggest replacements for stale news. This is scheduling the *editorial work*, not scheduling a LinkedIn publication.

These proposals fit documented research/drafting/memory/scheduling capabilities, but usefulness and consistency require a trial. They do not include automated comments, DMs, likes, engagement scraping, fabricated anecdotes, or autonomous public account activity. [Dots start][Dots feature][Muse design][Muse schedule]

## 5. Finite, no-account-action trial

**Proposed, not executed.** Start with one private editorial batch on an already accessible product, without upgrading, buying credits or adding connectors. Compare a second product only if already available and the first result warrants it. No signup or account settings changes were performed. This is not another week-long qualification gate or a request to repeat accepted calibration.

**Inputs:** the five genuine notes **only after a public-safe pass**; public-safe excerpts of the three accepted private drafts/guide4 as voice calibration (do not treat their private status as permission to upload); a short verified Callie/founder fact sheet; and three directly linked public primary sources selected for that week's research/news. If private calibration cannot be safely shared, use a short public-safe style checklist instead. Do not manufacture a founder note to fill a content slot.

**Boundary instruction:** “Act only as a private researcher/editor. Browse public sources; no account login, new connection, local-computer access, purchase, publishing, sending, commenting, liking or contacting anyone. No external state changes. Use supplied facts for my experiences. Cite researched facts and dates; distinguish evidence, analysis and unanswered questions. Return one private three-post packet and stop.”

**Outputs:** one genuine personal/PM draft, one research/news draft and one distinct operator/AI perspective, only where supported. Reuse the existing accepted voice guidance. Include primary sources and flag missing firsthand facts rather than inventing them. A later recurring editorial assignment can use documented scheduling; it is not needed to choose an editor from this first batch. [Dots start][Muse schedule]

**Decision evidence:** factual grounding, genuinely different angles, consistency with the accepted voice and how much rewriting the packet needs. No invented firsthand claims, metrics or quotes; no account actions or spend. These are practical comparison criteria, not a new approval ceremony. Stop at the existing allowance rather than paying to complete a trial.

**Decision after the batch:** useful writing justifies delegating the editorial loop; it does not establish personal LinkedIn writes, provider access or unattended delivery. A separately supported publisher owns those concerns. Any later scheduled task needs a defined scope and stop condition; pausing Dots alone may not stop separately delegated work. [Dots start][Muse schedule]

[Dots launch]: https://openai.com/index/introducing-dots/
[Dots feature]: https://chatgpt.com/features/dots/
[Dots start]: https://help.openai.com/en/articles/20001530-getting-started-with-your-dot
[Dots privacy]: https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs
[Dots safety]: https://openai.com/index/how-we-build-safety-security-and-privacy-into-dots/
[Pro tiers]: https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers
[Business]: https://help.openai.com/en/articles/8792828-chatgpt-business-overview
[Muse launch]: https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/
[Muse Singapore]: https://about.fb.com/news/2026/10/muse-is-now-available-in-singapore-the-worlds-first-personal-ai-agent-built-for-everyone/
[Muse home]: https://muse.ai/
[Muse help]: https://www.meta.com/help/superintelligence/1303670544995562/
[Muse business]: https://muse.ai/business
[Muse subscriptions]: https://www.meta.com/help/subscriptions/1021145227643680/
[Muse design]: https://muse.ai/blog/how-we-designed-muse
[Muse security]: https://muse.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse
[Muse privacy]: https://muse.ai/privacy
[Muse connectors]: https://www.meta.com/help/superintelligence/1687253048996149/
[Muse browser]: https://www.meta.com/help/superintelligence/2124746764949121/
[Muse schedule]: https://www.meta.com/help/superintelligence/1484325780075655/
[Muse approvals]: https://www.meta.com/help/superintelligence/1385290430137537/
[Muse platform]: https://platform.muse.ai/docs
