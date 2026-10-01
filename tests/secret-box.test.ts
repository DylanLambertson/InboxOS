import { describe, expect, it } from "vitest";
import { maskSecret, openSecret, sealSecret } from "../worker/lib/secret-box";

describe("secret box", () => {
  const S = "a-long-session-secret-for-tests-only";

  it("round-trips and uses a fresh IV every time", async () => {
    const a = await sealSecret(S, "resend.api_key", "re_12345");
    const b = await sealSecret(S, "resend.api_key", "re_12345");
    expect(a).not.toBe(b);
    expect(a.startsWith("v1.")).toBe(true);
    expect(await openSecret(S, "resend.api_key", a)).toBe("re_12345");
  });

  it("refuses another secret, another purpose, or tampering", async () => {
    const sealed = await sealSecret(S, "resend.api_key", "re_12345");
    expect(await openSecret("different-secret", "resend.api_key", sealed)).toBeNull();
    expect(await openSecret(S, "webhook.secret", sealed)).toBeNull();
    const [v, iv, ct] = sealed.split(".");
    const flipped = ct.slice(0, -2) + (ct.at(-2) === "A" ? "B" : "A") + ct.at(-1);
    expect(await openSecret(S, "resend.api_key", `${v}.${iv}.${flipped}`)).toBeNull();
    expect(await openSecret(S, "resend.api_key", "garbage")).toBeNull();
    expect(await openSecret(S, "resend.api_key", null)).toBeNull();
  });

  it("masks credentials", () => {
    expect(maskSecret("re_abcdefgh3f9a")).toBe("re_••••••3f9a");
    expect(maskSecret("short")).toBe("••••");
  });
});
