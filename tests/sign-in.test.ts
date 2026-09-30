import { describe, expect, it } from "vitest";
import { soleOwner } from "../worker/lib/users";

describe("signing in with a work address", () => {
  it("maps a personal mailbox to its one owner", () => {
    expect(soleOwner(["u1"])).toBe("u1");
    expect(soleOwner(["u1", "u1"])).toBe("u1"); // address and alias both match
  });
  it("refuses when ownership is ambiguous or missing", () => {
    expect(soleOwner([])).toBeNull();
    expect(soleOwner(["u1", "u2"])).toBeNull();
  });
});
