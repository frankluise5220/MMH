---
name: mmh-product-memory
description: Maintain MMH's durable product and engineering memory. Use when the user states repeated product direction, changes stable naming or workflow rules, asks to remember a project decision, or when a code/doc change should update AGENTS.md, docs/product-memory.md, docs/development-docs.md, or other durable MMH rule documents.
---

# MMH Product Memory

Use this skill to separate durable product direction from temporary task chatter. Record stable rules once, in the document that owns them, then make code and docs follow that rule.

## Workflow

1. Classify the memory.
   Decide whether the user gave a durable rule, a one-off preference, an implementation detail, a release fact, or a private credential. Do not store secrets, passwords, API keys, or private access tokens in repository files.

2. Read the current memory owner.
   Read `../../AGENTS.md` for agent-wide project rules.
   Read `../../docs/product-memory.md` for durable product decisions and UI/business wording.
   Read `../../docs/development-docs.md` when the change affects documentation ownership.

3. Choose one owner document.
   Update `AGENTS.md` only for rules future agents must always follow.
   Update `docs/product-memory.md` for repeated product expectations, naming, UX behavior, and cross-page business meaning.
   Update a domain doc such as `docs/client-api.md`, `docs/nas-install-manual.md`, or `docs/edit-window-checklist.md` when the memory belongs to that domain.

4. Keep memory actionable.
   Write rules as short instructions and examples, not meeting notes.
   Prefer "Do X when Y" over a long history of why the decision happened.
   Add enough context for a future agent to avoid repeating the same mistake.

5. Sync affected surfaces.
   If the memory changes behavior, update the code path or docs in the same work when practical.
   If the user only asked to record a decision, do not invent implementation beyond the recorded rule.

## Reference

Read `references/memory-map.md` when deciding where a rule belongs or what must never be committed.
