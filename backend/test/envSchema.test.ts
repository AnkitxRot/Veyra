import { describe, it, expect } from "vitest";
import { validateEnv } from "../src/envSchema.js";

describe("validateEnv", () => {
  it("accepts empty and valid env", () => {
    expect(() => validateEnv({})).not.toThrow();
    expect(() => validateEnv({ PORT: "8080", TRUST_PROXY: "true", PROJECT_QUOTA: "5" })).not.toThrow();
  });
  it("reports every bad variable at once", () => {
    let msg = "";
    try {
      validateEnv({ PORT: "99999", PROJECT_QUOTA: "abc", COOKIE_SECURE: "yes" });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("PORT");
    expect(msg).toContain("PROJECT_QUOTA");
    expect(msg).toContain("COOKIE_SECURE");
  });
});
