# Native password creation

Sign-up and reset menus put Create in Apple Passwords first, including before pairing and after a generation error. It reads no password, saves no credential itself and fills nothing into the page.

Command 13 uses newPasswordWithSuggestedURL only when canOpenPasswordsAppToNewPasswordSheet is true. Older helpers open Passwords at the site instead. This matches the shipped Apple iCloud Passwords 3.4.0 extension. The helper is undocumented and is already used by this project. This is not a new public AuthenticationServices entitlement.

Apple remains the vault and owns the native prompts and creation UI. No native executable, permission, Accessibility grant or disk password store is added. Live creation-sheet behavior still needs an isolated Mac account with dummy credentials.
