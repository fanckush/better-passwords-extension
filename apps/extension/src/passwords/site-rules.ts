// Password rules for sites that don't state them in HTML, from Apple's list of known rules
// (https://github.com/apple/password-manager-resources, MIT license; see NOTICE), kept verbatim.
// Refresh it with scripts/update-password-rules.sh.

import type { FieldRules } from "./generate.ts";
import known from "./site-rules.json";

interface KnownRules {
  "password-rules": string;
  /** Only for this exact domain, not its subdomains. */
  "exact-domain-match-only"?: boolean;
}

const list = known as Record<string, KnownRules>;

/**
 * The listed rules for this host: its own, else the closest parent domain's (a rule for
 * example.com covers accounts.example.com), unless that rule is for its exact domain only.
 */
export function siteRules(hostname: string, rules: Record<string, KnownRules> = list): string | undefined {
  let domain = hostname.toLowerCase().replace(/\.$/, "");
  for (let exact = true; domain.includes("."); exact = false) {
    const entry = Object.hasOwn(rules, domain) ? rules[domain] : undefined;
    if (entry && (exact || !entry["exact-domain-match-only"])) return entry["password-rules"];
    domain = domain.slice(domain.indexOf(".") + 1);
  }
  return undefined;
}

/** The field's rules, with the list's for this host when the field has no `passwordrules` of its own. */
export function withSiteRules(field: FieldRules, hostname: string): FieldRules {
  if (field.passwordRules?.length) return field;
  const listed = siteRules(hostname);
  return listed ? { ...field, passwordRules: listed } : field;
}
