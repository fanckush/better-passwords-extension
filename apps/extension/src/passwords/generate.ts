// Strong passwords for sign-up forms. Runs in the background worker only.
//
// The default looks like Apple's: three groups of six letters joined by hyphens, with one capital
// and one digit, about 80 bits. Sites state their limits with minlength/maxlength and the
// `passwordrules` attribute (https://developer.apple.com/password-rules/); when Apple's shape
// doesn't fit them, a password is built from the rules instead.
//
// A site's limits can make that password weaker than usual. It's still offered, as the strongest
// the site accepts (anything the user makes up instead would be weaker), and its strength says so.
// Only rules no password can meet, or that leave too few passwords to keep one secret, get none.

export type PasswordStyle = "strong" | "alphanumeric";

/** "strong": as good as Apple's default. "fair" and "weak": the site's rules held it back. */
export type Strength = "strong" | "fair" | "weak";

export interface Suggestion {
  password: string;
  strength: Strength;
  /** Why it isn't strong: the rule that held it back, in a sentence. */
  limit?: string;
}

export interface FieldRules {
  minLength?: number;
  maxLength?: number;
  /** The field's `passwordrules` attribute, verbatim. */
  passwordRules?: string;
}

/** The site's rules can't give a password worth suggesting. */
export class PasswordRulesError extends Error {
  constructor(
    readonly reason: "contradict" | "too-weak",
    message = reason === "contradict"
      ? "Couldn't create a password this site would accept."
      : "This site only accepts passwords that are easy to guess.",
  ) {
    super(message);
    this.name = "PasswordRulesError";
  }
}

const SPECIAL = "-~!@#$%^&*_+=`|(){}[:;\"'<>,.?] ";

function classTable(lower: string, upper: string, digit: string): Record<string, string> {
  return { lower, upper, digit, special: SPECIAL, "ascii-printable": lower + upper + digit + SPECIAL };
}

