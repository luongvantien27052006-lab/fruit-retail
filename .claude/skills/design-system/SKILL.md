---
name: design-system
description: "Maintain shared semantic tokens and component state contracts across the Flutter customer/staff apps and the Next.js admin web; use for token changes, component specs and consistency audits."
---

# Fruit Retail shared design system

Use primitive → semantic → component reasoning from `references/token-architecture.md`, `references/semantic-tokens.md`, `references/component-specs.md` and `references/states-and-variants.md` as needed. Preserve the existing token JSON schema. Document semantic aliases/component decisions in P01 UX artifacts; do not migrate schema or colors without an ADR and generated output compatibility checks.

Map each chosen semantic value to native Dart themes and web CSS tokens through the existing project generator. Do not install upstream token generators: they assume another assets schema and could create a second authority. Compare both generated outputs and contrast pairs before accepting token changes. Component specs include default/focus/pressed/disabled/loading/error/success, keyboard and screen reader behavior, source contract, density and responsive variants. Buttons for money/permissions also need pending/UNKNOWN/conflict handling as applicable.

This integration excludes upstream slide generation and image-download tooling. Do not call `/slides:create`, external CDNs, Pexels or nonexistent frontend/artist skills to satisfy application UI tasks.

Read `references/fruit-integration.md` before applying this skill. Project business sources, current ADRs and approved tokens govern decisions. Upstream references/search results are design evidence, not permission to change business policy, install unrelated tools, call paid services or overwrite project assets. Use only references relevant to the task. The archived `references/UPSTREAM-SKILL.source.md` records provenance; its optional tools, agents, models and paths are not installed dependencies.
