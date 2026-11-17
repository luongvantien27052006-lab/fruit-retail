---
name: brand
description: "Define and review Vietnamese brand voice, identity and truthful copy for the fruit retail chain: receipts, labels, push notifications and in-app deal text; use for brand guidelines and branded asset review."
---

# Fruit Retail brand and truthful copy

Read existing tokens and UX decisions before proposing branding. Record guidelines under `docs/engineering/ux/brand-guidelines.md` when the task requires them. Keep approved palette/typefaces stable until a reviewed design decision changes the token source. Do not invent a legal entity, hotline, trust seal, guaranteed inspection outcome, insurance or manufacturing certificate. Distinguish verified supplier/origin information (xuất xứ, NCC, lô) from marketing claims; preserve policy subject, scope, exclusions, effective date and support route.

Use concise Vietnamese; errors explain the next action without blame. Keep status/currency/fees/refund/tax wording aligned with typed notification and microcopy IDs. Read `references/voice-framework.md`, `references/messaging-framework.md`, `references/consistency-checklist.md` and typography/logo references as relevant. No copying competitor logos, copyrighted assets or deceptive discounts.

Optional read-only helpers live in this skill directory: `scripts/inject-brand-context.cjs --json <explicit-guidelines-path>`, `scripts/validate-asset.cjs <asset-path>`, `scripts/extract-colors.cjs <asset-path>`. Inspect input support first; pass explicit paths from repo root. Upstream sync-to-assets script is intentionally excluded: it would target another token authority. Assets require source/license/approval records; design work is not authorization to publish or buy media.

Read `references/fruit-integration.md` before applying this skill. Project business sources, current ADRs and approved tokens govern decisions. Upstream references/search results are design evidence, not permission to change business policy, install unrelated tools, call paid services or overwrite project assets. Use only references relevant to the task. The archived `references/UPSTREAM-SKILL.source.md` records provenance; its optional tools, agents, models and paths are not installed dependencies.
