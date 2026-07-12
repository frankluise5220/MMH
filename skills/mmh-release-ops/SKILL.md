---
name: mmh-release-ops
description: Prepare, verify, and troubleshoot MMH NAS Docker releases and private test deployments. Use for MMH install/update docs, GitHub/GHCR publication, local NAS test sources, Docker image pulls, Feiniu/NAS issues, reverse proxy checks, version checks, and deciding whether a change belongs in public release docs or private local instructions.
---

# MMH Release Ops

Keep MMH deployment boring: public users get a simple Docker image workflow, while private NAS shortcuts stay out of public docs and committed files.

## Workflow

1. Classify the target.
   Decide whether the task is public production, private local testing, NAS recovery, reverse proxy, or release notes. Public production uses GitHub/GHCR. Private testing may use local/NAS Git or local image sources.

2. Protect secrets and private topology.
   Never commit passwords, SSH keys, API keys, personal hostnames with sensitive paths, or private device credentials.
   If private access details are needed, read only an existing private inventory outside the repo, or ask the user.

3. Keep Docker as the deployment path.
   Normal install and update must use Docker compose and prebuilt app images.
   NAS-side builds are fallback/debug only because they install dependencies and can overload low-power NAS hardware.

4. Verify release readiness.
   Check that public docs do not mention local-only paths or private IP workflow as the main path.
   Check that update docs keep the daily flow small:
   `cd ~/mmh`, `git pull`, `sudo docker compose pull app`, `sudo docker compose up -d app`.
   Check that first install and routine updates are described separately.

5. Troubleshoot from the outside inward.
   Confirm the serving host, port, container state, image tag/digest, compose file, app logs, database health, and reverse proxy mapping before changing source code.
   If Docker Hub is blocked, document mirror or fallback image pulls as troubleshooting, not as the main product path.

6. Publish with proof.
   When asked to publish, verify build/typecheck where relevant, commit the intended files, push the intended branch, and report the exact source and image target.

## References

- Read `references/nas-release-model.md` for public vs private source rules.
- Read `references/private-device-safety.md` before touching SSH, NAS, reverse proxy, Docker daemon, or private URLs.

## Scripts

Use `scripts/check-release-files.ps1` for a quick local scan of release docs and deploy files before publishing.
