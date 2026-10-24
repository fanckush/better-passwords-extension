// Strong passwords for sign-up forms. Runs in the background worker only.
//
// The default looks like Apple's: three groups of six letters joined by hyphens, with one capital
// and one digit, about 80 bits. Sites state their limits with minlength/maxlength and the
// `passwordrules` attribute (https://developer.apple.com/password-rules/); when Apple's shape
// doesn't fit them, a password is built from the rules instead.

export type PasswordStyle = "strong" | "alphanumeric";

export interface FieldRules {
  minLength?: number;
  maxLength?: number;
  /** The field's `passwordrules` attribute, verbatim. */
  passwordRules?: string;
}

// letters and digits that can't be mistaken for each other (no l/1/I, o/0/O)
const LOWER = "abcdefghijkmnpqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGIT = "23456789";
const SPECIAL = "-~!@#$%^&*_+=`|(){}[:;\"'<>,.?] ";

const CLASSES: Record<string, string> = {
  lower: LOWER,
  upper: UPPER,
  digit: DIGIT,
  special: SPECIAL,
  "ascii-printable": LOWER + UPPER + DIGIT + SPECIAL,
};

const DEFAULT_LENGTH = 20;
const MAX_LENGTH = 64;
// Leave one bit of margin for mixing the Apple-shaped and rule-based distributions.
const MIN_RULE_SPACE = 1n << 81n;

export class PasswordRulesError extends Error {
  constructor() {
    super("This site's rules cannot produce a strong password suggestion. Choose a password in Apple Passwords.");
    this.name = "PasswordRulesError";
  }
}

interface ParsedRules {
  minLength: number;
  maxLength: number;
  /** Each entry: one character must come from this set. */
  required: string[];
  /** Every character must come from the union of these (empty: no restriction). */
  allowed: string;
  maxConsecutive?: number;
}

/** Uniform random index below `n`, without modulo bias. */
export type RandomIndex = (n: number) => number;

export const cryptoRandomIndex: RandomIndex = (n) => {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    const value = buffer[0] ?? 0;
    if (value < limit) return value % n;
  }
};

function pick(chars: string, random: RandomIndex): string {
  return chars.charAt(random(chars.length));
}

function unique(chars: string): string {
  return Array.from(new Set(chars)).join("");
}

/** Parses the subset of Apple's password rules language that matters for generating. */
export function parseRules(rules: FieldRules): ParsedRules {
  const parsed: ParsedRules = { minLength: 0, maxLength: MAX_LENGTH, required: [], allowed: "" };
  for (const part of (rules.passwordRules ?? "").split(";")) {
    const separator = part.indexOf(":");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim().toLowerCase();
    const value = part.slice(separator + 1).trim();
    if (name === "minlength" || name === "maxlength" || name === "max-consecutive") {
      const number = Number.parseInt(value, 10);
      if (!Number.isFinite(number) || number <= 0) continue;
      if (name === "minlength") parsed.minLength = Math.max(parsed.minLength, number);
      else if (name === "maxlength") parsed.maxLength = Math.min(parsed.maxLength, number);
      else parsed.maxConsecutive = number;
    } else if (name === "required" || name === "allowed") {
      const chars = characterSet(value);
      if (!chars) continue;
      if (name === "required") parsed.required.push(chars);
      parsed.allowed += chars;
    }
  }
  if (rules.minLength && rules.minLength > 0) parsed.minLength = Math.max(parsed.minLength, rules.minLength);
  if (rules.maxLength && rules.maxLength > 0) parsed.maxLength = Math.min(parsed.maxLength, rules.maxLength);
  parsed.allowed = unique(parsed.allowed);
  return parsed;
}

/** "upper, digit, [-_]" → the characters those classes stand for. */
function characterSet(list: string): string {
  let chars = "";
  for (const match of list.matchAll(/\[([^\]]*)\]|([a-z-]+)/gi)) {
    if (match[1] !== undefined) chars += match[1].replace(/[^\x20-\x7e]/g, "");
    else chars += CLASSES[match[2]?.toLowerCase() ?? ""] ?? "";
  }
  return unique(chars);
}

