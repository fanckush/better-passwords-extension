# Credential reply sites

Password replies carry no request id, so a late answer to a replaced read can reach a newer read in the same tab and frame. A password reply is used only when it is for the requested username and one of its `sites` is the requested hostname or a subdomain or parent of it (`isSameSite` in `packages/protocol/src/sites.ts`). Anything else fails closed.

Apple's helper matches logins by domain, so exact hostname matching would refuse legitimate fills on `www.` or other subdomains. Siblings that share only a parent, such as two `github.io` sites, don't match.

Apple's helper still offers some logins that fail that check: one saved on a sibling subdomain (`myaccount.google.com` on `accounts.google.com`) or on a domain Apple counts as related. For those, the client lists the logins the helper offers for the requested hostname again and uses the reply only if one of its `sites` belongs to a listed login with the same username. A late answer for another site isn't in that list, unless Apple offers that same login here anyway.

Login lists aren't filtered: they hold no passwords and their lane is serialized.

The fake helper replies with each login's saved hostname in `sites`, and `alsoOfferedOn` makes it offer a login on other hostnames too, as Apple's helper does.
