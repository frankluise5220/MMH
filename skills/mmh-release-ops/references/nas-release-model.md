# NAS Release Model

## Public Production

- Code source: GitHub repository.
- Image source: GHCR, normally `ghcr.io/frankluise5220/mmh:latest`.
- User-facing docs should start with graphical/simple installation before command-line fallback.
- Public docs should explain expected result, password/env handling, update flow, and troubleshooting.

## Private Testing

- Code source may be local/NAS Git for faster iteration.
- Image source may be a private test image.
- Private paths and hostnames are convenience details, not product requirements.
- Do not let private local commands replace the public install path.

## Update Direction

- First install may download large base layers.
- Routine updates should reuse Docker layers and pull only changed layers where practical.
- Do not make `docker compose build` the normal update path on NAS.

## Release Notes

- Write notes for meaningful user-visible changes.
- Skip notes for tiny internal fixes unless they explain a risk, migration, or visible behavior.
- Keep release notes user-facing: what changed, why it matters, and whether the user must do anything.