function satisfies(password: string, rules: ParsedRules): boolean {
  if (password.length < rules.minLength || password.length > rules.maxLength) return false;
  if (rules.allowed && [...password].some((c) => !rules.allowed.includes(c))) return false;
  if (!rules.required.every((set) => [...password].some((c) => set.includes(c)))) return false;
  if (rules.maxConsecutive) {
    let run = 1;
    for (let i = 1; i < password.length; i++) {
      run = password[i] === password[i - 1] ? run + 1 : 1;
      if (run > rules.maxConsecutive) return false;
    }
  }
  return true;
}

/** Apple's shape: xxxxxx-xxxxxx-xxxxxx with one capital and one digit (or without hyphens). */
function appleShaped(style: PasswordStyle, random: RandomIndex): string {
  const letters = Array.from({ length: 18 }, () => pick(LOWER, random));
  const capital = random(letters.length);
  let digit = random(letters.length - 1);
  if (digit >= capital) digit += 1;
  letters[capital] = pick(UPPER, random);
  letters[digit] = pick(DIGIT, random);
  if (style === "alphanumeric") {
    // 20 characters, like the hyphenated form
    return letters.join("") + pick(LOWER + UPPER + DIGIT, random) + pick(LOWER, random);
  }
  return [letters.slice(0, 6), letters.slice(6, 12), letters.slice(12)].map((group) => group.join("")).join("-");
}

interface Recipe {
  pool: string;
  checks: ParsedRules;
  length: number;
}

function recipe(style: PasswordStyle, rules: ParsedRules): Recipe {
  const defaults = style === "strong" ? `${LOWER}${UPPER}${DIGIT}-` : LOWER + UPPER + DIGIT;
  let pool = rules.allowed || unique(defaults + rules.required.join(""));
  if (style === "alphanumeric" && !rules.required.some((set) => set === CLASSES.special)) {
    const alphanumeric = [...pool].filter((c) => /[a-z0-9]/i.test(c)).join("");
    if (alphanumeric) pool = alphanumeric;
  }
  // like Apple's: mix cases and digits, unless the site restricts the characters
  const required = [...rules.required];
  if (!rules.allowed) for (const set of [LOWER, UPPER, DIGIT]) if (!required.includes(set)) required.push(set);
  const checks: ParsedRules = { ...rules, required };
  const length = Math.min(Math.max(DEFAULT_LENGTH, rules.minLength, checks.required.length), rules.maxLength);
  if (
    !Number.isInteger(length) ||
    length < 1 ||
    length > MAX_LENGTH ||
    length < rules.minLength ||
    required.length > 16
  ) {
    throw new PasswordRulesError();
  }
  const size = BigInt(pool.length);
  const total = size ** BigInt(length);
  // Subtract an upper bound for each way a string can break a rule. Overlaps only
  // lower this bound, so uncertain or excessively restrictive rules fail closed.
  let valid = total;
  for (const set of new Set(required)) {
    const matches = [...pool].filter((character) => set.includes(character)).length;
    valid -= BigInt(pool.length - matches) ** BigInt(length);
  }
  if (rules.maxConsecutive && rules.maxConsecutive < length) {
    valid -= BigInt(length - rules.maxConsecutive) * size ** BigInt(length - rules.maxConsecutive);
  }
  if (valid < MIN_RULE_SPACE) throw new PasswordRulesError();
  return { pool, checks, length };
}

/** A password built straight from a validated set of site rules. */
function fromRules({ pool, checks, length }: Recipe, random: RandomIndex): string {
  let password = "";
  for (let attempt = 0; attempt < 128; attempt++) {
    password = "";
    for (let i = 0; i < length; i++) {
      password += pick(pool, random);
    }
    if (satisfies(password, checks)) return password;
  }
  throw new PasswordRulesError();
}

export function generatePassword(
  style: PasswordStyle,
  fieldRules: FieldRules = {},
  random: RandomIndex = cryptoRandomIndex,
): string {
  if ((fieldRules.passwordRules?.length ?? 0) > 4096) throw new PasswordRulesError();
  const rules = parseRules(fieldRules);
  const plan = recipe(style, rules);
  const apple = appleShaped(style, random);
  if (satisfies(apple, rules)) return apple;
  return fromRules(plan, random);
}
