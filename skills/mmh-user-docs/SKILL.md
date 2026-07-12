---
name: mmh-user-docs
description: Write and revise MMH user-facing Chinese documentation, including README homepage copy, NAS install guides, update instructions, release notes, feature introductions, and troubleshooting. Use when docs should be easier for ordinary users, less command-heavy, more visually/operationally clear, or separated from developer/private local notes.
---

# MMH User Docs

Write MMH docs for a household user who wants the product to work, not for a developer who enjoys build logs.

## Workflow

1. Identify the audience.
   Public GitHub README and install docs are for ordinary users.
   Developer docs are for maintainers.
   Local NAS/private setup notes are for the owner only and should not be mixed into public docs.

2. Put the easiest path first.
   Prefer graphical installation and short steps before command-line fallback.
   Show commands only when they are necessary, copyable, and bounded.
   Hide recovery/debug details behind a troubleshooting section.

3. Explain value before mechanics.
   For homepage copy, lead with sensitive financial data, self-hosting, multi-account overview, family bookkeeping, investment/insurance/debt coverage, and mobile/Web roles.
   Avoid overclaiming security; say what the system does and what the user controls.

4. Keep Chinese clear and calm.
   Use short headings, direct verbs, and expected results.
   Avoid developer reasoning unless it changes a user choice or prevents a common mistake.
   Do not dump logs unless the user needs to recognize an error.

5. Separate public and private docs.
   Public docs must not include private IPs, local paths, passwords, SSH users, or private hostnames.
   Local-only instructions may exist in clearly named private/local docs and should not be linked as the main public path.

6. Verify docs against reality.
   Check file names, URLs, compose service names, image names, ports, and current install flow before finalizing.
   If a doc says "download these files", combine repetitive links or steps where possible.

## Reference

Read `references/writing-style.md` before rewriting README, install docs, or release notes.
