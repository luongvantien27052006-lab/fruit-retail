---
name: ui-ux-pro-max
description: "Search local UI/UX guidance for the fruit retail chain: Flutter customer app, Flutter staff app (Windows POS, Android tablet, shipper) and Next.js admin web; use for layout, interaction, accessibility and design review."
---

# Fruit Retail UI/UX research

Use local search to answer a specific design question. Inspect existing tokens and screen contracts first; new screens inherit the existing design system. Run from the repository root with the real available Python executable:

```powershell
python ".claude/skills/ui-ux-pro-max/scripts/search.py" "checkout validation errors" --stack flutter
python ".claude/skills/ui-ux-pro-max/scripts/search.py" "data table keyboard focus" --stack nextjs
python ".claude/skills/ui-ux-pro-max/scripts/search.py" "error summary validation" --domain ux
```

`--stack flutter` and `--stack nextjs` are explicit; never default mobile to html-tailwind. For a genuinely new design direction, `--design-system -f markdown` gives recommendations on stdout. Do not use `--persist` or `--force` against this repo: UX artifacts live in `docs/engineering/ux/` and the token source is pending (CONTEXT NC-02). Save any proposal in the assigned task evidence/design decision path after comparison, not as a new authoritative design-system tree.

Use 2–5 terms with one intent. Check returned category/platform/content; retry once with a narrower query when empty or off-topic, then label fallback honestly. Search ranking and examples are advisory and may be stale; validate implementation APIs against installed versions and official docs. Do not replace a project rule with an upstream search preference. For native details read `references/pro-rules.md`; for a specific concern read the relevant section of `references/quick-reference.md`. Do not load all CSVs into context.

Read `references/fruit-integration.md` before applying this skill. Project business sources, current ADRs and approved tokens govern decisions. Upstream references/search results are design evidence, not permission to change business policy, install unrelated tools, call paid services or overwrite project assets. Use only references relevant to the task. The archived `references/UPSTREAM-SKILL.source.md` records provenance; its optional tools, agents, models and paths are not installed dependencies.
