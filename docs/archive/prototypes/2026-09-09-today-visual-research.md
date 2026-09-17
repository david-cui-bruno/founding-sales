# Today: compact structure and typography research

Research date: September 9, 2026. This is a visual research note, not an approved replacement layout or production implementation plan.

## Recommendation

Keep the compact conversation queue. Give the selected conversation a distinct work surface, reduce competing text, and use a small, consistent proportional-sans type hierarchy. Test three genuinely different arrangements before choosing a style.

The most useful combination is **Things' grouping, Linear's surface hierarchy, and Attio's identity/action organization**. Superhuman provides a useful explanation of depth in dark mode. None of these products should be copied wholesale.

## What is actually wrong with the current mockup?

Source inspected: `2026-09-09-meeting-first-today.html` at `cd43ce2`.

- The queue and detail share the same `#fffcf5` surface. A thin divider carries almost the entire burden of separating them.
- The shadow is around the whole app, not the active work surface. Increasing that shadow would not make the inside easier to understand.
- Body text is system sans-serif, with Futura/Avenir-style display headings. It is **not monospace**. The 10px uppercase labels with wide letter spacing contribute to the technical, label-heavy impression.
- The call brief gives several text blocks similar emphasis. The person, reason, useful opening question, supporting facts and history do not form a strong enough reading order.
- There is already a compact queue and a persistent action area. Those are useful constraints to preserve, not reasons to shrink text further.

This is my diagnosis from the source and rendered prototype, not a claim established by a usability study. The user's feedback is the direct evidence that the current result feels insufficiently structured.

## The strongest inspirations

### 1. Linear: make the work surface distinct, not every element boxed

