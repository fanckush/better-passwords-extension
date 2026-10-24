# Credential delivery and native password creation

This change keeps Apple Passwords as the vault. It adds no native executable, cloud account, browser permission, Accessibility grant, or disk password store. It does not claim that the extension is more secure or faster than Apple's complete product.

## Required behavior

- Password replies must match the requested username and authenticated site. Login lists must be filtered by the requested site. A late reply for another site must fail closed.
- The latest user password choice wins even if WebCrypto completes an older encryption later. The expected fill origin stays the one selected at the start.
- Lock invalidates secret operations already encrypting, decrypting, importing a key or opening a native connection. Stale operations cannot restore state, cache generated passwords, or initiate a later secret delivery. A browser message already delivered cannot be recalled.
- Chromium defaults to locking when the screen locks. Explicit saved preferences remain in force. Firefox's existing idle limitation remains documented.
- Unsafe, contradictory or excessively complex password rules produce an error rather than a password labeled strong. A bounded generator must satisfy all parsed rules before returning.
- Sign-up and reset menus put Create in Apple Passwords first. The action also works before pairing. It asks Apple's helper to open native creation only when the helper advertises support; older helpers open Passwords at the site instead. It reads no password, saves no credential itself and fills nothing into the page.
- When inline generation is refused, the reason and native creation option remain visible. Opening Apple's app cannot remove a website's own weak-password restriction.

## Native scope

The native creation message is command 13 with newPasswordWithSuggestedURL, gated by canOpenPasswordsAppToNewPasswordSheet. This matches the shipped Apple iCloud Passwords 3.4.0 extension's launchPasswordsAppToNewPasswordSheet path. The helper is an undocumented Apple interface already used by this project, not a new public AuthenticationServices entitlement. Native runtime behavior still requires testing on an isolated Mac account with dummy credentials.

Apple continues to own its vault, helper, permission prompts and native generation UI. The extension keeps its small browser adapter and existing SRP/AES-GCM client. The optional companion is unchanged.

## Inline generation policy

The rule-based candidate pool must contain a conservative lower bound of at least 2^81 valid strings. For each required character set, subtract an upper bound on the strings missing that set. For a maximum repeated-character run, subtract an upper bound over every forbidden run position. Overlap makes the bound smaller, so ambiguous cases are refused. The default Apple-shaped candidate has more than 80 bits of randomness; the extra rule-space bit allows for mixing the two generation paths. This is a narrow counting bound on this algorithm, not a claim that every website rule or password generator has been formally audited.

Rules are limited to 4096 characters, 16 required sets and 64 output characters. The sampler stops after 128 attempts and throws if none satisfies the rules. The UI offers the native app instead of silently returning a failed attempt.

## Validation

Use only fake credentials in unit and browser tests. Test the existing public client, Session and generator interfaces, plus the actual extension messages and DOM. Include forced asynchronous pauses to prove cancellation rather than relying on incidental timing. Preserve controls for valid passwords, wrong users and sites, supported and older native helpers, and ordinary sign-up/save flows. Live Apple-helper and companion verification remains a separate proof layer.