// what the site's class names mean
const FULL = classTable("abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "0123456789");
// what we prefer to pick from: letters and digits that can't be mistaken for each other (no l/1/I,
// o/0/O). Worth it while there's room; when the site's limits make every option count, FULL is used.
const READABLE = classTable("abcdefghijkmnpqrstuvwxyz", "ABCDEFGHJKLMNPQRSTUVWXYZ", "23456789");

const DEFAULT_LENGTH = 20;
const MAX_LENGTH = 64;
/** Longer `passwordrules` are ignored: no real site needs that much. */
const MAX_RULES_LENGTH = 4096;
const ATTEMPTS = 128;

// How many passwords the rules leave (a lower bound), where each strength starts.
/** Fewer: no suggestion. About a random 4-digit PIN. */
const FLOOR = 10_000n;
const FAIR = 1n << 40n;
/** About what Apple's default has. */
const STRONG = 1n << 70n;

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

/**
 * Parses the subset of Apple's password rules language that matters for generating. `classes`
 * says which characters `lower`, `digit` and the like stand for.
 */
export function parseRules(rules: FieldRules, classes = FULL): ParsedRules {
  const parsed: ParsedRules = { minLength: 0, maxLength: MAX_LENGTH, required: [], allowed: "" };
  const text = rules.passwordRules ?? "";
  for (const part of text.length > MAX_RULES_LENGTH ? [] : text.split(";")) {
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
      const chars = characterSet(value, classes);
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
function characterSet(list: string, classes: Record<string, string>): string {
  let chars = "";
  for (const match of list.matchAll(/\[([^\]]*)\]|([a-z-]+)/gi)) {
    if (match[1] !== undefined) chars += match[1].replace(/[^\x20-\x7e]/g, "");
    else chars += classes[match[2]?.toLowerCase() ?? ""] ?? "";
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
  const { lower, upper, digit } = READABLE as { lower: string; upper: string; digit: string };
  const letters = Array.from({ length: 18 }, () => pick(lower, random));
  const capital = random(letters.length);
  let digitAt = random(letters.length - 1);
  if (digitAt >= capital) digitAt += 1;
  letters[capital] = pick(upper, random);
  letters[digitAt] = pick(digit, random);
  if (style === "alphanumeric") {
    // 20 characters, like the hyphenated form
    return letters.join("") + pick(lower + upper + digit, random) + pick(lower, random);
  }
  return [letters.slice(0, 6), letters.slice(6, 12), letters.slice(12)].map((group) => group.join("")).join("-");
}

/** How to build a password from the rules: what to pick from, how long, what it must pass. */
interface Plan {
  pool: string;
  length: number;
  checks: ParsedRules;
  /** At least this many passwords pass the checks. */
  space: bigint;
}

/**
 * A lower bound on how many strings of `length` from `pool` pass `checks`: all of them, minus
 * those missing each required set, minus those with a run that's too long. Strings that break
 * several rules are taken off more than once, so the bound errs low.
 */
function countValid(pool: string, length: number, checks: ParsedRules): bigint {
  const size = BigInt(pool.length);
  let valid = size ** BigInt(length);
  for (const set of new Set(checks.required)) {
    const outside = [...pool].filter((c) => !set.includes(c)).length;
    valid -= BigInt(outside) ** BigInt(length);
  }
  const limit = checks.maxConsecutive;
  // a run one too long can start at length - limit places; the rest of the string is free
  if (limit && limit < length) valid -= BigInt(length - limit) * size ** BigInt(length - limit);
  return valid;
}

/**
 * Plans for building a password from the rules, best first: mixing cases and digits like Apple's
 * (unless the site restricts the characters), then the site's own checks only.
 */
function plans(style: PasswordStyle, fieldRules: FieldRules, classes: Record<string, string>): Plan[] {
  const rules = parseRules(fieldRules, classes);
  const { lower = "", upper = "", digit = "" } = classes;
  let pool =
    rules.allowed || unique(`${lower}${upper}${digit}${style === "strong" ? "-" : ""}${rules.required.join("")}`);
  if (style === "alphanumeric") pool = [...pool].filter((c) => /[a-z0-9]/i.test(c)).join("");
  const length = Math.min(Math.max(DEFAULT_LENGTH, rules.minLength), rules.maxLength);
  // too short for the minimum, or for one character of each required set
  if (length < rules.minLength || length < rules.required.length || pool === "") {
    throw new PasswordRulesError("contradict");
  }
  // a required set that nothing in the pool belongs to (no special characters, but [!#] required)
  if (rules.required.some((set) => ![...pool].some((c) => set.includes(c)))) throw new PasswordRulesError("contradict");
  const mixed = [...rules.required];
  if (!rules.allowed) for (const set of [lower, upper, digit]) if (!mixed.includes(set)) mixed.push(set);
  return [mixed, rules.required]
    .filter((required, i) => i === 0 || required.length !== mixed.length)
    .map((required) => {
      const checks = { ...rules, required };
      return { pool, length, checks, space: countValid(pool, length, checks) };
    });
}

function strengthOf(space: bigint): Strength {
  return space >= STRONG ? "strong" : space >= FAIR ? "fair" : "weak";
}

/** The rule that held the password back, for the menu. */
function limitOf(fieldRules: FieldRules): string {
  const rules = parseRules(fieldRules);
  const short = rules.maxLength < DEFAULT_LENGTH;
  if (rules.allowed && [...rules.allowed].every((c) => FULL.digit?.includes(c))) {
    return short ? `This site limits passwords to ${rules.maxLength} digits.` : "This site only allows digits.";
  }
  if (short) return `This site limits passwords to ${rules.maxLength} characters.`;
  if (rules.allowed) return "This site limits which characters a password can use.";
  return "This site's requirements make it weaker than usual.";
}

/** Why there's no suggestion when the rules leave too few passwords. */
function tooWeak(fieldRules: FieldRules): PasswordRulesError {
  const { maxLength } = parseRules(fieldRules);
  if (maxLength >= DEFAULT_LENGTH) return new PasswordRulesError("too-weak");
  const length = maxLength === 1 ? "1 character" : `${maxLength} characters`;
  return new PasswordRulesError("too-weak", `This site limits passwords to ${length}, which anyone could guess.`);
}

/**
 * Whether a password for these rules may have special characters, so an alternative without them
 * means something (not on a site that only takes digits, say).
 */
export function allowsSpecialCharacters(fieldRules: FieldRules): boolean {
  const { allowed } = parseRules(fieldRules);
  return allowed === "" || /[^a-z0-9]/i.test(allowed);
}

function sample({ pool, length, checks }: Plan, random: RandomIndex): string | undefined {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    let password = "";
    for (let i = 0; i < length; i++) password += pick(pool, random);
    if (satisfies(password, checks)) return password;
  }
  return undefined;
}

/**
 * A password for a new-password field with these rules. Throws `PasswordRulesError` when the rules
 * leave nothing worth suggesting, before drawing any randomness.
 */
export function generatePassword(
  style: PasswordStyle,
  fieldRules: FieldRules = {},
  random: RandomIndex = cryptoRandomIndex,
): Suggestion {
  // Readable characters while that's still strong, every character the site allows when not
  let readable: Plan[] = [];
  try {
    readable = plans(style, fieldRules, READABLE).filter((plan) => plan.space >= STRONG);
  } catch {
    // FULL has every character READABLE has, and more: it decides
  }
  const candidates = readable.length > 0 ? readable : plans(style, fieldRules, FULL);
  const usable = candidates.filter((plan) => plan.space >= FLOOR);
  if (usable.length === 0) throw tooWeak(fieldRules);

  const apple = appleShaped(style, random);
  if (satisfies(apple, parseRules(fieldRules))) return { password: apple, strength: "strong" };
  for (const plan of usable) {
    const password = sample(plan, random);
    if (password === undefined) continue;
    const strength = strengthOf(plan.space);
    return strength === "strong" ? { password, strength } : { password, strength, limit: limitOf(fieldRules) };
  }
  // rules that look possible but that random passwords keep failing
  throw new PasswordRulesError("contradict");
}
