# MMH Chinese Documentation Style

## Tone

- Professional, direct, and reassuring.
- Use ordinary product language rather than developer narration.
- Prefer "你可以..." and "完成后..." for user steps.
- Avoid exaggerated marketing claims.

## Structure

- Start with what MMH solves.
- Then show the simplest install/use path.
- Then provide update, backup, and troubleshooting.
- Put developer/debug details near the end or in separate docs.

## Homepage Copy

Highlight:

- Sensitive family financial data stays under the user's control.
- Self-hosted NAS/Docker direction.
- Unified management of cash accounts, cards, funds, insurance, debt, and family members.
- Web as detailed workspace, mobile as daily quick entry/viewing.
- AI statement recognition and batch import as future/strategic workflows only if implemented or clearly marked.

## Install Docs

- Put graphical install before command-line install.
- Combine repetitive download links.
- State expected result, for example "打开 http://NAS_IP:7777".
- Explain default placeholders only when the user must change them.
- Keep advanced mirror/image troubleshooting separate.

## Release Notes

- Write notes only for meaningful user-visible changes.
- Format: "新增/优化/修复" with concise bullets.
- Mention required user action only when necessary.

## Avoid

- Private IPs, passwords, SSH usernames, local-only paths, or personal domains in public docs.
- Long command blocks before the user understands why they are needed.
- Raw stack traces in the main path.
