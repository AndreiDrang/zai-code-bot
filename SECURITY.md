# Security

## Trust boundaries

- GitHub is an untrusted webhook source until its HMAC signature verifies.
- Comment commands are accepted only from authorized collaborators.
- The main Worker publishes only opaque D1 job IDs to the Queue.
- The heavy Worker is private and has no HTTP/service-binding endpoint.
- GitHub and Z.ai credentials are Cloudflare Secrets Store bindings.

## User-visible output

Provider errors are categorized and sanitized before logging or commenting.
Never include access tokens, raw exception bodies, webhook secrets, or
unbounded source data in a user-facing error.

## Supported commands

Only `/zai review` and `/zai describe` are accepted. Unknown commands receive a
generic supported-command message and are never dispatched to a handler.
