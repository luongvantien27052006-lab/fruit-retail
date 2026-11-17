---
name: ui-styling
description: "Implement accessible components and responsive screens with native Flutter (customer app, POS/tablet/shipper) and Next.js/Tailwind (admin web)."
---

# Fruit Retail UI implementation

Start from an approved screen-action contract, target platform and shared token names. Reuse existing components; implement missing states/variants in the appropriate shared package. Flutter uses native widgets and Semantics; web uses accessible React elements, controlled focus and the installed Tailwind major. Upstream shadcn examples only apply to web if that library is selected; do not run npx init/add or Tailwind configuration generators from this skill.

Read `references/shadcn-accessibility.md` for web focus/dialog/form principles, `references/tailwind-responsive.md` for web responsive layout, and theming/component references only as needed. Translate interaction intent for Flutter instead of copying web code. Tailwind v3 configuration and v4 @theme examples are alternatives to check against the repo, not simultaneous setup instructions.

Deliver working behavior, validation near fields, real loading/error/retry/conflict states and route/permission handling. Check native back, deep link, keyboard, soft keyboard inset, rotation/text scaling, table accessibility and narrow-screen layout. A polished mock without commands and state behavior does not close a feature task.

Read `references/fruit-integration.md` before applying this skill. Project business sources, current ADRs and approved tokens govern decisions. Upstream references/search results are design evidence, not permission to change business policy, install unrelated tools, call paid services or overwrite project assets. Use only references relevant to the task. The archived `references/UPSTREAM-SKILL.source.md` records provenance; its optional tools, agents, models and paths are not installed dependencies.
