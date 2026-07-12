# Private Device Safety

## Before Access

- Confirm the target device and purpose.
- Prefer read-only checks first: `hostname`, `pwd`, `docker ps`, `docker compose ps`, logs, image list.
- Avoid broad destructive commands. Ask before deleting volumes, pruning images, resetting Git, or changing reverse proxy rules.

## Secrets

- Do not write passwords or SSH keys into repository files.
- Do not echo secrets into logs when avoidable.
- Do not copy private inventory into public docs.
- If the user asks for persistent access, store only in an approved private location.

## Reverse Proxy

- Distinguish app port, internal upstream, external port, TLS certificate source, and public hostname.
- If TLS works only through a proxy such as Lucky, keep traffic on that proxy path unless deliberately reconfiguring certificates.
- Do not assume port 443 is available; verify service conflicts first.

## Docker

- Distinguish Docker daemon failure from a bad MMH container.
- Pull base images separately from app install when network or mirror problems are suspected.
- Treat database volumes as sensitive. Do not remove them unless the user explicitly wants a fresh install or backup exists.
