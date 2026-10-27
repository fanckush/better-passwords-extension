# Inline password generation

Unsafe, contradictory or excessively complex parsed rules produce an error rather than a password labeled strong. A valid strong suggestion remains available when only its alphanumeric alternative is impossible.

The rule-based pool needs a conservative lower bound of at least 2^81 valid strings. Subtract upper bounds for missing required sets and forbidden repeated-character runs. Overlap lowers the bound and causes conservative refusal. The default Apple-shaped candidate has more than 80 bits; the extra rule-space bit allows for mixing the paths. This is a narrow counting bound, not a formal cryptographic audit.

Sampling is uniform over the pool and rejects invalid complete candidates. Rules are limited to 4096 characters, 16 required sets and 64 output characters. Stop after 128 attempts and throw if none satisfies the parsed rules. Native app creation is offered in a separate PR.
