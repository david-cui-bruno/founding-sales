import { describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";
import {
  extractF5BotHits,
  extractFrboListings,
  matchPainMentions,
  normalizeListingUrl,
  platformFromUrl,
  stripTags,
} from "../src/extract";
import { f5botAlertMime, zillowAlertMime, apartmentsAlertMime } from "./fixtures";

describe("extractFrboListings", () => {
  it("extracts both listings from the Zillow fixture", async () => {
    const mail = await simpleParser(zillowAlertMime);
    const html = typeof mail.html === "string" ? mail.html : null;
    const listings = extractFrboListings("zillow_frbo", html, mail.text ?? null);

    expect(listings).toHaveLength(2);

    const first = listings[0]!;
    expect(first.listing_url).toBe(
      "https://www.zillow.com/homedetails/123-Hope-St-Providence-RI-02906/12345678_zpid/",
    );
    expect(first.rent_usd).toBe(2400);
    expect(first.beds).toBe(3);
    expect(first.baths).toBe(1.5);
    expect(first.property_kind).toBe("multi_family");
    expect(first.address).toEqual({
      line1: "123 Hope St",
      locality: "Providence",
      region: "RI",
      postal_code: "02906",
    });

    const second = listings[1]!;
    expect(second.rent_usd).toBe(1850);
    expect(second.beds).toBe(2);
    expect(second.baths).toBe(1);
    expect(second.address?.postal_code).toBe("02904");
  });

  it("extracts the Apartments.com fixture and skips footer links", async () => {
    const mail = await simpleParser(apartmentsAlertMime);
    const html = typeof mail.html === "string" ? mail.html : null;
    const listings = extractFrboListings("apartments_frbo", html, mail.text ?? null);

    expect(listings).toHaveLength(1);
    const listing = listings[0]!;
    expect(listing.listing_url).toBe(
      "https://www.apartments.com/88-broadway-providence-ri/xyz123/",
    );
    expect(listing.rent_usd).toBe(1600);
    expect(listing.beds).toBe(2);
    expect(listing.baths).toBe(1);
    expect(listing.address?.line1).toBe("88 Broadway");
  });

  it("handles missing fields gracefully (template drift)", () => {
    const html = `<a href="https://www.zillow.com/homedetails/mystery/999_zpid/">See home</a>`;
    const listings = extractFrboListings("zillow_frbo", html, null);
    expect(listings).toHaveLength(1);
    const listing = listings[0]!;
    expect(listing.rent_usd).toBeNull();
    expect(listing.beds).toBeNull();
    expect(listing.baths).toBeNull();
    expect(listing.address).toBeNull();
    expect(listing.property_kind).toBe("other");
  });

  it("returns [] for empty bodies", () => {
    expect(extractFrboListings("zillow_frbo", null, null)).toEqual([]);
  });
});

describe("extractF5BotHits", () => {
  it("extracts keyword, url, platform, title from the fixture", async () => {
    const mail = await simpleParser(f5botAlertMime);
    const hits = extractF5BotHits(mail.text ?? null);

    expect(hits).toHaveLength(2);

    const reddit = hits[0]!;
    expect(reddit.keyword).toBe("landlord software");
    expect(reddit.platform).toBe("reddit");
    expect(reddit.post_url).toBe(
      "https://www.reddit.com/r/Landlord/comments/abc123/what_software_do_you_all_use/",
    );
    expect(reddit.title).toContain("What software");

    const hn = hits[1]!;
    expect(hn.keyword).toBe("property management");
    expect(hn.platform).toBe("hackernews");
    expect(hn.post_url).toBe("https://news.ycombinator.com/item?id=41234567");
  });

  it("skips URLs with no preceding keyword", () => {
    const hits = extractF5BotHits("https://www.reddit.com/r/x/comments/1/t/\n");
    expect(hits).toEqual([]);
  });

  it("returns [] for null/empty", () => {
    expect(extractF5BotHits(null)).toEqual([]);
    expect(extractF5BotHits("")).toEqual([]);
  });
});

describe("platformFromUrl", () => {
  it("detects reddit, hackernews, other", () => {
    expect(platformFromUrl("https://www.reddit.com/r/x/")).toBe("reddit");
    expect(platformFromUrl("https://old.reddit.com/r/x/")).toBe("reddit");
    expect(platformFromUrl("https://news.ycombinator.com/item?id=1")).toBe("hackernews");
    expect(platformFromUrl("https://lobste.rs/s/abc")).toBe("other");
    expect(platformFromUrl("not a url")).toBe("other");
  });
});

describe("matchPainMentions", () => {
  it("matches pain enum values from titles", () => {
    expect(matchPainMentions("My landlord is so unresponsive about the mold")).toEqual([
      "unresponsive",
      "mold",
    ]);
    expect(matchPainMentions("No heat all winter and slow repairs")).toEqual([
      "no_heat",
      "slow_repair",
    ]);
    expect(matchPainMentions("Mice and roaches everywhere")).toEqual(["pests"]);
    expect(matchPainMentions("Leaky pipe under the sink")).toEqual(["plumbing"]);
    expect(matchPainMentions("Breaker keeps tripping")).toEqual(["electrical"]);
    expect(matchPainMentions("Best neighborhoods in Providence?")).toEqual([]);
  });
});

describe("helpers", () => {
  it("normalizeListingUrl strips tracking params", () => {
    expect(
      normalizeListingUrl("https://www.zillow.com/homedetails/1_zpid/?utm_source=email#top"),
    ).toBe("https://www.zillow.com/homedetails/1_zpid/");
  });

  it("stripTags flattens markup to text lines", () => {
    expect(stripTags("<div>a</div><p>b &amp; c</p>")).toBe("a\nb & c");
  });
});
