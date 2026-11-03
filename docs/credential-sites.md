# Credential reply sites

Password replies carry no request id, so a late answer to a replaced read can reach a newer read in the same tab and frame. A password reply is used only when it is for the requested username and one of its `sites` is the requested hostname or a subdomain or parent of it (`isSameSite` in `packages/protocol/src/sites.ts`). Anything else fails closed.

Apple's helper matches logins by domain, so exact hostname matching would refuse legitimate fills on `www.` or other subdomains. Siblings that share only a parent, such as two `github.io` sites, don't match.

Login lists aren't filtered: they hold no passwords and their lane is serialized.

The fake helper echoes the requested hostname in `sites`; the shape of real helper `sites` values on subdomains is still to be confirmed against Apple's helper.
