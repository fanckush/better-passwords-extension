import { describe, expect, it } from "vitest";
import { generatePassword, parseRules } from "../src/passwords/generate.ts";

const repeat = (n: number, fn: () => void) => {
  for (let i = 0; i < n; i++) fn();
};

describe("generatePassword", () => {
  it("makes Apple-style passwords by default", () => {
    repeat(200, () => {
      const password = generatePassword("strong");
      expect(password).toMatch(/^[a-zA-Z0-9]{6}-[a-zA-Z0-9]{6}-[a-zA-Z0-9]{6}$/);
      expect(password.replace(/[^A-Z]/g, "")).toHaveLength(1);
      expect(password.replace(/[^0-9]/g, "")).toHaveLength(1);
      expect(password).not.toMatch(/[lIoO01]/);
    });
  });

  it("leaves out special characters when asked", () => {
    repeat(200, () => {
      const password = generatePassword("alphanumeric");
      expect(password).toMatch(/^[a-zA-Z0-9]{20}$/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[0-9]/);
    });
  });

  it("varies", () => {
    const seen = new Set(Array.from({ length: 100 }, () => generatePassword("strong")));
    expect(seen.size).toBe(100);
  });

  it("fits a field's maxlength", () => {
    repeat(100, () => {
      const password = generatePassword("strong", { maxLength: 16 });
      expect(password).toHaveLength(16);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[0-9]/);
    });
  });

  it("follows passwordrules", () => {
    const rules = "minlength: 24; required: lower; required: upper; required: digit; required: [!#]; allowed: [-]";
    repeat(100, () => {
      const password = generatePassword("strong", { passwordRules: rules });
      expect(password.length).toBeGreaterThanOrEqual(24);
      expect(password).toMatch(/[!#]/);
      expect(password).toMatch(/^[a-zA-Z0-9!#-]+$/);
    });
  });

  it("respects allowed-only character sets", () => {
    repeat(50, () => {
      expect(generatePassword("strong", { passwordRules: "allowed: digit; minlength: 28; maxlength: 28" })).toMatch(
        /^[2-9]{28}$/,
      );
    });
  });

  it("respects max-consecutive", () => {
    repeat(50, () => {
      const password = generatePassword("strong", { passwordRules: "max-consecutive: 1" });
      expect(password).not.toMatch(/(.)\1/);
    });
  });

  it("ignores rules it can't read", () => {
    expect(generatePassword("strong", { passwordRules: "nonsense; required: ; maxlength: -3" })).toMatch(
      /^[a-zA-Z0-9]{6}-[a-zA-Z0-9]{6}-[a-zA-Z0-9]{6}$/,
    );
  });

  it("throws when its bounded sampler cannot satisfy otherwise safe rules", () => {
    expect(() => generatePassword("strong", { maxLength: 16 }, () => 0)).toThrow(/strong password/i);
  });

  it.each([
    { passwordRules: "allowed: [a]; minlength: 20; maxlength: 20" },
    { maxLength: 6, passwordRules: "allowed: digit" },
    { maxLength: 1 },
    { passwordRules: "allowed: [ab]; max-consecutive: 1" },
    { minLength: 30, maxLength: 10 },
  ])("refuses unsafe or contradictory rules before using randomness: %j", (rules) => {
    let draws = 0;
    expect(() =>
      generatePassword("strong", rules, () => {
        draws++;
        return 0;
      }),
    ).toThrow(/strong password/i);
    expect(draws).toBe(0);
  });
});

describe("parseRules", () => {
  it("combines the attribute with minlength/maxlength", () => {
    const rules = parseRules({ minLength: 10, maxLength: 30, passwordRules: "maxlength: 25; required: upper" });
    expect(rules.minLength).toBe(10);
    expect(rules.maxLength).toBe(25);
    expect(rules.required).toHaveLength(1);
  });
});
