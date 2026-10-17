# Vibe Studio

> A clean, production-ready fullstack workspace optimized for **Vibe Coding** with AI coding agents (Claude Code, Antigravity, OpenCode, Cline).

## 🚀 Overview

Vibe Studio provides a structured, low-friction architecture designed specifically for AI-assisted software development:
- **Zero Config Overhead:** Ready-to-go Next.js App Router, Tailwind CSS, TypeScript (strict), and Vitest.
- **Spec-Driven Vibe Coding:** Dedicated `docs/specs/` and `docs/tasks/` to ground AI agents with high-fidelity context before coding.
- **Strict Quality Control:** Integrated `AGENTS.md`, `CLAUDE.md`, and `CODE_STYLE.md` enforcing TDD, minimal blast radius, zero `any`, and non-breaking refactors.
- **Token-Efficient Execution:** Configured to leverage `rtk` (Rust Token Killer) commands to reduce AI context bloat by 20–40%.

---

## 📂 Directory Layout

```text
vibe-studio/
├── AGENTS.md                 # Autonomous Agent Master Rules & TDD Workflow
├── CLAUDE.md                 # Cheatsheet & commands for Claude Code CLI
├── CODE_STYLE.md             # House style, simplicity rules, and DoD
├── GEMINI.md -> AGENTS.md    # Agent guidelines symlink
├── docs/
│   ├── ARCHITECTURE.md       # High-level architecture & domain boundaries
│   ├── specs/                # Feature specifications (Spec-Driven Development)
│   │   └── SPEC_TEMPLATE.md  # Standard template for AI feature design
│   └── tasks/
│       └── backlog.md        # Trackable task list with binary status
├── src/
│   ├── app/                  # Next.js App Router (Layouts, Pages, API routes)
│   ├── components/
│   │   ├── layout/           # Global layout components (Header, Footer)
│   │   └── ui/               # Reusable atomic UI components (Button, Card, Badge)
│   ├── features/             # Domain-driven feature modules
│   │   └── prompt-studio/    # Showcase domain: Prompt generation & vibe flow
│   ├── lib/                  # Shared utilities (cn class merge, helpers)
│   └── types/                # Core domain and shared TypeScript interfaces
├── tests/
│   ├── unit/                 # Atomic unit tests
│   └── integration/          # Multi-module integration tests
└── scripts/
    ├── verify.sh             # Static check, typecheck & test runner
    └── smoke-test.sh         # Fast HTTP endpoint smoke test
```

---

## 🛠️ Quick Start

### 1. Install Dependencies
```bash
rtk npm install
```

### 2. Typecheck & Tests
```bash
# Run unit & integration tests
rtk npm test

# Run full project verification
bash scripts/verify.sh
```

### 3. Start Development Server
```bash
rtk npm run dev
# App will run at http://localhost:3000
```

---

## 🤖 Vibe Coding Protocol

1. **Plan First:** Write or update the feature spec in `docs/specs/` using `SPEC_TEMPLATE.md`.
2. **Break Down:** Add checklist items to `docs/tasks/backlog.md`.
3. **TDD Loop:** Write failing test in `tests/` $\rightarrow$ Write minimal implementation in `src/` $\rightarrow$ Verify PASS.
4. **Verify Clean:** Run `bash scripts/verify.sh` to confirm 0 type errors, 0 linter issues, and 100% test pass.
