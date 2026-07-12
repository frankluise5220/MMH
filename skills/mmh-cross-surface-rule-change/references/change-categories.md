# Change Categories

Use this file to decide how wide a requested change must propagate.

## 1. Field Or Schema Change

Examples:
- add `arrivalDays`
- add account short key
- add metadata to debt prepayment records

Always inspect:
- Prisma schema and migrations
- canonical owner module
- route parsing and response shape
- edit/create dialogs and batch edit
- recalculation and background tasks
- API docs and verification docs

## 2. Calculation Or Derived Value Change

Examples:
- fund holding rules
- floating PnL logic
- loan prepayment strategy
- balance/sign/color semantics

Always inspect:
- canonical calculation owner
- cached/derived data consumers
- overview summaries and detail tables
- background execution paths
- mobile-facing endpoints
- check docs such as `../../docs/check-investment-data.md`

## 3. Naming Or Workflow Rule Change

Examples:
- grouping semantics
- sidebar labels
- account display format
- SS dropdown behavior
- save-and-add-another defaults

Always inspect:
- `../../docs/product-memory.md`
- shared UI component owner
- places that render the same concept differently
- any preference storage or remembered state

## 4. Client Contract Change

Examples:
- new `/api/v1` endpoint
- changed request/response fields
- changed pagination, sort, date, or money format

Always inspect:
- route JSDoc
- `../../docs/client-api.md`
- Web callers
- Android/mobile sync callers
- error shape stability

## 5. Deployment Or Update Change

Examples:
- Dockerfile behavior
- image naming
- system update workflow
- env var changes

Always inspect:
- `../../AGENTS.md`
- `../../docs/development-docs.md`
- NAS/update docs
- public-vs-local source assumptions
