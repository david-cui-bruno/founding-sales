/**
 * Fixture MIME messages for each classification.
 *
 * NOTE: the Zillow / Apartments / F5Bot bodies are INVENTED, plausible
 * minimal markup based on the general shape of those alert emails. Replace
 * them with real-template fixtures (sanitized) once real alerts arrive —
 * the extractors are written defensively for exactly this reason.
 */

function mime(headers: Record<string, string>, body: string): Buffer {
  const head = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");
  return Buffer.from(`${head}\r\n\r\n${body}`, "utf8");
}

export const zillowAlertMime = mime(
  {
    From: "Zillow Rental Alerts <alerts@mail.zillow.com>",
    To: "alerts@in.usecallie.com",
    Subject: "New rentals by owner in Providence, RI",
    Date: "Mon, 31 Aug 2026 09:15:00 -0400",
    "MIME-Version": "1.0",
    "Content-Type": 'text/html; charset="utf-8"',
  },
  `<html><body>
  <h1>New rentals matching your search</h1>
  <table><tr><td>
    <a href="https://www.zillow.com/homedetails/123-Hope-St-Providence-RI-02906/12345678_zpid/?utm_source=email">
      <img src="https://photos.zillow.com/p/123.jpg" alt="listing photo" />
    </a>
    <div class="price">$2,400/mo</div>
    <div class="facts">3 bds | 1.5 ba | 1,450 sqft | Multi-family</div>
    <div class="address">123 Hope St, Providence, RI 02906</div>
    <div class="tag">Listed by property owner</div>
  </td></tr>
  <tr><td>
    <a href="https://www.zillow.com/homedetails/45-Benefit-St-Providence-RI-02904/87654321_zpid/?utm_source=email">
      <img src="https://photos.zillow.com/p/456.jpg" alt="listing photo" />
    </a>
    <div class="price">$1,850/mo</div>
    <div class="facts">2 bds | 1 ba | Apartment</div>
    <div class="address">45 Benefit St, Providence, RI 02904</div>
    <div class="tag">Listed by property owner</div>
  </td></tr></table>
  <p><a href="https://www.zillow.com/alerts/unsubscribe?id=abc">Unsubscribe</a></p>
  </body></html>`,
);

export const apartmentsAlertMime = mime(
  {
    From: "Apartments.com <alerts@apartments.com>",
    To: "alerts@in.usecallie.com",
    Subject: "New listing alert: Providence, RI",
    Date: "Mon, 31 Aug 2026 10:00:00 -0400",
    "MIME-Version": "1.0",
    "Content-Type": 'text/html; charset="utf-8"',
  },
  `<html><body>
  <div class="listing-card">
    <a href="https://www.apartments.com/88-broadway-providence-ri/xyz123/?src=email">88 Broadway</a>
    <span class="rent">$1,600</span>
    <span class="beds">2 Beds</span> <span class="baths">1 Bath</span>
    <div class="addr">88 Broadway, Providence, RI 02903</div>
    <div>Apartment for rent by owner</div>
  </div>
  <a href="https://www.apartments.com/customer/preferences">Manage preferences</a>
  </body></html>`,
);

export const f5botAlertMime = mime(
  {
    From: "F5Bot <noreply@f5bot.com>",
    To: "alerts@in.usecallie.com",
    Subject: "F5Bot found something!",
    Date: "Mon, 31 Aug 2026 11:30:00 -0400",
    "MIME-Version": "1.0",
    "Content-Type": 'text/plain; charset="utf-8"',
  },
  `Hello,

F5Bot here with the latest hits!

Keyword: "landlord software"
Reddit Post (r/Landlord): What software do you all use to manage a few units? My landlord is so unresponsive about the mold in my bathroom.
https://www.reddit.com/r/Landlord/comments/abc123/what_software_do_you_all_use/

Keyword: "property management"
Hacker News Comment: Ask HN: Best tools for small property management?
https://news.ycombinator.com/item?id=41234567

Thanks,
F5Bot
`,
);

export const testMailMime = mime(
  {
    From: "test@in.usecallie.com",
    To: "alerts@in.usecallie.com",
    Subject: "connectivity check",
    Date: "Mon, 31 Aug 2026 12:00:00 -0400",
    "MIME-Version": "1.0",
    "Content-Type": 'text/plain; charset="utf-8"',
  },
  "ping\n",
);

/** Test mail carrying the test-only classification override header. */
export const testOverrideF5botMime = mime(
  {
    From: "test@in.usecallie.com",
    To: "alerts@in.usecallie.com",
    Subject: "F5Bot found something!",
    Date: "Mon, 31 Aug 2026 12:30:00 -0400",
    "X-Callie-Test-Classify": "f5bot",
    "MIME-Version": "1.0",
    "Content-Type": 'text/plain; charset="utf-8"',
  },
  `Keyword: "landlord software"
Reddit Post (r/smallbusiness): Slow repairs and no heat all winter, need advice
https://www.reddit.com/r/smallbusiness/comments/test1/need_advice/
`,
);

export const unknownMailMime = mime(
  {
    From: "newsletter@example.org",
    To: "alerts@in.usecallie.com",
    Subject: "Weekly digest",
    Date: "Mon, 31 Aug 2026 13:00:00 -0400",
    "MIME-Version": "1.0",
    "Content-Type": 'text/plain; charset="utf-8"',
  },
  "Nothing relevant here.\n",
);
