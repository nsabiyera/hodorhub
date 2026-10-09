## What & why

<!-- What does this change and which backlog story / ADR does it serve? -->

Closes #

## Checklist

- [ ] Linked to a user story in `PRODUCT_BACKLOG.md` (or an ADR)
- [ ] Tests added/updated and passing locally (`npm test`)
- [ ] Respects bounded-context boundaries (no cross-module table access)
- [ ] Integrity invariants intact: scoring/discovery remain payment- and brand-blind; hours count only when approved
- [ ] No secrets committed; env changes reflected in `.env.example`
- [ ] CI green
