# National DNC Registry — Seller Registration Checklist

Goal: get a Subscription Account Number (SAN), download the five free area codes we call into, and set up the 31-day re-scrub cycle. Total time: ~30 minutes.

## 1. Create the account (~10 min)

- [ ] Go to <https://telemarketing.donotcall.gov> and click **Create an account** (new users).
- [ ] Register as a **Seller** (we make calls to sell our own product; we are not a third-party telemarketer calling for others). You will provide: company legal name, EIN, address, and an authorized representative (founder).
- [ ] Designate the founder as the authorized representative and add a downloader/user login.
- [ ] Record credentials in the password manager.

## 2. Get the SAN and pick area codes (~10 min)

- [ ] Complete the subscription step. The **SAN (Subscription Account Number)** is issued when the subscription is processed. Keep it: any telemarketing vendor or dialer we ever use will ask for it.
- [ ] Subscriptions cover **up to 5 area codes free**. Beyond that: $82/area code/year now, rising to **$85/area code/year on October 1, 2026** (FY2027 fees, annual national cap $23,425). Subscriptions renew annually.
- [ ] Select these five free area codes:

| Area code | Coverage | Why |
|---|---|---|
| **401** | All of Rhode Island | Home market. The rental registry is RI-wide, so this is the bulk of the list. |
| **508 / 774** | Southeastern MA (New Bedford, Fall River, Worcester overlay) | Closest MA markets to RI, heavy multifamily stock, natural expansion ring. |
| **617 / 857** | Boston core (overlay pair) | Largest MA landlord concentration. Both codes cover the same territory, so scrubbing one without the other leaves gaps. |

- Skipped for now: 781/339 (Boston suburbs), 978/351 (northeast MA), 413 (western MA). Add them (paid, or on next renewal) only when the list actually contains numbers in those codes. Note that landlord cell phones can carry any area code, so scrub coverage should follow the numbers in the list, not geography alone. If more than ~10 area codes appear in the data, compare cost against a scrubbing service that bundles national DNC access.

## 3. Download and scrub (~10 min)

- [ ] Download the registry lists for the selected area codes (full change list first, then incremental daily/weekly change files).
- [ ] Scrub the calling list: remove or flag every number that appears on the registry **before** the first call.
- [ ] **31-day rule:** you may not call a number registered on the DNC registry for more than 31 days. Re-download and re-scrub at least **every 31 days**. Set a recurring calendar task for every 28 days to leave margin.
- [ ] Log each scrub date. Accessing the registry per its rules is a TSR safe-harbor element, so keep the evidence.

## 4. Merge with the internal DNC list

- [ ] Maintain our own **internal do-not-call (suppression) list**: anyone who says "don't call me" goes on it immediately and permanently. This is required regardless of the national registry, and it overrides everything (an internal DNC request beats any exemption, including an established business relationship).
- [ ] Scrub order at dial time: internal DNC list first, then national registry list. A number must pass both.
- [ ] Never delete internal DNC entries during the 12-month data retention purge. Suppression entries are permanent.
- [ ] Note: the FTC treats numbers of sole proprietors as registrable, so do not assume "it's a business number" exempts a landlord's cell from scrubbing. (Attorney question Q4 covers the B2B boundary.)

## 5. State-level requirements (RI / MA / CT)

- [ ] **RI:** No separate state DNC list — RI law (R.I. Gen. Laws § 5-61-3.5) keys off the federal registry, so the national scrub covers it. However, RI's Telephone Sales Solicitation Act (§ 5-61-3) requires telemarketers to **register with the RI Attorney General** ($100/yr, at least 10 days before doing business, form on riag.ri.gov) [VERIFY: whether a founder making own B2B calls needs this registration — attorney Q4].
- [ ] **MA:** Massachusetts operates its **own state DNC registry** (M.G.L. c. 159C, run by OCABR via vendor Fiserv). Telephone solicitors calling MA consumers must register annually with OCABR (201 CMR 12.04) and obtain the MA list separately from the federal one [VERIFY: current OCABR registration fee and whether pure B2B calls to landlords are exempt — attorney Q4].
- [ ] **CT:** Connecticut's "no sales solicitation calls" listing (Conn. Gen. Stat. § 42-288a) is **identical to the National DNC Registry**, so the federal scrub covers the list itself. CT also has telemarketer provisions in ch. 743m [VERIFY: whether CT requires separate telemarketer registration for founder-dialed B2B calls — attorney Q4].

## Done when

- SAN issued and stored
- 401, 508, 774, 617, 857 downloaded and first scrub complete
- 28-day recurring re-scrub task on calendar
- Internal DNC suppression list live in the CRM and checked at dial time
