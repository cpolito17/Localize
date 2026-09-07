# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability or exposed credential. Use GitHub's private vulnerability reporting feature for this repository. Include the affected URL or file, reproduction steps, expected impact, and any safe proof of concept.

## Supported version

Only the code on the repository's default branch and the deployment at <https://charliepolito.com/localize/> are supported.

## Secrets

Real Google credentials and `RATE_LIMIT_SECRET` belong in encrypted Worker secrets (or deployment environment variables for the reference backend). The browser key is returned to the client by design and must be restricted to the production hostname and Maps JavaScript API. Cloudflare Workers do not provide one stable egress IP to allowlist, so the server key must remain secret, be restricted to Places API (New) and Geocoding API, and be protected by conservative Google Cloud quotas.

The public Worker applies signed anonymous browser identities, keyed IP hashes, per-minute rate-limit bindings, atomic D1 daily counters, a separate Google-call ceiling, strict request validation, same-origin API enforcement, upstream timeouts, and hardened response headers. Raw IP addresses are not persisted.

If a credential is ever committed, revoke it first, remove it from the complete Git history, and only then make the repository public again.
