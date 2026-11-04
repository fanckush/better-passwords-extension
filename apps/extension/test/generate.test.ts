import { describe, expect, it } from "vitest";
import {
  allowsSpecialCharacters,
  type FieldRules,
  generatePassword,
  PasswordRulesError,
  parseRules,
} from "../src/passwords/generate.ts";

const repeat = (n: number, fn: () => void) => {
  for (let i = 0; i < n; i++) fn();
};

const password = (...args: Parameters<typeof generatePassword>) => generatePassword(...args).password;

describe("generatePassword", () => {
  it("makes Apple-style passwords by default", () => {
    repeat(200, () => {
      const suggestion = generatePassword("strong");
      expect(suggestion.strength).toBe("strong");
      expect(suggestion.limit).toBeUndefined();
      expect(suggestion.password).toMatch(/^[a-zA-Z0-9]{6}-[a-zA-Z0-9]{6}-[a-zA-Z0-9]{6}$/);
      expect(suggestion.password.replace(/[^A-Z]/g, "")).toHaveLength(1);
      expect(suggestion.password.replace(/[^0-9]/g, "")).toHaveLength(1);
      expect(suggestion.password).not.toMatch(/[lIoO01]/);
    });
  });

  it("leaves out special characters when asked", () => {
    repeat(200, () => {
      const generated = password("alphanumeric");
      expect(generated).toMatch(/^[a-zA-Z0-9]{20}$/);
      expect(generated).toMatch(/[A-Z]/);
      expect(generated).toMatch(/[0-9]/);
    });
  });

  it("varies", () => {
    const seen = new Set(Array.from({ length: 100 }, () => password("strong")));
    expect(seen.size).toBe(100);
  });

  it("fits a field's maxlength, still strong at 12 characters", () => {
    repeat(100, () => {
      const suggestion = generatePassword("strong", { maxLength: 12 });
      expect(suggestion.strength).toBe("strong");
      expect(suggestion.password).toHaveLength(12);
      expect(suggestion.password).toMatch(/[a-z]/);
      expect(suggestion.password).toMatch(/[A-Z]/);
      expect(suggestion.password).toMatch(/[0-9]/);
    });
  });

  it("follows passwordrules", () => {
    const rules = "minlength: 24; required: lower; required: upper; required: digit; required: [!#]; allowed: [-]";
    repeat(100, () => {
      const generated = password("strong", { passwordRules: rules });
      expect(generated.length).toBeGreaterThanOrEqual(24);
      expect(generated).toMatch(/[!#]/);
      expect(generated).toMatch(/^[a-zA-Z0-9!#-]+$/);
    });
  });

  it("uses every digit when only digits are allowed", () => {
    const seen = new Set<string>();
    repeat(200, () => {
      const generated = password("strong", { passwordRules: "allowed: digit; minlength: 8; maxlength: 8" });
      expect(generated).toMatch(/^[0-9]{8}$/);
      for (const c of generated) seen.add(c);
    });
    // 0 and 1 too: with so few options, look-alikes aren't worth leaving out
    expect(seen).toContain("0");
    expect(seen).toContain("1");
  });

  it("respects max-consecutive", () => {
    repeat(50, () => {
      expect(password("strong", { maxLength: 16, passwordRules: "max-consecutive: 1" })).not.toMatch(/(.)\1/);
    });
  });

  it("ignores rules it can't read", () => {
    expect(password("strong", { passwordRules: "nonsense; required: ; maxlength: -3" })).toMatch(
      /^[a-zA-Z0-9]{6}-[a-zA-Z0-9]{6}-[a-zA-Z0-9]{6}$/,
    );
    expect(password("strong", { passwordRules: `maxlength: 4;${" ".repeat(5000)}` })).toHaveLength(20);
  });

  it.each([
    { rules: { maxLength: 8 }, strength: "fair", limit: "This site limits passwords to 8 characters." },
    { rules: { maxLength: 6 }, strength: "weak", limit: "This site limits passwords to 6 characters." },
    {
      rules: { maxLength: 6, passwordRules: "allowed: digit" },
      strength: "weak",
      limit: "This site limits passwords to 6 digits.",
    },
    { rules: { maxLength: 14 }, strength: "strong", limit: undefined },
  ] as { rules: FieldRules; strength: string; limit?: string }[])(
    "says how much the site's rules held it back: %j",
    ({ rules, strength, limit }) => {
      const suggestion = generatePassword("strong", rules);
      expect(suggestion.strength).toBe(strength);
      expect(suggestion.limit).toBe(limit);
    },
  );

  it.each([
    { rules: { maxLength: 1 }, reason: "too-weak" },
    { rules: { maxLength: 2 }, reason: "too-weak" },
    { rules: { passwordRules: "allowed: [a]; minlength: 20; maxlength: 20" }, reason: "too-weak" },
    { rules: { passwordRules: "allowed: [ab]; max-consecutive: 1" }, reason: "too-weak" },
    { rules: { minLength: 30, maxLength: 10 }, reason: "contradict" },
  ] as { rules: FieldRules; reason: string }[])(
    "refuses rules that leave nothing worth suggesting, before using randomness: %j",
    ({ rules, reason }) => {
      let draws = 0;
      const random = () => {
        draws++;
        return 0;
      };
      expect(() => generatePassword("strong", rules, random)).toThrow(PasswordRulesError);
      try {
        generatePassword("strong", rules, random);
      } catch (error) {
        expect((error as PasswordRulesError).reason).toBe(reason);
      }
      expect(draws).toBe(0);
    },
  );

  it("says plainly why there's no suggestion", () => {
    expect(() => generatePassword("strong", { maxLength: 1 })).toThrow(
      "This site limits passwords to 1 character, which anyone could guess.",
    );
    expect(() => generatePassword("strong", { passwordRules: "allowed: [ab]; max-consecutive: 1" })).toThrow(
      "This site only accepts passwords that are easy to guess.",
    );
    expect(() => generatePassword("strong", { minLength: 30, maxLength: 10 })).toThrow(
      "Couldn't create a password this site would accept.",
    );
  });

  it("has no alternative without special characters when the site requires one", () => {
    const rules = { passwordRules: "required: lower; required: upper; required: digit; required: [!#]; minlength: 24" };
    expect(password("strong", rules)).toMatch(/[!#]/);
    expect(() => generatePassword("alphanumeric", rules)).toThrow(PasswordRulesError);
  });

  it("gives up rather than suggesting a password that breaks the rules", () => {
    // randomness that only ever picks the first character never gives the digit the site requires
    expect(() =>
      generatePassword("strong", { maxLength: 16, passwordRules: "required: lower; required: digit" }, () => 0),
    ).toThrow(PasswordRulesError);
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

describe("several fields' rules", () => {
  it("meets all of them at once: the strictest of each", () => {
    const rules = parseRules({
      passwordRules: [
        "minlength: 10; maxlength: 30; max-consecutive: 3; allowed: lower, digit",
        "minlength: 12; maxlength: 16; max-consecutive: 2; required: digit; allowed: lower, upper",
      ],
    });
    expect(rules.minLength).toBe(12);
    expect(rules.maxLength).toBe(16);
    expect(rules.maxConsecutive).toBe(2);
    expect(rules.required).toEqual(["0123456789"]);
    // only what both allow: lower and digits (the second allows digits through its required set)
    expect(rules.allowed).toBe("abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("makes passwords that fit every field", () => {
    repeat(50, () => {
      const generated = password("strong", {
        passwordRules: ["allowed: lower, digit; maxlength: 16", "required: digit; required: lower; minlength: 12"],
      });
      expect(generated).toMatch(/^[a-z0-9]{12,16}$/);
      expect(generated).toMatch(/[0-9]/);
    });
  });

  it("suggests nothing when the fields allow no character in common", () => {
    expect(() => generatePassword("strong", { passwordRules: ["allowed: digit", "allowed: lower"] })).toThrow(
      "Couldn't create a password this site would accept.",
    );
  });
});

describe("allowsSpecialCharacters", () => {
  it("depends on the site's rules, not on the password that came out", () => {
    expect(allowsSpecialCharacters({})).toBe(true);
    expect(allowsSpecialCharacters({ maxLength: 8 })).toBe(true);
    expect(allowsSpecialCharacters({ passwordRules: "allowed: lower, upper, [-]" })).toBe(true);
    expect(allowsSpecialCharacters({ passwordRules: "allowed: digit" })).toBe(false);
    expect(allowsSpecialCharacters({ passwordRules: "required: lower, upper, digit" })).toBe(false);
  });
});
