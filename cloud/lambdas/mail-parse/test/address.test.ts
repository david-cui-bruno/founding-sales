import { describe, expect, it } from "vitest";
import { extractUsAddress } from "../src/address";

describe("extractUsAddress", () => {
  it("parses street, city, state, zip", () => {
    expect(extractUsAddress("123 Hope St, Providence, RI 02906")).toEqual({
      line1: "123 Hope St",
      locality: "Providence",
      region: "RI",
      postal_code: "02906",
    });
  });

  it("parses inside surrounding prose", () => {
    expect(
      extractUsAddress("$2,400/mo 3 bds | 1.5 ba 123 Hope St, Providence, RI 02906 Listed by owner"),
    ).toEqual({
      line1: "123 Hope St",
      locality: "Providence",
      region: "RI",
      postal_code: "02906",
    });
  });

  it("parses a unit segment", () => {
    expect(
      extractUsAddress("45 Benefit St, Apt 2B, Providence, RI 02904"),
    ).toEqual({
      line1: "45 Benefit St, Apt 2B",
      locality: "Providence",
      region: "RI",
      postal_code: "02904",
    });
  });

  it("parses multi-word cities and zip+4", () => {
    expect(
      extractUsAddress("7 Main St, East Providence, RI 02914-1234"),
    ).toEqual({
      line1: "7 Main St",
      locality: "East Providence",
      region: "RI",
      postal_code: "02914",
    });
  });

  it("returns null when there is no address shape", () => {
    expect(extractUsAddress("charming 3 bed near Brown University")).toBeNull();
    expect(extractUsAddress("")).toBeNull();
    // lowercase state token is not a state code
    expect(extractUsAddress("12 x st, town, ri 02906")).toBeNull();
  });
});
