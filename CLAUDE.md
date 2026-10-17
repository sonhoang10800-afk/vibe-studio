# Claude Code Instructions - Vibe Studio

## Build & Test Commands
- Install: `rtk npm install`
- Typecheck: `rtk npm run typecheck`
- Test: `rtk npm test`
- Single Test: `rtk npx vitest run tests/unit/utils.test.ts`
- Dev Server: `rtk npm run dev`
- Full Verification: `bash scripts/verify.sh`

## Code & Architecture Conventions
- **Routing & Rendering:** Next.js App Router. Default to Server Components (`src/app/`). Add `"use client"` only for client interactivity.
- **Components:** Atomic UI components live in `src/components/ui/`. Domain feature modules live in `src/features/<domain>/`.
- **Styling:** Tailwind CSS with `cn(...)` utility in `src/lib/utils.ts`.
- **Typing:** Strict TypeScript. Zero `any`, zero `@ts-ignore`.
- **Quality Guardrails:** Follow `AGENTS.md` and `CODE_STYLE.md`. Always run `rtk npm test` before committing.
