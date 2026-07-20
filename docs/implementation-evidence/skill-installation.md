# Installed Emil Skills Evidence

Install command provided by the user:

`npx skills@latest add emilkowalski/skills --all -y`

Canonical project-local skill root: `agent/skills/`

Verified skill files:

- `agent/skills/emil-design-eng/SKILL.md`
- `agent/skills/review-animations/SKILL.md`
- `agent/skills/improve-animations/SKILL.md`
- `agent/skills/find-animation-opportunities/SKILL.md`
- `agent/skills/animation-vocabulary/SKILL.md`
- `agent/skills/apple-design/SKILL.md`

No `.agents/skills/*/SKILL.md` or `.claude/skills/*/SKILL.md` installation is used as the canonical source in this project. Downstream agents must read the six files above before renderer implementation or motion/design review.
