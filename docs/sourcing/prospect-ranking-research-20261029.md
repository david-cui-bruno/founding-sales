# Prospect ranking, ICP and buying roles

Research for [#847](https://github.com/david-cui-bruno/founding-sales/issues/847), informing Step 1 / #797. Checked October 29, 2026. This note proposes a research approach; it changes no policy, scoring, qualification, activation or outreach. Email remains OFF. No provider account, paid service, tracking, prospect acquisition or contact was used.

## Newer prospecting tools: what they actually index on

There is no demonstrated universal “best” ranking formula in these sources. Official documentation establishes product mechanisms; vendor statements about improved conversion are not independent evidence that the method works for Callie.

| System | Documented approach | What this means for Callie |
| --- | --- | --- |
| **Gojiberry** | Defines ICP as company attributes, relevant roles and exclusions; signals supply timing through job/hiring changes, growth and engagement. Its lead-review guide combines ICP match and intent into **1–3 flames**: relevant, strong match and highest priority. It shows the triggering signal and lets users exclude leads/refine future targeting. [ICP/signals](https://help.gojiberry.ai/en/articles/16792315-what-is-an-icp-and-signal), [Lead review](https://help.gojiberry.ai/en/articles/15083495-how-to-review-and-qualify-your-first-leads-in-gojiberry) | Copy the visible reason and feedback loop. The reviewed guide does not publish weights, calibrated purchase probabilities or a controlled test of outcome learning. Its “qualified” label describes vendor filtering, not Callie's qualification or buying authority. |
| **Origami** (`origami.chat`) | Describes website/plain-language ICP setup, live multi-source research, buying-trigger filters, and Person selection by title/seniority/department. Its homepage organizes **plays** around a group of people with a specific reason to hear from the seller; example triggers include new locations, hiring, website interest and relevant public conversations. [Outbound product](https://origami.chat/products/outbound), [Homepage/play definition](https://origami.chat/) | Copy **why this Firm, why now, why this Person** as an inspectable research result. Website-inferred ICP is a hypothesis. The reviewed pages do not disclose ranking coefficients, a reproducible buyer-selection evaluation or outcome-model calibration. Speed, deliverability and sample UI are vendor claims, not observed Callie results. |
| **Unify** | A play combines a trigger/audience, ICP filtering, persona prospecting, research and branching actions. Play metrics and A/B splits support comparing approaches. [Play documentation](https://support.unifygtm.com/articles/3322349425-getting-started-with-plays-features-and-tips) | Evaluate a specific event/person/action combination. A useful play supplies a reason to act, not a universal “hot lead” label. |
| **Common Room** | Buying-committee suggestions use a department/seniority matrix and connected activity/prospecting data; Engaged/Warm status adds relationship context. Its AI-scoring product describes person-level weighted activities rolled up to firms. [Committee](https://www.commonroom.io/docs/using-common-room/buying-committee/), [Scoring](https://www.commonroom.io/product/ai-scoring/) | Map role coverage and engagement. The committee tool explicitly is not an organization chart; a suggested role or active person is not proven authority. |
| **Pocus** | Scores support weights/category caps, AI-assisted setup and explanations. Inputs normalize within peer groups; dates decay, and grades compare the raw score with the highest peer score. Records outside peer groups can remain unscored. [Scores](https://docs.pocus.com/docs/scores), [Calculation](https://docs.pocus.com/docs/score-calculation-deep-dive) | Compare like firms and expose reasons. A high grade is relative priority, not a calibrated probability of winning; unscored is not demonstrated poor fit. |
| **Attio** | Flexible CRM context and agent/workflow capabilities support research and operator-defined ICP scoring. [Ask Attio](https://attio.com/help/reference/attio-ai/ask-attio/chat-with-ask-attio), [Revenue agents](https://attio.com/blog/orchestrate-revenue-agents) | Separate the relationship/record/workflow layer from signal acquisition and learned buyer prediction. Automating an ICP judgment does not validate that ICP or manufacture intent evidence. |

The useful shift is from static list filters to **event → relevant Firm → appropriate Person → contextual next action**, with explicit reasons. It does not make every observed event purchasing intent. A commenter on a competitor's post could be a vendor, employee or job seeker. Check the comment's actual meaning and the Person's role before calling it a buying signal.

Gojiberry also documents that source activity and mandatory profile keywords constrain discovery: quiet pages yield fewer opportunities, and missing required words can exclude otherwise suitable people. Its website-visitor feature requires a tracking script and paid access; contacts selected at a visiting company may **not** be the actual visitor. [Coverage constraints](https://help.gojiberry.ai/en/articles/14170452-why-am-i-not-getting-enough-leads), [Visitor mechanism](https://help.gojiberry.ai/en/articles/17359579-how-website-visitors-works)

For Callie, relying on public social activity could under-sample local operators who are less active online. That is a coverage hypothesis to measure, not proof that older/offline buyers are worse. SaaS-oriented triggers such as funding and job hopping may transfer poorly; product-usage scoring requires actual instrumented product use. Combining business websites, permitted current role evidence, operational events and eventual customer conversations may cover different populations. These recommendations install no tracking and authorize no acquisition or outreach.

## Mature systems for comparison

| System | Documented inputs and method | Lesson and limit |
| --- | --- | --- |
| HubSpot | Separate contact/company **fit** properties and **engagement** events; combined scores retain both components. Users configure points/group caps; engagement events can decay. AI scoring derives criteria from labeled conversions. | Keep “looks suitable” separate from “engaged recently.” Their configurable points are choices, not validated conversion probabilities. [Documentation](https://knowledge.hubspot.com/scoring/understand-the-lead-scoring-tool) |
| Salesforce | Account Engagement separates explicit profile **grade** from behavioral **score**. Einstein Lead Scoring learns similarities to previously converted leads, normalizes titles into rank/department and exposes influential fields. | Learn whose role and firm attributes actually associate with progress, while preserving the meaning of “conversion.” It is not inherently a paid-retained-customer predictor. [Grading](https://trailhead.salesforce.com/content/learn/modules/lead-scoring-and-grading-in-account-engagement/get-started-with-lead-grading), [Einstein](https://help.salesforce.com/s/articleView?id=sf.einstein_sales_lead_insights.htm&language=en_US&type=5) |
| 6sense | Firmographic/technographic fit is trained against relevant historical wins; a separate contact model uses job function/level/role and historical opportunity participation. Buying stages interpret recent research/engagement to estimate opportunity opening/progression over 90 days. | Evaluate the Firm, the Person and timing separately. A profile resembling past wins is not evidence the firm is buying now. [Firm model](https://support.6sense.com/account-profile-fit-model), [Person model](https://support.6sense.com/docs/contact-profile-fit-model), [Buying stages](https://support.6sense.com/docs/predictive-buying-stages) |

These approaches share a structure, not common weights: firm fit, role fit, timing/engagement and relationship/access context. Some learn from outcomes; others automate an operator's hypotheses.

The current [qualification ranking](../../packages/domain/sourcing/qualificationPolicy.ts) orders help requests, operational burden, investigation and general fit; its later tie-breakers include corroboration, recency and a boolean named-contact flag. That does not evaluate the Person's actual buying role. The separate current prepared-research path already permits fit without asserting maintenance need; preserve its distinction from legacy admission and outreach authority. This research does not propose rewriting frozen interpretations in place.

## Agreed prioritization direction

David agreed with the learning approach and clarified that ranking should preserve broad prospect coverage. Public buying-signal scarcity for the current ICP is a working hypothesis, not a measured result.

- Keep plausible prospects available; ranking determines order, not silent rejection.
- Missing online activity or intent stays unknown. Positive evidence can raise priority; missing evidence alone does not establish poor fit.
- Give ordinary and uncertain prospects regular consideration, with queue aging to avoid indefinite starvation. Waiting longer does not establish stronger buying intent.
- Missing Person or Route evidence creates research work. Genuine wrong-fit evidence, stops and source/access/execution gates remain separate from commercial priority.
- Learn from appropriate-Person conversations and customer outcomes. This direction sets no weights, validates no ICP and authorizes no contact, higher volume or activation.

## What “data driven” can mean for Callie now

Callie's product direction is an end-to-end AI property manager. Evaluate the workflows actually supportable today and the promised customer outcome; do not silently reduce the ICP to firms that publicly ask for maintenance help. Conversely, future product ambition does not prove current integration, autonomy or onboarding capability.

The unit to prioritize should be **Firm + Person/buying role + next action**. A large firm without an accessible relevant person may deserve more research rather than the next conversation slot. A smaller firm with a responsible operator, clear authority and a feasible paid adoption path may offer faster revenue and learning. This is a proposed decision model, not an established Callie result.

A candidate play to test: **a documented portfolio acquisition → the current operations owner → a question about consolidating tenant/vendor handoffs**. The event, role association and proposed relevance each need evidence. Existing staff/24-hour coverage alone is a value hypothesis, not a new trigger event.

Keep six visible dimensions rather than inventing a weighted 100-point score:

1. **Fit:** residential management model, supported workflow, service geography and deployment feasibility. Preserve genuine disqualifiers; leave missing facts unknown.
2. **Potential value:** recurring tenant interactions, staffing expenditure, cross-team/vendor handoffs, after-hours work and portfolio complexity. Unit count alone does not measure obtainable value.
3. **Change/timing:** an actual initiative, relevant current hiring, expansion, acquisition, service redesign, contract renewal or a direct statement about evaluating alternatives. Record the event date separately from its discovery date.
4. **Buying role:** responsibility for the workflow, influence over a trial, budget authority, implementation approval and access to others involved. A title supplies a hypothesis; direct confirmation supplies stronger evidence.
5. **Adoption feasibility:** willingness to change, ability to supply required inputs, incumbent/central-office restrictions and a realistic path to demonstrating value. Treat these as discovery questions until established.
6. **Evidence and access:** exact source/date, confidence, missing fields and an appropriate current business Route. Reachability and lawful execution are independent gates, not measures of product fit.

**Nexus example:** an in-house maintenance department and 24/7 service suggest recurring operational work and a possible internal user/champion. That supports a value/complexity hypothesis and is not an automatic penalty. It does not establish budget, dissatisfaction, workflow volume, local purchasing autonomy or current intent. A response/emergency number is a Route-selection question, not a firm-priority deduction.

AppFolio's survey of 1,617 U.S. residential property-management professionals illustrates why simplistic staffing assumptions fail: AI adopters reported more planned hiring, and 45% of respondents planned technology consolidation. These are observational, vendor-reported market findings—not causation or a label for Nexus. Consolidation could support interest in an integrated product or resistance to another separate tool. [2026 report announcement and methodology](https://www.appfolio.com/newsroom/property-manager-benchmark-survey-2026)

## Buying signals: evidence strength before point values

| Observation | Initial interpretation | What remains unknown |
| --- | --- | --- |
| Relevant decision participant requests a demo, explains a project or asks to evaluate a paid deployment | Direct engagement and a concrete next action | Purchase authority, feasibility, success criteria and actual commitment |
| Known successful user/champion moves to a suitable firm | Relationship plus possible timing | New responsibilities, influence and appetite to repeat the prior purchase |
| Dated expansion, relevant operations hire or workflow/technology initiative | Plausible change trigger | Whether it creates demand for Callie and who owns the decision |
| Staff/team, many units, 24/7 service | Possible workload/value | Actual interaction volume, cost, process quality and buying interest |
| Generic claims, an undated job page, isolated content engagement or a vendor's company intent score | Weak/context-dependent clue | Recency, actual participant, underlying purpose and whether anything is being purchased |

This ordering is a hypothesis. Keep source reliability separate from commercial relevance: an authentic job posting can still be a weak predictor of buying. Repeated copies of one announcement are one signal. Age timing evidence; do not pretend an old announcement remains a current initiative. Unknown intent should remain unknown rather than become negative intent. None of this requires introducing tracking or buying an intent subscription.

## Finding the right Person

Salesforce's buying-role framework distinguishes budget approval, users, technical evaluators and an internal advocate. One Person can perform multiple roles in a small firm. [Role definitions](https://www.salesforce.com/sales/strategic-selling/)

For Callie, test these role hypotheses:

- **Owner/principal or general manager:** possible budget and operating-model authority, particularly in a smaller independent firm.
- **Head/director of operations or property management:** possible workflow owner and implementation sponsor.
- **Maintenance/service leader or coordinator:** possible expert user and champion; responsibility for daily work does not automatically imply purchasing authority.
- **IT/security, finance or central/franchise office:** possible approval or implementation roles where present; do not invent a committee or assume local autonomy.

Record the specific question this Person can resolve and the evidence of their current association. Ask who approves a deployment and who must help operate it. Do not assume the highest-ranking title is the best initial conversation. LinkedIn's own guidance combines company, function/seniority, timing and relationship paths. Apollo explicitly warns that company intent does not identify the individual researcher. [LinkedIn guidance](https://business.linkedin.com/sell/sales-navigator/how-to-prospect), [Apollo intent](https://knowledge.apollo.io/hc/en-us/articles/8047704465933-Buying-Intent-Overview). Missing a named individual should trigger appropriate research—not fabricated identity or use of a tenant/emergency line.

## Learn the ICP instead of declaring one

An initial ICP is a set of competing hypotheses. For example, compare owner-led independent managers, growing regional firms with dedicated operations staff, and established multi-office/franchise operations. These are proposed operational cohorts, not validated size cutoffs or reasons to exclude one group in advance. Keep firm size, property mix, staffing model, incumbent tools and buying-role access visible; avoid changing every dimension at once.

Cold-start limitation matters. Salesforce supports an unsegmented global-model fallback when organization-specific conversion history is insufficient. HubSpot AI scoring analyzes lifecycle-stage transitions to suggest criteria. Neither mechanism establishes a useful Callie model or ICP; filtering feedback and generating an ICP from a website also do not validate paid-customer prediction. [Salesforce requirements](https://help.salesforce.com/s/articleView?id=sf.einstein_sales_els_setup_considerations.htm&language=en_US&type=5), [HubSpot AI scoring](https://knowledge.hubspot.com/scoring/build-lead-scores-with-ai)

Proposed bounded next experiment, requiring ordinary future scope/contact approvals:

1. Agree on the current customer outcome and feasible initial deployment. Choose a few operational cohorts and comparable research effort per Firm. Define a useful conversation before examining results.
2. Review an initial small set, such as 20–30 Firms across cohorts, using permitted existing evidence. Log pre-contact hypotheses and missing facts; do not purchase enrichment or contact anyone through this proposal.
3. For later authorized outreach, reserve some capacity for suitable but uncertain Firms selected independently of the current rank. Log selection reason and channel/effort so the model does not only learn from its favorites.
4. Preserve a funnel: attempted contact → reached appropriate Person → substantive workflow conversation → buyer/sponsor involved → agreed next step → paid adoption → continued use/value. Record explicit rejection reasons and time/cost. No answer is not demonstrated non-fit; pending deals are not losses.
5. Compare conversation yield per selected Firm and qualified conversation, paid adoption, retention and delivery effort by cohort/role. Show counts, denominators, observation windows and uncertainty. Twenty conversations cannot validate a complex model.
6. Update hypotheses between batches. Freeze features as known at selection; later meeting notes must not leak into a model claiming to predict that meeting. Keep a later time period for evaluation once enough outcomes exist.

6sense's own model-insights reports evaluate opportunity conversion and lift against a baseline, including a 90-day look-forward from previously scored Firms. That is a useful evaluation pattern; it does not prove that their lift estimate removes selection or sales-effort bias. [Model insights](https://support.6sense.com/docs/predictive-model-insights-report)

The [agreed product requirements](../greenfield/prospect-prioritization.md) and issue848 now own the planned implementation/acceptance; this note retains research rationale. The deliverable is an explainable priority/review workflow and learning protocol, refined with actual outcomes. No numeric weights, model accuracy, buyer identities or activation approvals have been established by this research.
