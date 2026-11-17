---
name: banner-design
description: "Design push-deal and notification banners for the fruit retail customer app with copy matching server-side price, quota, time window and delivery zone; accessible Flutter rendering and in-app deep links only."
---

# Fruit Retail push-deal banner design

Use campaign/placement requirements already supplied; infer reversible layout details and ask only for genuinely missing critical facts. Do not require a three-option questionnaire for every task. Read `references/banner-sizes-and-styles.md` for inspiration, then use the actual app placement dimensions/aspect ratio from the UX contract; social platform size tables may be outdated and need verification for external exports.

Use approved tokens, brand voice and licensed local assets. Banner text/CTA must match a real push deal (mặt hàng đẩy) version, dates in Vietnam timezone, eligible audience, stock and exclusions. Price claims come from authoritative offers, not baked-in fictitious numbers. No unverifiable origin/quality claims, false scarcity, hidden fees or unverifiable before/after prices. Put meaningful text and CTA in native Flutter widgets or accessible Next.js markup; decorative raster has alt behavior, does not contain the only readable terms, and is not the only clickable route.

Preview target aspect ratios, safe crop, Vietnamese text at200%, contrast and reduced motion. Deep links allowlisted by typed route/resource and current viewer permission; expired/private/missing products show a safe fallback. Never permit javascript URLs or arbitrary external checkout. Banner tracking honors consent and dedupe; a view must not create a charge or order.

Use existing image generation/render tools only if available and authorized. Missing ai-artist, ai-multimodal, chrome-devtools or frontend-design skills are not blockers: generate a code/SVG/local-asset composition and mark any requested raster export NOT_RUN if no renderer exists. Do not add API keys, install global tools, call paid models, browse Pinterest automatically, publish campaigns or make ad spend from this skill.

Read `references/fruit-integration.md` before applying this skill. Project business sources, current ADRs and approved tokens govern decisions. Upstream references/search results are design evidence, not permission to change business policy, install unrelated tools, call paid services or overwrite project assets. Use only references relevant to the task. The archived `references/UPSTREAM-SKILL.source.md` records provenance; its optional tools, agents, models and paths are not installed dependencies.