**Primary source:** [A calmer interface for a product in motion](https://linear.app/now/behind-the-latest-design-refresh), Charlie Aufmann and Maxime Heckel, March 12, 2026.

**What the designers say:** Navigation should have less visual weight than content. The refresh uses more compact desktop tabs, quieter inactive elements, fewer unnecessary icon backgrounds and fewer excessive dividers. Different surfaces have different roles.

**What I inspected visually:** The official comparison shows dark surfaces distinguished by tonal steps and soft edges, with selectively contained controls. It does not support adding thick borders or large shadows to every row. The separate blueprint-style hero is an explanatory illustration, not evidence of Linear's actual interface typography.

**Borrow:** Quieter navigation, a clearly bounded active panel, restrained rounding and a deliberate selected state.

**Do not borrow:** An issue-tracker's density of controls, developer-oriented labels, or every decorative treatment in a marketing illustration.

[Official surface comparison image](https://webassets.linear.app/images/ornj730p/production/36869cc79ec19741d75a35dd2beadf5d9d58e2c8-2352x1600.png)

### 2. Attio: put the person and their actions together

**Primary source:** [Record page redesign](https://attio.com/changelog/2026/record-page-redesign), 2026. The retrieved page did not show an exact publication day.

**What the designers say:** Identity and key actions move together to the top left. The details panel is resizable. Compact Lists-summary entries are smaller and read-only, while standard entries are larger and editable. Automation events collapse by default. Full attribute information is available on demand.

**What I inspected visually:** The official image has a compact identity/action cluster, aligned key/value properties, a thin pane divider, and lightly outlined meeting/task containers. Headings and a small number of accents organize activity. Heavy shadows are not the main organizing device.

**Borrow:** A compact identity strip, meaningful grouped facts and a clearly contained meeting or message object.

**Do not borrow:** The full CRM property wall or many tabs. Do not turn the available CRM attributes into a prerequisite checklist before calling.

[Official record-layout image](https://a.storyblok.com/f/234930/7680x4320/68fc5a1cc0/new-record-layout.png)

### 3. Things 3: short groups, plain labels, optional detail

**Primary source:** [What's New](https://culturedcode.com/things/features/), no publication date shown. The page identifies the core design as Things 3.0 and also describes later additions. The cited screenshot is a historical asset, not a claim about a newly released 2026 screen.

**What the designers say:** Headings divide work into named groups. Calendar events and later tasks form distinct sections. An expanded task becomes a clear sheet, with optional fields tucked away until needed.

**What I inspected visually:** The official Mac headings image uses sentence-case colored headings, aligned rows, light rules and more space between groups than within them. It demonstrates grouping, not a reason to make our queue taller or copy its exact spacing.

**Borrow:** Clear section names and a small amount of strong grouping instead of many tiny explanatory labels.

**Do not borrow:** Checkboxes for people, task-completion semantics for a phone handoff, or hiding the persistent conversation queue.

[Official Mac headings image](https://static.culturedcode.com/things/videos/2017-05-18-website-videos/4-headings-mac.png)

### 4. Superhuman: depth and one obvious next action

**Primary sources:** [How to design delightful dark themes](https://blog.superhuman.com/how-to-design-delightful-dark-themes/), Teresa Man, October 10, 2019; [How to build a remarkable command palette](https://blog.superhuman.com/how-to-build-a-remarkable-command-palette/), Tim Boucher, October 12, 2021; and [The 3 design principles for creating flow](https://blog.superhuman.com/how-to-design-for-flow/), Rahul Vohra, June 24, 2021.

**What the designers say:** Nearer dark surfaces are lighter and distant ones darker. Contrast needs individual adjustment rather than a mechanical inversion. Their command palette deliberately uses monospace to evoke operating a powerful machine, while ordinary visible controls remain available.

**Borrow:** A few purposeful surface levels and a clear primary action. In dark mode, use tonal separation and a subtle edge as well as shadow.

**Do not borrow:** All five of their gray levels, exact contextual opacity values, or the terminal-like tone for ordinary conversation content. Their published reading-flow approach can hide the inbox, which is not a precedent for removing our persistent left queue.

The typography and depth recommendations above are based on the authors' explanations. I did not make a separate pixel-level inspection of a Superhuman screenshot in this pass.

## What the broader guidance supports

- **Group by meaning.** Nielsen Norman Group's [Common Region](https://www.nngroup.com/articles/common-region/) article, Aurora Harley, July 12, 2020, explains why a shared boundary or background makes elements read as related. It also warns that excessive decorative containment creates clutter. Use a boundary around a coherent brief or message, not every paragraph.
- **Make headings useful, not ornamental.** [The Layer-Cake Pattern of Scanning](https://www.nngroup.com/articles/layer-cake-pattern-scanning/), Kara Pernice, August 4, 2019, supports distinct descriptive headings, logical chunking and removal of superfluous content. It does not establish a particular FSS layout as optimal.
- **Compact is not the same as tiny.** [Apple's typography guidance](https://developer.apple.com/design/human-interface-guidelines/typography) recommends a hierarchy of size, weight and color, and minimizing typefaces. I read the official structured documentation content as well as its landing page. The listed macOS point sizes are not automatically interchangeable with CSS pixels.
- **Use elevation to express hierarchy.** [Fluent 2 elevation](https://fluent2.microsoft.design/elevation) distinguishes subtle elevation for persistent surfaces from stronger elevation for transient dialogs. For us, a thin keyline plus a low shadow on one foreground panel is a reasonable experiment, not a requirement to shadow every row.
- **No need for glass everywhere.** [Apple's materials guidance](https://developer.apple.com/design/human-interface-guidelines/materials) distinguishes functional controls/navigation from content and explicitly advises against Liquid Glass in the content layer. This supports restraint, not a glassmorphism redesign.

These are design principles and precedents. They are not evidence that a style will improve sales, and they do not replace the user's visual judgment.

## Three proposed compact studies

All three would keep the same fictional people, calls/approvals/meetings, compact list density, primary actions and safety states. They would be layout studies, not different feature sets or merely light/dark color presets.

| Direction | Actual structural difference | Typography | Main trade-off |
| --- | --- | --- | --- |
| **A. Native Desk, recommended** | Quiet tinted queue beside one inset foreground brief. Identity header, grouped content and action footer belong to the same softly edged sheet. Low elevation separates work from navigation. | System UI sans, sentence-case labels, semibold names. | Clearest starting hypothesis, but needs restrained Callie branding to avoid becoming generic. |
| **B. Structured Index** | Crisper grid with two or three explicit section bands, aligned fact rows and a mostly flat list. Organization comes from alignment and section boundaries rather than a floating sheet. | Clean sans throughout, stronger weights, no spaced uppercase micro-labels. | Best contrast study for stronger structure. Too many rules would recreate the clutter the research warns against. |
| **C. Warm Brief** | Compact list beside a contained paper-like conversation brief. One prominent opening question, a short context block and a small facts strip. Softer depth with fewer exposed metadata labels. | Humanist sans UI. A restrained serif opening-question treatment can be tested as an optional contrast, not imposed on the whole app. | More human and distinctive, but must not become an oversized editorial page. |

### Shared content hierarchy

For a call, make the first scan answer four questions:

1. **Who?** Person, company and role in a compact identity group.
2. **Why now?** One short explanation, with any promise or timing constraint visible.
3. **What should I ask?** One useful opening question with the strongest content emphasis.
4. **What happens next?** The call action and its truthful state, with key facts nearby and evidence/history on demand.

For an email, the requested context and exact editable message remain visible. For a meeting, time, event/acceptance status and purpose remain visible. Do not achieve simplicity by hiding stale-context warnings, consent/eligibility holds, approval-versus-delivery distinctions or missing information.

### Typography starting point

Use proportional sans-serif for navigation, names, metadata, editable messages and buttons. Try approximately 13–14px list text and 14–15px brief text at the existing desktop widths, then judge the rendered result. These are proposed starting values, not measurements from the reference products. Reserve monospace, if any, for short keyboard hints or technical identifiers. Times and counts can align with tabular numerals without making the whole UI monospaced.

## Proposed next step and evaluation

After approval of these directions, make one switchable standalone comparison with A/B/C using the same selected person and content. Preserve the current prototype as the baseline. No production renderer work is authorized by this research note.

Evaluate each at 1440px and 1050px in light and dark mode:

- Can the user immediately distinguish navigation, queue and active work?
- Can they identify the person, reason and next action without reading every sentence?
- Are all three queue groups still discoverable at compact density?
- Are body text and secondary metadata readable without reliance on low contrast or 10px labels?
- Does keyboard selection preserve focus? Do edits and scroll positions survive switching styles?
- Are primary actions accessible and statuses truthful in normal, stale, offline and manually reported states?

Automation can check overflow, focus, persistence and accessibility basics. The user decides which composition feels compact, structured and pleasant.

## Research scope and limits

Two independent research passes covered workspace/CRM references and calm desktop/reading references. Primary pages were read, and the Linear, Attio and Things images linked above were downloaded from their official hosts and inspected. Notion Mail was considered but is a weaker fit for this focused desk than its configurable inbox/document concepts suggest.

The public search service began returning a challenge, so research continued through direct official pages and their linked assets. No challenge bypass, login, product installation or account connection occurred. No user records were used. The existing prototype and production source were left unchanged. The images remain references, not licensed assets for redistribution inside the product.
