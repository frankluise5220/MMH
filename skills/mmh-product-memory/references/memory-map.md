# MMH Memory Map

## Durable Rule Homes

- `AGENTS.md`: mandatory project rules for future agents, especially data safety, canonical modules, refresh behavior, API rules, deployment direction, and encoding safety.
- `docs/product-memory.md`: product direction, user mental model, repeated UX expectations, naming rules, and confirmed cross-page behavior.
- `docs/development-docs.md`: documentation map and checklist rules.
- `docs/client-api.md`: Web/iOS/Android client contract and versioned API meaning.
- `docs/nas-install-manual.md`: public NAS Docker install and update instructions.
- `docs/edit-window-checklist.md`: create/edit dialog behavior and round-trip rules.
- `docs/check-investment-data.md`: investment and fund verification rules.

## Store

- Repeated product direction from the user.
- Stable business semantics such as account/book/user/institution meanings.
- Cross-surface calculation or display rules.
- Public installation/update direction.
- UI behavior rules that should affect future features.

## Do Not Store In Repo

- Passwords, SSH keys, API keys, cookies, session tokens, and private webhook URLs.
- Private NAS host credentials or personal reverse-proxy credentials.
- Local-only paths unless the document is explicitly private and ignored.
- One-off logs that do not change future behavior.

## Private Operational Memory

Private device notes may live outside the repository, for example under the user's Codex home. Repository docs may mention that a private inventory exists, but must not include credentials.
