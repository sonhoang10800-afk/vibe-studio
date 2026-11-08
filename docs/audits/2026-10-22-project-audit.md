# Vibe Studio — Full Project Audit

**Date:** 2026-10-22
**Commit audited:** `c538d51` (branch `main`, 2 commits total)
**Method:** 4 parallel read-only research agents + lead verification
**Nature of this document:** findings and proposals only. **No code was changed.**

---

## 0. Executive summary

Vibe Studio is a small, well-written Next.js 15 scaffold with a genuinely strong
operating doctrine (`AGENTS.md`) and a high-quality test file (`tests/unit/9router-watchdog.test.ts`).
It also has a systemic problem: **the repo advertises quality gates it does not run.**

The single most important finding is not any individual bug. It is that the project's
acceptance signals are self-reported rather than mechanical. `README.md:77` promises
`verify.sh` confirms "0 type errors, **0 linter issues**, and 100% test pass". There is
no linter installed, no linter configured, and no linter step in `verify.sh`. The script
still prints `🎉 ALL CHECKS PASSED`. Every AI agent that follows the documented Vibe
Coding Protocol ticks a box that no code ever checked.

That pattern repeats across the repo:

| The repo says | Reality |
|---|---|
| "0 linter issues" | no ESLint installed, no config, `npm run lint` exits 1 after an interactive prompt |
| "100% test pass" | 66 tests pass — but 2 of 13 `src/` files have runtime tests, 0 of 9 components do, and 26 of the 66 live in untracked files |
| "Strictly enforced… zero `any`" | enforced by nothing; `tsc` permits explicit `any` |
| "integration tests: end-to-end flows across routes and features" | the one integration file asserts on a literal it defines itself; deleting the whole feature module leaves it green |
| "Configured to leverage `rtk`… 20–40% token savings" | no config, no hook, no script calls `rtk`; the percentage has no source in the repo |
| "production-ready" | no CI, no LICENSE, no coverage tooling, 2 prod CVEs |
| "`docs/ARCHITECTURE.md`" | 2 of 6 mermaid dependency edges are false; 2 of 14 source files are absent from the layer model |

**Second systemic finding — scope contamination.** This is a Next.js web app repo that
also hosts an unrelated local-ops workstream for the developer's personal 9router
installation: a committed macOS `launchd` agent, an untracked Tor probe, 1,402 lines of
superseded Tor design docs, and a broken foreign test that `eval()`s a third-party
build artifact. None of it belongs to the product, none of it is covered by the app's
own CI, and one `git add .` from the repo root would commit all of it.

**Severity counts** (deduplicated across all four agents, 110 raw findings):

| Area | Critical | High | Medium | Low |
|---|---|---|---|---|
| Frontend (`src/`) | 0 | 4 | 9 | 11 |
| Test & tooling | 3 | 5 | 5 | 6 |
| Ops & security (`scripts/`) | 0 | 6 | 16 | 13 |
| Docs & hygiene | 1 | 8 | 14 | 9 |
| **Total (raw)** | **4** | **22** | **44** | **39** |

After cross-agent deduplication (many findings are the same root cause seen from
different angles): **3 distinct critical, 16 distinct high, 34 medium, 33 low.**

**What is genuinely solid:** the type discipline (`strict: true`, zero `any`, zero
`@ts-ignore` — verified by grep), the "use client" boundary discipline (2 files, both
genuinely need it), the `cn()`/`tailwind-merge` usage, the dark-mode strategy
consistency, the GEMINI.md→AGENTS.md symlink mechanism, the zero-secrets posture, the
argv-array command execution in the watchdog, and the atomic state write. §8 lists
28 specific things that are already right.

---

## 1. Method and scope

### 1.1 Who did what

| Actor | Scope | Output |
|---|---|---|
| `fe-auditor` | `src/app/**`, `src/components/**`, `src/features/**`, `src/lib`, `src/types`, `tailwind.config.ts`, `next.config.mjs`, `postcss.config.mjs` | 24 findings |
| `test-auditor` | `tests/**`, `vitest.config.ts`, `package.json`, `scripts/verify.sh`, `scripts/smoke-test.sh`, `tsconfig.json`, CI/ESLint presence | 19 findings |
| `ops-auditor` | `scripts/**` (all 3 dirs), `.env.example`, `.gitignore`, `.claude/`, secret handling, portability | 35 findings |
| `docs-auditor` | `README.md`, `AGENTS.md`, `CLAUDE.md`, `CODE_STYLE.md`, `docs/**`, `.gitignore` coverage, git history, rule-enforcement matrix | 32 findings |
| **lead** | whole repo — baseline, cross-checking every load-bearing claim, mutation testing, runtime probes, report | 20 additional findings |

All four agents ran **read-only**. The lead verified `git diff --stat` is empty and
`git status` shows only the 4 pre-existing untracked paths — no agent modified a
tracked file. (One agent ran `rtk npm install` while probing whether that documented
command works; `package.json` and `package-lock.json` were byte-identical afterward.)

### 1.2 Commands actually executed (evidence base)

```
node --version              → v26.8.1        npm --version → 11.19.0
npx tsc --noEmit            → exit 0, zero output
npx vitest run              → 5 files, 66 tests, 66 passed, exit 0
npx next build              → exit 0; route table: / ○ static, /_not-found ○ static, /api/health ƒ dynamic
npx next start -p 3111      → HTTP 200 on /api/health, uptimeSeconds advances, dynamic (not prerendered)
npm run lint                → exit 1, interactive "How would you like to configure ESLint?" prompt
npm audit                   → 12 vulnerabilities (4 moderate, 6 high, 2 critical)
npm audit --omit=dev        → 2 vulnerabilities (1 moderate, 1 high)
bash -n on 3 shell scripts  → all pass
node scripts/test_opencode_compactor.cjs → Error: compactOpenCodeContext not found in 5330.js
```

### 1.3 Mutation testing (the load-bearing experiment)

Two source mutations were applied in a throwaway copy at `/tmp/vibe-verify`:

| Mutation | Result |
|---|---|
| delete `src/features/prompt-studio/types.ts` entirely | **66 passed** — mutation SURVIVED |
| `prompt.tags.some(tag => tag.toLowerCase().includes(query))` → `false` | **66 passed** — mutation SURVIVED |

Both were re-run by the lead independently of the test-auditor's report. The tag-search
mutation was confirmed to have landed (`false` on line 65 of the mutated file) before
the run. The feature's search logic can be completely broken with a green suite.

### 1.4 What this audit did NOT cover (honesty section)

- **No fix was implemented.** This is a findings document. Every "minimal fix" is a
  proposal, not a change.
- **No Linux/CI execution.** Portability conclusions are from reading the scripts plus
  `bash -n`; no Linux container was available.
- **No `shellcheck`.** Not installed on this machine. The three shell scripts were only
  syntax-checked.
- **No live credentialed requests.** The secret-leak path in `probe-403.mjs` is a
  *code-reading* conclusion, not an observed leak.
- **No deep CVE triage.** `npm audit` counts are reported; I did not assess exploitability
  of each advisory for this app's actual attack surface.
- **Agents share one model family.** Four agents from the same model family provide
  breadth of coverage, not independence of judgment. A second-opinion pass from a
  different model family would likely find additional issues.
- **`node_modules` was not audited** beyond what `tsc --listFiles` and the installed
  package versions reveal.

---

## 2. Architecture assessment

### 2.1 The good news, stated precisely

The **layering in `src/` is real and matches the documented intent**, even where
`docs/ARCHITECTURE.md` describes it wrong:

```
src/app/          Server Components by default. Only page.tsx + layout.tsx + 1 route handler.
src/features/     1 domain (prompt-studio) — types, list, card. Self-contained.
src/components/   ui/ (button, card, badge) + layout/ (header, footer).
src/lib/          cn(), formatDate() — pure.
src/types/        common.ts — ApiResponse<T>, HealthCheckData.
```

- `"use client"` appears in exactly 2 files (`prompt-list.tsx`, `prompt-card.tsx`),
  both of which genuinely need `useState`. No accidental client boundaries.
- `cn()` is used in all 3 UI primitives; no hand-rolled class concatenation.
- `dark:` variants and the `@media (prefers-color-scheme: dark)` CSS-var flip in
  `globals.css` use Tailwind 3's default `media` strategy — **consistent, no
  class/media mismatch** (the classic dark-mode bug this repo does *not* have).
- The `<main>` landmark is a real `<main>` element, not a div.
- Heading order `h1 → h2 → h3` is correct, no skipped levels.
- `key` props are stable and unique, no index keys.
- No `Date.now()` / `Math.random()` in any render path → no hydration mismatch risk.

### 2.2 The structural problem

The `src/` tree is ~14 files. That is the *whole product*. Meanwhile the repository
also contains a **completely separate product surface**: a macOS `launchd` supervisor
for the developer's personal 9router gateway install.

```
vibe-studio/
├── src/                    ← the actual product (Next.js app)
├── tests/
│   ├── unit/utils.test.ts          ← product
│   ├── unit/health.test.ts         ← product
│   ├── integration/app-flow.test.ts← product (but vacuous, see §4.2)
│   ├── unit/9router-watchdog.test.ts   ← LOCAL OPS, not the product
│   └── unit/opencode-probe-403.test.ts ← LOCAL OPS, untracked
└── scripts/
    ├── verify.sh, smoke-test.sh         ← product
    ├── gateway-watchdog/                ← LOCAL OPS, committed (1295 lines)
    └── 9router-tor/                     ← LOCAL OPS, untracked
```

The watchdog scripts:
- hardcode `com.hoangson.9router-watchdog` and `~/.local/bin/9router`,
- install a `launchd` agent into `$HOME/Library/LaunchAgents`,
- `pkill` processes matching a personal path,
- are macOS-only with no Linux path,
- are exercised by the app's test suite, which means **the product's CI signal is
  dominated by a script the product does not own**.

Meanwhile the product's own UI has **zero** tests. This inversion is the clearest
single argument for restructuring the repo (§6, P1-1).

### 2.3 The product's actual domain

`prompt-studio` is a searchable, filterable card list of 4 AI prompt templates, with a
copy-to-clipboard button. It is a demo. That is a legitimate scope for a scaffold. The
problem is not the feature's size — it is that **the governance documents describe a
production product** ("production-ready", "Strict Quality Control", 100% test pass,
integration coverage, security guarantees) while the code is a scaffold.

---

## 3. Verified baseline

### 3.1 What works, verified

| Claim | Verification | Result |
|---|---|---|
| TypeScript strict, 0 errors | `npx tsc --noEmit` | exit 0 |
| Tests green | `npx vitest run` | 66/66 pass, 5 files |
| Build works | `npx next build` | exit 0, 3 routes emitted |
| `/api/health` is dynamic, not prerendered | route table shows `ƒ (Dynamic)`; two live curls show `uptimeSeconds` 5 → 7 | confirmed |
| No `any` / `@ts-ignore` / `@ts-expect-error` | grep over `src/`, `tests/`, `scripts/` | 0 hits |
| No test tampering | grep for `.only(`/`.skip(`/`.todo(` | 0 hits |
| No secrets in tracked files | grep for key/token/secret/bearer/`sk-` patterns over 40 tracked files, 117 git objects, and `stash@{0}` | 0 real hits |
| `.mjs` files are genuinely type-checked | `tsc --listFiles` shows both `.mjs` in the program; `@ts-check` pragma A/B experiment | confirmed real, not transpile-only |
| `readOnly: true` on `node:sqlite` | live write attempt against the opened DB | "attempt to write a readonly database" — enforced |
| No shell interpolation in watchdog commands | `execFileSync("/bin/launchctl", [...])` — argv arrays, no `shell: true` | confirmed |
| Watchdog healthy path is silent | 1560 live launchd runs → 4 log lines, all incident-related | confirmed |
| `GEMINI.md` symlink is real | `git ls-files -s` → mode `120000` | confirmed |
| Tracked tree has no junk | 40 tracked files, all legitimate | confirmed |

### 3.2 What is broken, verified

| Claim | Verification | Result |
|---|---|---|
| `npm run lint` works | ran it | **exit 1**, interactive ESLint-setup prompt; no `eslint*` in `node_modules` |
| `verify.sh` runs a linter | read all 4 steps | **no lint step**; steps = cursor / TODO / tsc / vitest |
| Coverage can be measured | `require.resolve('@vitest/coverage-v8')` | `MODULE_NOT_FOUND`; no coverage script |
| `lucide-react` is used | grep `src/`, `tests/` | **0 imports** — 46 MB runtime dependency |
| `jsdom` is used | grep whole tree; `vitest.config.ts` | **0 hits**; `environment: "node"` |
| `AI_GATEWAY_URL` is read | grep whole tree | only in `.env.example` — dead config |
| `PORT` in `.env.example` configures Next | read `next.config.mjs` | no port key; Next ignores it for `next dev` |
| `PORT` is read | grep `process.env` in `src/` | only `NODE_ENV` is read |
| `.env.example` covers script env vars | grep | `NINEROUTER_API_KEY`, `OMNIROUTE_BASE_URL`, `PROBE_MODEL` used by scripts, absent from `.env.example` |
| `docs/plans/` is live work | read both files | **both headers say `⛔ SUPERSEDED`** |
| The compactor test runs | `node tests/test_opencode_compactor.cjs` | **Error: compactOpenCodeContext not found in 5330.js** — broken; also excluded by the vitest `include` glob |
| Security headers are set | `curl -I` on the live server | **all 6 missing** (x-frame-options, x-content-type-options, referrer-policy, CSP, HSTS, permissions-policy) |
| OpenGraph metadata is emitted | fetched the live HTML `<head>` | **no `og:` tags**, no canonical, no favicon, no manifest |
| Dark-mode class strategy | `tailwind.config.ts` | no `darkMode` key → `media` default, and `globals.css` agrees. **Not a bug.** |
| `bg-background` / `text-foreground` used | grep | **never** — the Tailwind color mapping is dead config (the CSS vars are used directly in `globals.css` instead) |

---

## 4. Findings

### 4.1 CRITICAL

#### C1 — `tests/test_opencode_compactor.cjs`: foreign artifact, `eval()`s a third-party build chunk, already broken

**Location:** `tests/test_opencode_compactor.cjs` (untracked)

```js
// line 114 — absolute path into a private Claude Code transcript
const transcriptPath = '/Users/hoangson/.claude/projects/-Users-hoangson-Projects-Article--claude-worktrees-sleepy-keller-e16c74/b2fdb1a4-9146-4f73-b663-12c475c9c662.jsonl';

// lines 159-164 — reads a minified chunk out of a globally-installed npm package
const code = fs.readFileSync('/Users/hoangson/.local/lib/node_modules/9router/app/.next-cli-build/server/chunks/5330.js', 'utf8');
const startIdx = code.indexOf('function compactOpenCodeContext(messages) {');
const fn = eval(`(${fnSource})`);
```

**Why this is critical, in order:**

1. **It is broken today.** `node tests/test_opencode_compactor.cjs` →
   `Error: compactOpenCodeContext not found in 5330.js`. The function no longer exists
   in the current 9router build. The lead confirmed the file exists but `rg` finds 0
   matches for `compactOpenCodeContext` inside it.
2. **It `eval()`s source scraped from a third-party minified artifact** that changes on
   every upstream release. That is arbitrary code execution from an untrusted, mutable
   file.
3. **It leaks the author's home-directory layout** and the path of a private 8 MB
   Claude Code transcript. The remote is a public GitHub repo
   (`https://github.com/sonhoang10800-afk/vibe-studio.git`). One `git add .` publishes it.
4. **It is invisible to CI.** `vitest.config.ts:8` includes only
   `tests/**/*.test.ts` / `*.test.tsx`. A `.cjs` file matches neither. Forcing
   `include: ["tests/**/*"]` aborts the *entire* vitest run with
   `Error: No test suite found in file .../test_opencode_compactor.cjs`.
5. **The repo's own plan says it does not belong here.**
   `docs/plans/opencode-multilane-tor-controlport.md` §1.4 Non-goals:
   *"Không sửa `tests/test_opencode_compactor.cjs`; đó là test thủ mục của patch
   compaction, không thuộc plan này."* — it is a manual test for the **9router** project.

**Proposal:** delete it from this repo (it belongs to 9router). Add a guard so it cannot
silently re-enter — either a `.gitignore` entry or a vitest `exclude` for
`tests/**/*.cjs`. **Cost: 1 command. Value: removes an ACE-shaped file and a home-path
leak from the tree.**

#### C2 — `tests/integration/app-flow.test.ts` is 100% vacuous

**Location:** `tests/integration/app-flow.test.ts`

```ts
import type { PromptItem } from "@/features/prompt-studio/types";   // type-only → erased at runtime

const samplePrompt: PromptItem = { id: "test-prompt", title: "Test Vibe Coding", ... };

it("should conform to domain schema with required fields", () => {
  expect(samplePrompt.id).toBeDefined();
  expect(samplePrompt.title.length).toBeGreaterThan(0);
  expect(["coding", "architecture", "debugging", "refactor"]).contains(samplePrompt.category);
  expect(Array.isArray(samplePrompt.tags)).toBe(true);
});
```

**Proof of vacuity:** `import type` is erased at runtime. The lead's mutation test
**deleted `src/features/prompt-studio/types.ts` entirely and the suite still reported
5 files / 66 tests passed.** The test asserts on a literal it defines, against an
array literal it also defines.

**Why critical:** the file is named `integration`, lives in `tests/integration/`, and
`docs/ARCHITECTURE.md:42` describes that directory as *"End-to-end integration flows
across routes and features"*. The repo has **zero** integration coverage while
documenting that it has some. This is the file that makes a future agent believe an
integration harness exists.

**Proposal:** export `INITIAL_PROMPTS` from `prompt-list.tsx:8` and assert against the
**real** dataset (count > 0, unique ids, every `category` ∈ `PromptCategory`,
non-empty `template`, every `tag` a non-empty string). ~10 lines, 2 files, no new
dependency. Turns 2 vacuous tests into 5 meaningful ones.

#### C3 — The repo advertises a lint gate that does not exist

**Locations:** `README.md:77`, `package.json:10`, `scripts/verify.sh`

- `README.md:77` — *"Run `bash scripts/verify.sh` to confirm 0 type errors, **0 linter
  issues**, and 100% test pass."*
- `package.json:10` — `"lint": "next lint"`
- `scripts/verify.sh` — 4 steps: cursor check, TODO scan, `npx tsc --noEmit`,
  `npx vitest run`. **No lint step.**
- No `.eslintrc*`, no `eslint.config.*`, no `eslint*` package in `node_modules`.
- `npm run lint` → exit 1 after an interactive setup prompt (verified).

**Why critical:** this is the project's *accept/reject signal* for every agent and
every human. `AGENTS.md` BƯỚC 4 mandates *"Static Check: Chạy linter và typechecker"*.
The linter half is unexecutable, and `verify.sh` still prints
`🎉 ALL CHECKS PASSED`. A repo whose stated quality bar includes "zero `any`"
(`AGENTS.md:41`, `CLAUDE.md:15`, `CODE_STYLE.md:17`, `README.md:10`) enforces it with
nothing — `tsc` in `strict` mode *permits* explicit `any`.

**Proposal — two honest options, pick one:**

- **(a) Make it true (~15 min, needs dependency approval per `AGENTS.md` §3.4):**
  `npm i -D eslint eslint-config-next @typescript-eslint/eslint-plugin
  @typescript-eslint/parser`, add a flat `eslint.config.mjs` with
  `next/core-web-vitals` + `@typescript-eslint/no-explicit-any` +
  `no-ban-ts-comment`, and add a 5th `verify.sh` step.
- **(b) Make it honest (1 line):** delete `"0 linter issues"` from `README.md:77` and
  the linter checkbox from `AGENTS.md:74`. Also decide whether to keep the dead
  `"lint"` script (it prints an interactive prompt — actively harmful in CI).

**Recommendation: (b) now, (a) as an explicit, separately-approved task.** A repo
should not advertise a gate it cannot run; but if linting is genuinely wanted, it
should be added deliberately, with the dependency approved.

---

### 4.2 HIGH

#### H1 — Watchdog health contract mismatch: a correct app would be judged broken and restarted every 5 seconds

`src/app/api/health/route.ts:5-14` returns:
```ts
{ success: true, data: { status: "ok", version: "0.1.0", uptimeSeconds, environment }, timestamp }
```

`scripts/gateway-watchdog/healthcheck.mjs:169-171` requires:
```js
if (typeof payload !== "object" || payload === null || !("ok" in payload) || payload.ok !== true) {
  return { ok: false, kind: "invalid_response", ..., error: "health body is not {ok:true}" };
}
```

**Verified by the lead:** the payload has no `ok` key → `invalid_response`. The watchdog
default target is 9router (which returns `{"ok":true}`), so nothing is broken *today*.
But the repo ships both halves: `src/app/api/health/route.ts` **and**
`scripts/smoke-test.sh` pointing at `http://localhost:3000/api/health`. Pointing the
watchdog at this repo's own health endpoint — the natural move — classifies a healthy
app as broken and restarts it every 5 seconds, forever.

**Proposal:** add `ok: true` to the top level of the health payload. One line; keeps
the existing `ApiResponse` shape so `tests/unit/health.test.ts` still passes.

#### H2 — `waitForHealthy` caps each poll at 1000 ms while the primary probe allows 3000 ms

`healthcheck.mjs:341`:
```js
const probe = await probeHealth(url, Math.max(1, Math.min(remaining, 1000)), fetchImpl);
```
`DEFAULTS.timeoutMs` is `3000`.

**Verified by the ops-auditor against a server that answers in 2 s:** the primary probe
returns `{"ok":true,"latencyMs":2010}`, but the post-restart poll reports
`{"healthy":false,"attempts":21,"elapsedMs":30029}` — **the service is up and the
watchdog says it did not recover**, after 30 s of pointless polling and a false
`restart-failed` log line.

**Why high:** a slow-but-alive service (cold start, DB warm-up, provider handshake) is
exactly the case the watchdog exists to protect. A false alarm trains the operator to
ignore the log.

**Proposal:** use `options.timeoutMs` instead of the hardcoded `1000`. One line.

#### H3 — The cooldown branch wipes `downSince`, re-arming the 15 s startup grace

`healthcheck.mjs:450-455`:
```js
if (decision.action !== "restart") {
  if (decision.action !== "none") {
    persist({ restarts: decision.restarts, downSince: null });   // ← wipes the down timer
```

**Verified trace** (T0 = restart fires, service still refusing):
```
T0     status=restart-failed  state={"restarts":[1000000],"downSince":null}
T+2s   status=starting        state={"restarts":[1000000],"downSince":1002000}
T+18s  status=cooldown        state={"restarts":[1000000],"downSince":null}   ← wiped
T+22s  status=starting        state={"restarts":[1000000],"downSince":1022000} ← grace re-armed
LOG: starting kind=refused downForMs=0    (counter restarted)
```

The startup grace was designed as a **one-shot** 15 s window measured from when the
service went down. Because the cooldown path nulls `downSince`, the next run arms a
fresh window. Effective detection latency becomes `cooldown (30 s) + grace (15 s) ≈
45 s` instead of the intended 15 s, and `downForMs` telemetry resets to 0.

**Proposal:** keep the existing `downSince` in the cooldown/exhausted persist; clear it
only on a healthy probe or after a successful restart. One line.

#### H4 — `writeState` uses a fixed temp path with no lock: concurrent writers silently lose state

`healthcheck.mjs:279-284`:
```js
export function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;        // ← same path for every writer
  writeFileSync(tempPath, `${JSON.stringify(state)}\n`, "utf8");
  renameSync(tempPath, path);
}
```

**Verified by the ops-auditor:** with two concurrent writers, the second `renameSync`
fails with `ENOENT`, and `persistState` (`:355-361`) swallows that into a log line —
**the state update is silently lost**.

**Failure mode:** two overlapping invocations both read `restarts=[1,2]`, both decide
`restart`, both restart the service, and only one write survives. The restart budget
under-counts, so `maxRestarts=5` can be exceeded → **restart storm**, precisely what the
budget exists to prevent. `launchd` does not overlap `StartInterval` ticks of the same
label, but the README documents `~/.local/bin/9router-healthcheck.sh --dry-run` as a
manual entry point, and a manual *non*-dry-run races the launchd job. A stale `.tmp`
from a crash is also never cleaned.

**Proposal:** pid-suffixed temp name (`${path}.${process.pid}.tmp`) + an `O_EXCL` lock
around the read-modify-write in `runOnce()`, unlinked in a `finally`. ~2 lines + a lock.

#### H5 — The real runtime config is generated, untracked, and pins an absolute repo path

`scripts/gateway-watchdog/install.sh:33-66` generates
`~/Library/LaunchAgents/com.hoangson.9router-watchdog.plist` at install time. No plist
template is tracked in git. The live installed plist contains:
```
ProgramArguments = [ "/Users/hoangson/.local/bin/node",
                     "/Users/hoangson/Projects/vibe-studio/scripts/gateway-watchdog/healthcheck.mjs" ]
```

Move or rename the repo and the launchd job keeps exec'ing a path that no longer
exists — launchd fails the job silently (exit 1 every 5 s), the watchdog stops
protecting 9router, and **nothing in the repo shows the drift**. The interval, the
interpreter path, the log paths and the `EnvironmentVariables` block live only on one
laptop. There is no way to diff "intended" vs "installed".

**Proposal:** track a plist template with `__REPO__` / `__NODE__` placeholders and
render it from `install.sh`, so `git diff` shows config drift. Also add the directory to
the README tree (§H12).

#### H6 — `probe-403.mjs` sends the real API key to a base URL taken from the environment, with no allowlist

`scripts/9router-tor/probe-403.mjs:100-113` builds the candidate list from
`NINEROUTER_URL` / `OMNIROUTE_BASE_URL` (read from the shell profile, per the code's
own comment at `:95`); `:344-356` attaches the real key:
```js
const response = await fetch(`${candidate}/models`, { headers: { Authorization: `Bearer ${key}` }, ... });
```

The key is real: `resolveApiKey()` reads `~/.9router/db/data.sqlite` → `apiKeys` has 2
rows with `isActive=1`. A poisoned shell profile, a tampered `.envrc`, a CI env var, or
any code that sets those variables redirects the real credential to an arbitrary host.
No scheme check, no host check, no allowlist.

**Proposal:** restrict candidates to `127.0.0.1` / `localhost` unless an explicit
`--allow-remote` flag is passed.

#### H7 — Zero runtime test coverage for `src/features/**` and `src/components/**`; proven by surviving mutations

| Mutation | Result |
|---|---|
| `src/lib/utils.ts` — drop `twMerge` | **FAIL** (caught) |
| `src/app/api/health/route.ts` — version `"0.1.0"`→`"0.1.1"` | **FAIL** (caught) |
| `src/features/prompt-studio/prompt-list.tsx` — tag search → `false` | **66 passed — SURVIVED** (lead-verified) |
| `src/features/prompt-studio/prompt-list.tsx` — category filter → `true` | **66 passed — SURVIVED** |
| `src/features/prompt-studio/prompt-card.tsx` — badge variant map | **66 passed — SURVIVED** |
| `src/components/ui/button.tsx` — `primary:` → `primaryX:` | **66 passed — SURVIVED** |
| delete `src/features/prompt-studio/types.ts` | **66 passed — SURVIVED** (lead-verified) |

**Of 13 `.ts`/`.tsx` files under `src/`, 2 have runtime tests (15%). Of 9 `.tsx`
component files, 0 have tests.**

**Proposal (no new dependencies needed):** the app's only real business logic is the
filter inside `useMemo` at `prompt-list.tsx:55-68`. Extract it as
`src/features/prompt-studio/filter.ts`:

```ts
export function filterPrompts(
  prompts: PromptItem[],
  category: PromptCategory | "all",
  query: string,
): PromptItem[] { ... }
```

It is a pure function wearing a hook costume. Extract it, export `INITIAL_PROMPTS` from
`prompt-list.tsx`, and both become testable in the existing `environment: "node"`
setup. Similarly, the variant→class maps in `button.tsx:15-30` and `badge.tsx:16-25` are
pure data trapped inside components.

For render-level assertions with **zero new packages**: `react-dom/server`'s
`renderToStaticMarkup` is already installed and works under `environment: "node"`.

#### H8 — 39% of the test suite is untracked and vanishes on clone

`git status --short`:
```
?? docs/plans/
?? scripts/9router-tor/
?? tests/test_opencode_compactor.cjs
?? tests/unit/opencode-probe-403.test.ts
```

`tests/unit/opencode-probe-403.test.ts` (26 tests) and its only source
`scripts/9router-tor/probe-403.mjs` are **both untracked**. A fresh clone runs **4 files
/ 40 tests**, not 5 / 66. Any CI, any teammate, and any other machine measures a
different suite than the author does — and the author's "66 passed" is not reproducible.

**Proposal:** decide per file. The 26 probe tests are genuinely good (classifier
precedence rules, percentile math, quota-header fallbacks) — commit them with their
source, or move both to the 9router repo. Leaving them untracked is the worst option.

#### H9 — No CI, no pre-commit hook, no pinned toolchain

No `.github/`, `.gitlab-ci.yml`, `.circleci/`, `.husky/` — verified absent and never
present in git history. No `.nvmrc`, no `.node-version`, no `engines` field in
`package.json`. The machine runs Node **v26.8.1** against `next@^15.2.0`; Next 15.2
predates Node 26 by many releases and nothing constrains the version.

**Failure mode:** nothing runs the suite on push. The entire TDD workflow in `AGENTS.md`
is enforced only by memory. `next build` is never exercised in CI either, so an App
Router or TS error lands on `main` unnoticed. A Linux CI job would also have caught
the `node:sqlite` platform drift (§M6).

**Proposal:** a ~20-line `.github/workflows/ci.yml` (setup-node pinned to an LTS →
`npm ci` → `npm run typecheck` → `npm test`), plus `"engines": { "node": ">=22.18.0" }`
and an `.nvmrc`. No new dependencies.

#### H10 — Zero accessibility attributes in the entire `src/` tree

`rg -n "aria-|role=|htmlFor|<label|sr-only" src/` → **0 matches.**

| Defect | Location | Failure mode |
|---|---|---|
| Search input has no accessible name | `prompt-list.tsx:90-96` | The page's primary control is announced as "edit text"; a placeholder is a hint, not a name, and vanishes on first keystroke. WCAG 3.3.2 / 4.1.2. |
| Filter buttons expose no selected state | `prompt-list.tsx:75-85` | The active filter is conveyed by colour fill alone. A screen-reader user activating "debugging" gets no confirmation. WCAG 4.1.2 / 1.4.1. |
| 4 copy buttons share the name "Copy" | `prompt-card.tsx:66-72` | All four are indistinguishable in the a11y tree. The label swap to "Copied!" mutates the accessible name rather than announcing a status. |
| Results are never announced | `prompt-list.tsx:101-111` | After typing, no indication the list changed, how many matched, or that it is now empty. |
| No skip link | `layout.tsx:20` | Keyboard/SR users traverse the header nav on every page load. |
| `text-neutral-400` fails WCAG AA | `prompt-card.tsx:44,60` | **Verified by calculation: 2.52:1 on white, 2.31:1 on `neutral-100`.** AA requires 4.5:1. The prompt id and every tag chip are effectively invisible in light mode. |

**Proposal (cheap, high-impact):** `sr-only` label + `id` on the search input (2
lines); `aria-pressed={selectedCategory === cat}` on the filter buttons (1 line);
`aria-label={`Copy prompt template for ${prompt.title}`}` plus a persistent
`<span role="status" aria-live="polite">` (same file); `text-neutral-400` →
`text-neutral-600` on 2 lines (7.81:1, verified).

#### H11 — The clipboard copy is a silent no-op on any non-secure origin, and the comment claims a fallback that does not exist

`prompt-card.tsx:16-25`:
```tsx
try {
  await navigator.clipboard.writeText(prompt.template);
  setCopied(true);
  setTimeout(() => setCopied(false), 2000);
} catch {
  // Fallback if clipboard API is not available   ← there is no fallback
  setCopied(false);
}
```

`navigator.clipboard` is only exposed in secure contexts (HTTPS or `localhost`). On
`http://192.168.x.x:3000`, a staging host, or any plain-HTTP proxy it is `undefined` →
`writeText` throws `TypeError` → the catch swallows it → the button stays "Copy" with
**zero feedback**. The same happens on `NotAllowedError` when the document is not
focused. The comment is factually wrong.

**Proposal:** branch on the missing API and surface the failure in the UI
(`if (!navigator.clipboard) { setCopyError(true); return; }` + a rendered error state).
Only add a `document.execCommand("copy")` fallback if plain-HTTP deployments are real.

#### H12 — `docs/ARCHITECTURE.md` — 2 of 6 mermaid dependency edges are false, and 2 of 14 source files are absent from the model

The diagram asserts `Features --> Lib` and `Features --> Types` (node = `src/types/common.ts`).
The real import graph: **no file under `src/features/` imports `@/lib`, and none
imports `@/types/common`.** Features import their own local `./types`. The only
`@/types/common` importer is `src/app/api/health/route.ts` — i.e. `App --> Types`, an
edge the diagram omits. `src/components/layout/{header,footer}.tsx` appear in neither
the graph nor the numbered layer list.

**Why it matters:** this is the file agents are told to follow for "domain boundaries".
An agent will reflexively import `@/lib` and `@/types/common` from a feature.

**Proposal:** replace those two edges with
`Features --> TypesLocal["src/features/<domain>/types.ts"]`, add `App --> Types`, and
add the missing `Layout["src/components/layout/"]` node.

#### H13 — The README's directory tree omits most of the repository

`README.md:38-43` lists `scripts/verify.sh` and `scripts/smoke-test.sh` only.
`git ls-files scripts/` returns **5 files in 3 directories** — `scripts/gateway-watchdog/`
(3 files, 820 lines, the *newest* commit `c538d51`) is absent, as are
`scripts/9router-tor/`, `docs/plans/`, 2 of 5 test files, and all 9 root config files
(`.env.example`, `next.config.mjs`, `package.json`, `tsconfig.json`, `vitest.config.ts`,
`tailwind.config.ts`, `postcss.config.mjs`, `package-lock.json`).

**Proposal:** 3 lines in the tree.

#### H14 — `docs/tasks/backlog.md` is stale and omits a shipped feature plus 3 live tasks

The file has 14 lines, unchanged since the initial scaffold. It contains **no item**
for the 9router watchdog (commit `c538d51`, 1295 insertions, merged 2026-10-21) and
none for the Tor probe. Conversely `docs/plans/opencode-tor-baseline.md:82-86` lists
three live actions (P0 restore `compactOpenCodeContext`; P1 add
`oc/deepseek-v4.1-flash-free` fallback; P2 fix `NINEROUTER_URL` port 20127→20128) that
appear **nowhere** in the backlog.

To the backlog's credit: **all 9 of its own items are individually accurate** (6 `[x]`
verified done, 3 `[ ]` verified not started). The defect is the *set* being incomplete —
effective accuracy as a statement of "what is left": 3 of 6 real remaining items = 50%.

#### H15 — `verify.sh` claims more than it delivers, and its destructive step is CWD-relative

Four honesty problems in one file:
1. The banner says "4 checks" and lists none as a lint check, yet the README attributes
   "0 linter issues" to it (C3).
2. The TODO scan is `rg -i "TODO:" src/` — the echo says "TODO/FIXME" but `FIXME` is
   never matched, a colon is required (`// TODO implement` is missed), and
   `scripts/`, `tests/`, `docs/` are never scanned. It also **silently skips** the
   check when `rg` is absent, then still prints `✅ Passed`.
3. `"✅ Passed: All tests passed with 100% assertions."` — Vitest reports no assertion
   metric, and 5 of 130 expects are self-referential.
4. `rm -rf .cursor .cursorrules .cursorignore` runs **relative to `$PWD`**, not the
   repo root, and it `exit 1`s after a successful cleanup. Running
   `bash ../vibe-studio/scripts/verify.sh` from `~/Projects` deletes `~/Projects/.cursor`.
   (`AGENTS.md` §3.6 *does* mandate auto-deletion, so the intent is sanctioned — the
   scope is not.)

**Proposal:** `cd "$(dirname "${BASH_SOURCE[0]}")/.."` at the top; widen the scan to
`src/ scripts/ tests/ docs/` with `\b(TODO|FIXME)\b`; make a missing `rg` a hard error;
replace the "100% assertions" string with the actual test count; fix the `rm -rf` scope.

#### H16 — No security headers, no error boundaries, no SEO/favicon metadata

Verified against the live production server:

- **All 6 standard security headers are missing** (X-Frame-Options,
  X-Content-Type-Options, Referrer-Policy, CSP, HSTS, Permissions-Policy).
  `next.config.mjs` has no `headers()` key at all.
- **No `src/app/error.tsx`, `not-found.tsx`, `loading.tsx`, or `global-error.tsx`** —
  any unhandled error renders Next's generic page, a bad URL an unstyled 404.
- **No OpenGraph tags emitted** (confirmed from the live HTML `<head>`), no
  `metadataBase`, no canonical, no favicon, no `sitemap.ts` / `robots.ts`, no
  `public/` directory. `/favicon.ico` 404s on every visit.

**Proposal:** an `async headers()` block in `next.config.mjs` (nosniff, DENY,
strict-origin-when-cross-origin; skip HSTS until HTTPS, skip CSP until nonces exist);
add `src/app/error.tsx` + `not-found.tsx`; add `src/app/icon.svg` + `sitemap.ts` +
`robots.ts` and `metadataBase` + `openGraph` in `layout.tsx`.

#### H17 — `README.md`'s "rtk … 20–40% token savings" has no source, and "Configured" is false

`git grep -n rtk` returns **only prose**: `AGENTS.md:11,45,46,75`, `CLAUDE.md:4-8,16`,
`CODE_STYLE.md:26`, `README.md:11,52,58,66`, and one UI string. **Zero config files,
zero hooks, zero scripts.** `rtk` itself is a machine-global binary at
`~/.local/bin/rtk` (arm64 Mach-O) — it is not a project dependency, and a fresh clone
on another machine has no `rtk` at all. No benchmark or measurement exists anywhere.

This number is the stated justification for the RTK Protocol in `AGENTS.md:11`, and it
sits in the first paragraph of the README — the highest-read line in the repo.

**Proposal:** replace with something verifiable: *"Commands in this repo are written
for the `rtk` CLI (`rtk npm test`, `rtk proxy bash scripts/verify.sh`); see `rtk --help`."*
Drop the percentage, or cite a measurement.

#### H18 — `package.json` runtime dependencies include `lucide-react` (46 MB) which is never imported

`rg -n "lucide" src/ tests/` → **0 matches.** `lucide-react@1.59.0` is a
`dependencies` entry (not devDependencies) and occupies 46 MB of `node_modules`.
`jsdom@26.1.0` is a devDependency used **nowhere** — `vitest.config.ts` sets
`environment: "node"` and no test references jsdom.

**Proposal:** remove `lucide-react` from `dependencies`. Either use `jsdom` (switch
`environment` to `"jsdom"` and add a 3-line setup file) or remove it.

---

### 4.3 MEDIUM (selected — 34 distinct; full list in §7)

| ID | Finding | Location | Proposal |
|---|---|---|---|
| M1 | `lucide-react` unused, 46 MB runtime dep | `package.json:18` | remove |
| M2 | `jsdom` unused devDep; `environment: "node"` blocks any DOM test | `package.json:29`, `vitest.config.ts:7` | use it or remove it |
| M3 | No coverage tooling: `@vitest/coverage-v8` not installed, no `coverage` config, no `test:coverage` script | `package.json`, `vitest.config.ts` | add `@vitest/coverage-v8` + `coverage: { include: ["src/**/*.{ts,tsx}"] }` |
| M4 | 5 of 10 `docs/plans/` lines are superseded but both files sit in `docs/plans/` looking live | `docs/plans/*.md` | move the 1309-line plan to `docs/decisions/` with its banner, keep the 93-line baseline as a decision record |
| M5 | `AGENTS.md` is titled "OmniRoute" — a *different* upstream project | `AGENTS.md:1,7` | remove "(OmniRoute)" |
| M6 | `AGENTS.md` says "5 phần chuẩn" but has 4 sections | `AGENTS.md:3` | say 4 |
| M7 | Language split: `AGENTS.md` + `CODE_STYLE.md` are Vietnamese; `CLAUDE.md` + `README.md` + all `docs/` are English | — | pick one, or add an English summary at the top of `AGENTS.md` |
| M8 | `CODE_STYLE.md` is **not auto-loaded** by the harness (verified: the workspace reminder injected `AGENTS.md` + `CLAUDE.md` only) | — | fold its 3 load-bearing rules into `CLAUDE.md` |
| M9 | `SPEC_TEMPLATE.md` is missing sections the workflow requires: root cause, non-goals, delete-list, lint check, clean-diff check, rollback | `docs/specs/SPEC_TEMPLATE.md` | add them |
| M10 | `.gitignore` protects nothing about `.gstack/`, `.remember/`, `.claude/` — they survive only via self-ignoring `.gitignore` files that vanish on a fresh clone, and `~/.config/git/ignore` (personal) | `.gitignore` | add `.gstack/`, `.remember/`, `.claude/settings.local.json`, `*.log`, `.env.production`, `.env.development`, `.env.test` |
| M11 | `smoke-test.sh` writes to a fixed `/tmp/health_response.json` — symlink-clobber + concurrent-run race, no cleanup | `scripts/smoke-test.sh:14` | `BODY=$(mktemp)` + `trap 'rm -f "$BODY"' EXIT` |
| M12 | `smoke-test.sh` prints `HTTP 000000` — curl's own `%{http_code}` already emits `000` and `\|\| echo "000"` appends a second one | `scripts/smoke-test.sh:14` | `HTTP_CODE=$(curl …) \|\| HTTP_CODE=000` |
| M13 | `smoke-test.sh` has no `--max-time` and asserts only the status code, so a **hung** server hangs the smoke test forever and a 200-HTML page passes | `scripts/smoke-test.sh:14-16` | add `--max-time 5` and assert the body contract |
| M14 | `smoke-test.sh`'s failure path `cat`s a **stale** `/tmp/health_response.json` from a previous successful run, printing a healthy-looking body next to "FAILED" | `scripts/smoke-test.sh:18-21` | only cat the body on success |
| M15 | The watchdog **always exits 0**, including on `restart-failed` / `exhausted` — `launchctl` shows `last exit code = 0` (verified live) | `healthcheck.mjs:580` | return non-zero on failure; the watchdog needs a health check of its own |
| M16 | `--dry-run` writes into the **production** durable log (`dryRun=true` lines already present in the live log) | `healthcheck.mjs:408,460-462` | route dry-run logs to stdout or a `.dryrun` file |
| M17 | The watchdog README's headline "worst-case detection is about 12s" is wrong for the most common failure mode (a fully stopped service returns ECONNREFUSED immediately, then eats the 15 s grace → **≈20-25 s**; H3 makes it ≈45 s) | `scripts/gateway-watchdog/README.md:6-7` | state both numbers |
| M18 | `scripts/9router-tor/` sits under a path 9router's own startup kills — the exact hazard the `gateway-watchdog` rename exists to prevent, and it has a regression test | `scripts/9router-tor/probe-403.mjs` | rename to `scripts/gateway-probe/` |
| M19 | `probe-403.mjs` has no unknown-flag rejection, no `--help`, and `--samples -5` yields **zero workers** and a silent empty successful run (`parseInt("-5") \|\| 20` → `-5`; `Array.from({length:-5})` → `[]`) | `probe-403.mjs:314-318,334` | validate ≥ 1, throw on unknown flags, add `--help`, use `pathToFileURL` for the entry check |
| M20 | `probe-403.mjs` prints and persists up to 300 chars of raw upstream body (`bodyHead`) with **no redaction** — an upstream echoing a bearer token would land it in stdout and in the `--out` report | `probe-403.mjs:245,381-384,414` | redact `/(sk-[A-Za-z0-9_-]{8,}\|Bearer\s+\S+)/gi` |
| M21 | `node:sqlite` requires Node ≥ 22.18 for `{ readOnly: true }`; `DatabaseSync` is a deprecated alias (DEP0210); the module is Stability 1.2 (RC). `package.json` has **no `engines`** | `probe-403.mjs:75`, `package.json` | add `"engines": { "node": ">=22.18.0" }`; use `Database` |
| M22 | `writeState`'s tmp+rename is atomic but the state **read-modify-write** in `runOnce()` is not, and `decideAction`'s cooldown branch persists a mutated `restarts` list | `healthcheck.mjs:279-284,450` | covered by H3/H4 |
| M23 | `pkill -f <processPattern>` where the pattern is `~/.local/bin/9router` — a **prefix** of the documented manual entry point `~/.local/bin/9router-healthcheck.sh` (both exist on disk) | `healthcheck.mjs:307` | anchor the pattern (`-x`, or match the resolved `cli.js`) |
| M24 | `Button` does not default `type="button"` — inside a `<form>` it silently becomes `type="submit"` | `button.tsx:33-37` | add `type="button"` before `{...props}` |
| M25 | `globals.css`'s `body` rule sits **outside `@layer base`**, so it outranks every Tailwind utility on `<body>` | `globals.css:17-22` | wrap in `@layer base { … }` |
| M26 | `tailwind.config.ts`'s `background`/`foreground` color mapping is dead — no `bg-background`/`text-foreground` anywhere | `tailwind.config.ts:12-15` | delete the block, or use the utilities on `<body>` |
| M27 | The version badge is hardcoded and **stale**: the page says "Next.js 15.2" / "TypeScript 5.8"; installed are `next@15.5.28` / `typescript@5.9.3` (verified) | `page.tsx:10-11` | read from `package.json` (`resolveJsonModule` is already on) |
| M28 | `health/route.ts` hardcodes `version: "0.1.0"`, duplicating `package.json:3` — and the test hardcodes it a third time, locking in the drift | `route.ts:9` | import from `package.json` |
| M29 | `uptimeSeconds` reports **process** lifetime, not app uptime — meaningless on serverless (resets every cold start) | `route.ts:10`, `types/common.ts:13` | rename to `processUptimeSeconds`, or compute from a module-scope `STARTED_AT` |
| M30 | The header's `<Badge variant="success">Online</Badge>` is a static string — it shows green even when the service is degraded | `header.tsx:16` | wire it to a health fetch, or make it static/honest |
| M31 | `<Link href="/api/health">` uses the client-navigation primitive for a JSON route handler, with `target="_blank"` but no `rel="noopener"` (the "Docs" anchor has it) | `header.tsx:26-32` | use a plain `<a>` |
| M32 | `AGENTS.md` §1 forbids delegating to subagents; the harness actively offers `spawn_teammate`/`subagent`. The rule is absolute in wording but exempts only "explanation/lookup/architecture-discussion" for the *TDD* workflow, while the Direct-Execution clause covers "reading" too — so a read-only audit is technically forbidden without an explicit request | `AGENTS.md:10` | scope §1 bullet 2 to code-modifying tasks, or add "hoặc tác vụ chỉ đọc/điều tra" |
| M33 | The `.mjs` type-checking is **real but incidental** — it depends on both the `// @ts-check` pragma *and* the file being imported by a test. A third, unimported `.mjs` script would be invisible to `tsc` | `tsconfig.json:5,16-21` | add `"**/*.mjs"` to `include` and `"checkJs": true` |
| M34 | `vitest.config.ts`'s `globals: true` is dead config — every test imports `describe/it/expect` explicitly | `vitest.config.ts:6` | delete the line |

---

### 4.4 LOW (selected — 33 distinct)

| ID | Finding | Location |
|---|---|---|
| L1 | `docs/ARCHITECTURE.md:40-42` describes unit tests as covering "isolated components" and integration tests as "end-to-end … across routes and features" — neither is true | `ARCHITECTURE.md` |
| L2 | `docs/ARCHITECTURE.md` is 42 lines for a 14-file tree: no API contract, no error-handling policy, no test strategy, no env surface | `ARCHITECTURE.md` |
| L3 | `src/types/common.ts:8` `StatusState` is exported and never used anywhere | `common.ts` |
| L4 | `src/lib/utils.ts:14` `formatDate` is used only by its own test, never by product code | `utils.ts` |
| L5 | Unused `React` default imports in `prompt-list.tsx:3` and `prompt-card.tsx:3` (no `noUnusedLocals` in tsconfig) | — |
| L6 | `setTimeout` in `prompt-card.tsx:20` is never stored or cleared — a second click cancels the "Copied!" indicator early and the timer survives unmount | `prompt-card.tsx:20` |
| L7 | Footer padding `px-4` vs header/page `px-4 sm:px-6` — an 8 px misalignment of the left edge at ≥640 px | `footer.tsx:6` |
| L8 | `Button`'s `focus-visible:ring-offset-2` has no offset colour → a **white** halo in dark mode | `button.tsx:13` |
| L9 | `INITIAL_PROMPTS` (the whole seed dataset) lives inside a `"use client"` module, so it ships in the browser payload | `prompt-list.tsx:8` |
| L10 | `docs/ARCHITECTURE.md`'s mermaid omits `App --> Types` and `src/components/layout/` | `ARCHITECTURE.md` |
| L11 | `README.md:1` calls the repo "production-ready" — no CI, no LICENSE, no coverage, 2 prod CVEs | `README.md` |
| L12 | No `LICENSE` — with a public GitHub remote the default is "all rights reserved", yet `package.json:4` says `private: true` and the README says "production-ready" (three signals disagree) | — |
| L13 | No `CHANGELOG`, no `CONTRIBUTING`, no `.gitattributes` (no `*.sh text eol=lf` for the committed shell scripts) | — |
| L14 | `npm audit` → 12 vulnerabilities (4 moderate, 6 high, **2 critical**) including `postcss` XSS + arbitrary file read, `braces` stack exhaustion, `@vitest/mocker` path traversal; `npm audit fix --force` would install `next@16.4.2` (breaking) | `package-lock.json` |
| L15 | `.env.example` carries `PORT=3000` (Next ignores it for `next dev`) and `AI_GATEWAY_URL` (read by nothing) — dead config | `.env.example` |
| L16 | `.env.example` omits `NINEROUTER_API_KEY`, `OMNIROUTE_BASE_URL`, `PROBE_MODEL`, which the scripts actually read | `.env.example` |
| L17 | `vitest.config.ts` has no `setupFiles` and no coverage config | `vitest.config.ts` |
| L18 | The watchdog's `install.sh` legacy fallback `launchctl load -w` is the last command in a `set -e` branch → the installer dies with no diagnostic | `install.sh:80-81` |
| L19 | `install.sh` writes `.bak` files once and never refreshes → "Rollback" restores the *first-ever* config, not the last known-good | `install.sh:30-31` |
| L20 | `install.sh` uses unquoted heredocs for the generated wrapper → a repo path containing `"`, `$` or a backtick would break out of the generated quotes in a `chmod 755` file launchd executes | `install.sh:33-72` |
| L21 | `install.sh` dies at `plutil -lint` on Linux (no `plutil`) — there is **no** systemd path at all | `install.sh:75` |
| L22 | `healthcheck.mjs` `DEFAULTS` hardcode macOS paths (`~/Library/Logs`, `~/.local/bin`) | `healthcheck.mjs:67,69` |
| L23 | `healthcheck.mjs:457` the unreachable fail-safe branch returns `status: "healthy"` for an unhealthy probe — the worst possible wrong answer if `decideAction` ever changes | `healthcheck.mjs:457` |
| L24 | `healthcheck.mjs:291` `execFileSync` with `stdio: "pipe"` discards launchctl/pkill output; the 10 s timeout can abort a merely-slow `kickstart` and convert it into a spurious pkill | `healthcheck.mjs:291` |
| L25 | No log rotation; the "exhausted" state appends a line every 5 s indefinitely | `healthcheck.mjs:245` |
| L26 | `healthcheck.mjs:534-537` loose integer parsing — `parseInt("3abc")` → `3`; `--attempts 1000000` accepted with no upper bound | `healthcheck.mjs` |
| L27 | 7 of 10 watchdog tuning constants are not CLI-tunable (only source-editable). **Note: the README is accurate here** — it says "Defaults live in `DEFAULTS`" and lists exactly the 8 flags `parseArgs` accepts. The limitation is capability, not a doc bug | `healthcheck.mjs`, README |
| L28 | `probe-403.mjs`'s 60 s per-request timeout × 5 rounds = ~5 min worst case, with no progress output until the end | `probe-403.mjs` |
| L29 | `~/.9router/db/data.sqlite` is mode **0644** — world-readable, and it holds 2 active API keys. The probe opens it `readOnly` (correct), but the *file mode* is what leaks it. Not a repo fix — an ops note | — |
| L30 | `next.config.mjs` does not enable `typedRoutes` — a typo'd `href` compiles and passes `tsc` | `next.config.mjs` |
| L31 | `tsconfig.json`'s `allowJs: true` without `checkJs` means a `.js` file without the pragma is parsed but never checked | `tsconfig.json` |
| L32 | `docs/plans/opencode-tor-baseline.md` (93 lines) is the highest-value document in the working tree — a complete, dated, reproducible decision record — and it is **untracked** | `docs/plans/` |
| L33 | The initial commit `055c078` has no body; `c538d51` has an excellent body explaining the non-obvious directory name | git history |

---

## 5. Rule enforcement matrix

Which of the repo's own rules are actually mechanical, and which are prompt-only?

| Rule | Source | Enforced by | Mechanical? |
|---|---|---|---|
| 0 type errors | `AGENTS.md:45` | `verify.sh:30` `npx tsc --noEmit` | **YES** |
| Tests pass | `AGENTS.md:75` | `verify.sh:35` `npx vitest run` | **YES** (exit code only; no coverage threshold) |
| Gemini CLI reads the rules | `README.md:22` | `GEMINI.md` symlink (mode 120000) | **YES** |
| Claude Code / Codex / DSH read the rules | — | `CLAUDE.md` / `AGENTS.md` auto-load (verified: injected this session) | **YES** |
| No Cursor files | `AGENTS.md:63` | `verify.sh:10-14` | PARTIAL — repo-root only, and it `rm -rf`s before asking |
| No `TODO:` | `AGENTS.md:42` | `verify.sh:19-25` | PARTIAL — `FIXME` unmatched, `scripts/`+`tests/`+`docs/` exempt, silently skips without `rg` |
| 0 **linter** issues | `README.md:77` | — | **NO** — no linter exists (C3) |
| Zero `any` | `AGENTS.md:41`, `CLAUDE.md:15`, `CODE_STYLE.md:17`, `README.md:10` | — | **NO** — `tsc` permits explicit `any` |
| Zero `@ts-ignore` | `AGENTS.md:41,76` | — | **NO** |
| Clean diff (no `any`/`@ts-ignore`/`TODO`) | `AGENTS.md:76` | — | **NO** — a self-reported checkbox |
| No test tampering (`.skip()`/`.only()`) | `AGENTS.md:54` | — | **NO** — no guard (currently respected by hand) |
| Strict TDD Red→Green→Verify | `AGENTS.md:31-34` | — | **NO** — no CI, no hook. Unverifiable from history: `c538d51` added 597 lines of implementation **and** its 475-line test in one commit |
| RTK Protocol | `AGENTS.md:11` | — | **NO** — `verify.sh:30,35` use raw `npx`; `rtk` is machine-global, not a project dep |
| Prefer `rg` over `grep` | `AGENTS.md:12` | `verify.sh:19` *if available* | **NO** — degrades to no check |
| No subagent delegation | `AGENTS.md:10` | — | **NO** — and it collides with the harness's own tooling (M32) |
| Circuit breaker (3 attempts) | `AGENTS.md:55-58` | — | **NO** — inherently unenforceable |
| Dependency gatekeeping | `AGENTS.md:59` | `package-lock.json` committed | PARTIAL — no lockfile-freshness check |
| Strict YAGNI / minimal blast radius | `AGENTS.md:37-39` | — | **NO** |
| No `.env` edits | `AGENTS.md:61` | — | **NO** |
| `CODE_STYLE.md` reaches an agent | — | — | **NO** — not auto-loaded (M8) |

**Score: 4 fully enforced, 2 partial, 15 unenforced.** The three rules that *are*
mechanically enforced are also the three enforced *incorrectly* (wrong scope, wrong
pattern, destructive behaviour). Every rule a reader would expect to be checked — lint,
`any`, `@ts-ignore`, test tampering, TDD, YAGNI — is prompt-only.

---

## 6. Coverage map

| source file | runtime-tested? | evidence |
|---|---|---|
| `src/lib/utils.ts` | **yes** | `tests/unit/utils.test.ts` — 6 tests; mutation-verified (dropping `twMerge` fails the suite) |
| `src/app/api/health/route.ts` | **yes** | `tests/unit/health.test.ts` — calls the real `GET()`; mutation-verified |
| `src/features/prompt-studio/types.ts` | no | type-only; **deleting it leaves the suite green** (lead-verified) |
| `src/types/common.ts` | no | type-only, no runtime behaviour |
| `src/features/prompt-studio/prompt-list.tsx` | no | filter + search inline in `useMemo`; 2 mutations survived |
| `src/features/prompt-studio/prompt-card.tsx` | no | badge-variant map + clipboard handler; 1 mutation survived |
| `src/components/ui/button.tsx` | no | variant/size class maps; 1 mutation survived |
| `src/components/ui/badge.tsx` | no | variant class map |
| `src/components/ui/card.tsx` | no | 4 exported components |
| `src/components/layout/header.tsx` | no | — |
| `src/components/layout/footer.tsx` | no | — |
| `src/app/page.tsx` | no | — |
| `src/app/layout.tsx` | no | — |
| `scripts/gateway-watchdog/healthcheck.mjs` | **yes** | 30 tests / 71 expects, real DI + a real `node:http` server that never answers. **Best test file in the repo.** |
| `scripts/9router-tor/probe-403.mjs` | yes, but **untracked** | 26 tests / 40 expects; source + test both untracked (H8) |
| `scripts/gateway-watchdog/install.sh` | no | no tests; writes to `$HOME/Library/LaunchAgents` |
| `scripts/verify.sh` | no | no tests; the "4 checks" are self-asserted by `echo` |
| `scripts/smoke-test.sh` | no | no tests; orphaned (not called by `verify.sh` or any workflow) |
| `tests/test_opencode_compactor.cjs` | n/a | not collected; broken; foreign project (C1) |

**Ratio: of 13 `.ts`/`.tsx` files under `src/`, 2 have runtime tests (15%). Of 9 `.tsx`
component files, 0 do.** All 11 untested `.tsx` files are untestable as written,
because the logic lives inside components and the vitest environment is `"node"` with
no DOM setup.

---

## 7. Prioritized proposals

Ordered by *impact ÷ effort*. Each is a **proposal**, not an applied change.

### P0 — correctness and honesty (do first; small, low-risk, high-value)

| # | Change | Files | Effort | Fixes |
|---|---|---|---|---|
| P0-1 | Delete `tests/test_opencode_compactor.cjs`; add a guard so it cannot re-enter | 1 delete + 1 ignore/exclude | 1 min | C1 |
| P0-2 | Remove "0 linter issues" from `README.md:77` and the linter checkbox from `AGENTS.md:74`; decide the `"lint"` script's fate | 3 lines | 2 min | C3 |
| P0-3 | Replace "100% assertions" with the real test count in `verify.sh` | 1 line | 1 min | H15 |
| P0-4 | `cd "$(dirname "${BASH_SOURCE[0]}")/.."` at the top of `verify.sh`; fix the `rm -rf` scope | 2 lines | 2 min | H15 |
| P0-5 | Add `ok: true` to the health payload | 1 line + 1 test assertion | 5 min | H1 |
| P0-6 | `waitForHealthy`: use `options.timeoutMs` instead of the hardcoded `1000` | 1 line | 2 min | H2 |
| P0-7 | Don't null `downSince` in the cooldown/exhausted persist | 1 line | 2 min | H3 |
| P0-8 | `writeState`: pid-suffixed temp file + `O_EXCL` lock around the read-modify-write | ~6 lines | 15 min | H4 |
| P0-9 | Fix `smoke-test.sh`: `mktemp` + `trap`, `HTTP_CODE=… || HTTP_CODE=000`, `--max-time 5`, assert the body, don't `cat` a stale file on failure | ~6 lines | 10 min | M11-M14 |
| P0-10 | Watchdog: return non-zero on `restart-failed` / `exhausted`; route `--dry-run` logs away from the production log | ~4 lines | 5 min | M15, M16 |
| P0-11 | `probe-403.mjs`: validate `--samples`/`--concurrency` ≥ 1, throw on unknown flags, add `--help`, use `pathToFileURL` for the entry check | ~10 lines | 10 min | M19 |
| P0-12 | `probe-403.mjs`: redact bearer/`sk-` patterns from `bodyHead`; restrict the key-bearing requests to loopback hosts unless `--allow-remote` | ~8 lines | 10 min | H6, M20 |

### P1 — make the gates real (the systemic fix)

| # | Change | Files | Effort | Fixes |
|---|---|---|---|---|
| P1-1 | **Restructure the repo.** Move `scripts/gateway-watchdog/`, `scripts/9router-tor/`, `docs/plans/`, `tests/unit/9router-watchdog.test.ts`, `tests/unit/opencode-probe-403.test.ts` to a separate `9router-ops/` repo (or at minimum a `ops/` subdirectory excluded from the product's test glob). Keep the product's suite about the product. | git mv | 30 min | §2.2, H8, and it makes the product's test signal meaningful |
| P1-2 | Add `.github/workflows/ci.yml` — `setup-node` (pinned LTS) → `npm ci` → `npm run typecheck` → `npm test`. Add `"engines"` + `.nvmrc` | 2 new files | 20 min | H9, M21, L13 |
| P1-3 | Make the integration test real: export `INITIAL_PROMPTS`, assert on the actual dataset | 2 files, ~10 lines | 15 min | C2 |
| P1-4 | Extract `filterPrompts()` from `prompt-list.tsx` into `src/features/prompt-studio/filter.ts`; unit-test it in the existing `node` env | 1 new + 1 edited + 1 test | 25 min | H7 (2 surviving mutations) |
| P1-5 | Add coverage: `@vitest/coverage-v8` + `coverage: { include: ["src/**/*.{ts,tsx}"] }` + a `test:coverage` script; wire it into `verify.sh` | 3 files | 10 min | M3, H7 |
| P1-6 | Decide the lint story: add `eslint` + `eslint-config-next` + `@typescript-eslint/no-explicit-any` + `no-ban-ts-comment` **with explicit dependency approval**, plus a 5th `verify.sh` step — or keep the repo lint-free and say so | 3 files | 30 min | C3, H2 (§5) |
| P1-7 | A11y pass on `prompt-studio`: `sr-only` label + `id` on the search input; `aria-pressed` on the filter buttons; unique `aria-label` + `role="status"` on the copy button; `text-neutral-400` → `text-neutral-600`; a skip link in `layout.tsx` | 3 files, ~10 lines | 30 min | H10, M-items |
| P1-8 | Add `src/app/error.tsx` + `src/app/not-found.tsx`; add an `async headers()` security-header block to `next.config.mjs`; add `src/app/icon.svg` + `sitemap.ts` + `robots.ts` + `metadataBase`/`openGraph` | 6 files | 45 min | H16, L-items |
| P1-9 | Fix the clipboard no-op: surface a failure state instead of swallowing it | 1 file, ~5 lines | 10 min | H11 |
| P1-10 | `Button`: default `type="button"`; add `dark:focus-visible:ring-offset-neutral-900` | 1 file, 2 lines | 5 min | M24, L8 |
| P1-11 | `.gitignore`: add `.gstack/`, `.remember/`, `.claude/settings.local.json`, `*.log`, `.env.production`, `.env.development`, `.env.test` | 1 file, 7 lines | 2 min | M10 |
| P1-12 | Add `LICENSE` (MIT) and a `CHANGELOG.md`; add Dependabot's `npm` ecosystem config | 3 new files | 15 min | L12, L13, L14 |

### P2 — make the docs true (aids every future agent and user)

| # | Change | Files | Effort |
|---|---|---|---|
| P2-1 | `docs/ARCHITECTURE.md`: fix the 2 false mermaid edges, add `App --> Types` and the `components/layout` node, add an API-contract subsection | 1 file | 15 min |
| P2-2 | `README.md`: refresh the directory tree (+3 lines), correct the "rtk 20-40%" claim, correct the "production-ready" claim, correct the "0 linter issues" claim | 1 file | 15 min |
| P2-3 | `docs/tasks/backlog.md`: add the shipped watchdog, the Tor probe, and the 3 live P0/P1/P2 items from the baseline | 1 file | 10 min |
| P2-4 | `docs/specs/SPEC_TEMPLATE.md`: add root cause / non-goals / delete-list / lint check / clean-diff check / rollback | 1 file | 15 min |
| P2-5 | `AGENTS.md`: remove "(OmniRoute)", fix "5 phần" → 4, add a "read-only tasks" exemption to the subagent rule, align the RTK mandate with what `verify.sh` can do on a machine without `rtk` | 1 file | 15 min |
| P2-6 | Move `docs/plans/opencode-multilane-tor-controlport.md` (1309 lines, superseded) to `docs/decisions/` with its banner, and keep the 93-line baseline as a dated decision record | 2 file moves | 10 min |
| P2-7 | `src/app/page.tsx`: read the version badge from `package.json`; `health/route.ts`: same for `version` | 2 files | 10 min |
| P2-8 | Delete the unused `StatusState` export; drop the unused `React` default imports; delete `lucide-react` from `dependencies`; decide `jsdom` | 4 files | 10 min |
| P2-9 | `tsconfig.json`: add `"checkJs": true` + `"**/*.mjs"` to `include` | 1 file | 5 min |
| P2-10 | `globals.css`: wrap the `body` rule in `@layer base`; delete the dead `background`/`foreground` Tailwind mapping (or use the utilities) | 2 files | 5 min |
| P2-11 | `vitest.config.ts`: drop the dead `globals: true`; add `setupFiles` if a DOM environment is adopted | 1 file | 5 min |

### P3 — later, only if the product needs it

Streaming tokens + markdown preview (backlog Phase 2.3), persistence (Phase 2.2),
connecting to a live gateway (Phase 2.1), a real `loading.tsx` / `global-error.tsx`,
`typedRoutes`, log rotation for the watchdog, a systemd path for Linux.

**Deliberately NOT proposed:** a component library, a state-management library, a
repository/factory layer, a design system, `vitest-environment-jsdom` +
`@testing-library/react` (the zero-dependency `react-dom/server` route covers the need
today), a code-coverage percentage threshold, and any change to the 4-role TDD
workflow — that workflow is the repo's best asset, not a liability.

---

## 8. What is already good (28 items, verified)

1. **The "use client" boundary is disciplined.** Exactly 2 files carry it; both need
   `useState`. No accidental client components, no server-only API called from the client.
2. **Zero `any`, zero `@ts-ignore`, zero `@ts-expect-error`** across `src/`, `tests/`,
   `scripts/` — verified by grep, matching `CODE_STYLE.md:17`.
3. **Zero test tampering.** No `.only()`, `.skip()`, or `.todo(` anywhere. `AGENTS.md`
   Guardrail 2 is respected in practice.
4. **Dark mode is consistent** — Tailwind 3's default `media` strategy and the
   `@media (prefers-color-scheme: dark)` CSS-var flip agree. The classic
   class/media mismatch bug **is not present**.
5. **The `<main>` landmark is a real element**, and exactly one exists.
6. **Heading order is correct** (`h1 → h2 → h3`), no skipped levels.
7. **`key` props are stable and unique** — no index keys.
8. **`cn()` is used consistently** in all 3 UI primitives; no hand-rolled class
   concatenation, no conflicting utilities within a single `className`.
9. **No hydration-mismatch risk** — no `Date.now()`/`Math.random()` in any render path.
10. **`/api/health` is correctly dynamic** — the build route table shows `ƒ (Dynamic)`,
    and live curls show `uptimeSeconds` advancing (5 → 7). The explicit
    `Cache-Control: no-store` is right for Next 15.
11. **The response shape matches `ApiResponse<HealthCheckData>` exactly.**
12. **`tests/unit/9router-watchdog.test.ts` is genuinely excellent** — 30 tests / 71
    expects, dependency-injected `fetchImpl`/`sleep`/`runCommand`/`now`, a **real
    `node:http` server that never responds** to prove the timeout path, real `mkdtemp`
    state files with `afterEach` cleanup, and exact boundary assertions on cooldown,
    budget exhaustion and window pruning. This is the template the rest of the suite
    should follow.
13. **`tests/unit/utils.test.ts` is real** — it pins `tailwind-merge` conflict
    resolution, not just "returns a string". Mutation-verified.
14. **`tests/unit/health.test.ts` is real** — invokes the actual route handler and
    asserts status, payload, cache header and timestamp parseability. Mutation-verified.
15. **`tests/unit/opencode-probe-403.test.ts` has high test quality** — 26 tests over 9
    classification branches *including precedence rules*, injected fetch, null-header
    fallbacks. It only needs to be committed.
16. **The `.mjs` type-checking is real, not transpile-only** — proven by an A/B
    experiment (error TS2339 with the `@ts-check` pragma, silent without).
17. **Zero secrets** in tracked files, in all 117 git objects, or in `stash@{0}`.
    `.env.example` contains no real values.
18. **No shell interpolation of runtime values** — `execFileSync` with argv arrays, no
    `shell: true`.
19. **`--label` is regex-validated** and `parseArgs` **throws on unknown flags** — the
    one genuine injection surface is closed, and it has a test.
20. **`probeHealth()` validates the body, not just the status code** — a 200 carrying an
    HTML error page is rejected. This kills the "stray proxy returns 200" class of
    false-healthy.
21. **The healthy path is genuinely silent** — 1560 live launchd runs → 4 log lines, all
    incident-related. The README's claim is true.
22. **State writes are atomic** (same-directory tmp + `rename(2)`), and **a corrupt
    state file can never wedge the watchdog** — `readState` degrades to *more* restarts,
    never to *fewer*. Deliberate and documented in the code.
23. **The probe is genuinely read-only against the DB**, and `readOnly: true` was
    **verified enforced** by an actual write attempt.
24. **The credential never reaches a log sink** — the key is used only in outbound
    request headers.
25. **The `gateway-watchdog` directory name is a deliberate, documented, *tested***
    defence against 9router's `killAllAppProcesses()` — and there is a **regression
    test** pinning it (`expect(modulePath).not.toContain("/9router")`).
26. **The `GEMINI.md → AGENTS.md` symlink is real** (mode `120000`) — three agent
    surfaces wired to one rule set for near-zero cost.
27. **The tracked tree has zero junk** — 40 files, all legitimate. `.DS_Store` and
    `*.tsbuildinfo` are covered by repo-level rules.
28. **The 4-role workflow (Plan → Test → Code → Review) is a coherent, well-specified
    asset** and correctly scopes itself to code-modifying tasks. The safety guardrails
    (zero-hallucination, no-test-tampering, 3-attempt circuit breaker, dependency
    gatekeeping, command blacklist, no-hardcoded-secrets) are concrete, not platitudes.
    The `c538d51` commit message — explaining *why* the directory is named that way — is
    a model of a good message.

---

## 9. Honest assessment

**Is this project good?** The code quality is genuinely above average for a scaffold:
strict types, no `any`, disciplined client boundaries, a coherent layout, a strong
`AGENTS.md`, and one outstanding test file. It is not a bad project.

**Is it honest about itself?** No. It claims a lint gate, an integration suite, 100%
assertions, 20-40% token savings, "production-ready", and 5 chapters where there are
4 — and it enforces 4 of 20 of its own rules. For a repo whose *entire purpose* is to
be read by AI agents that will act on these documents as ground truth, that mismatch is
the most expensive defect in the project. An agent that follows `AGENTS.md` literally
will report success on checks that were never performed.

**The deepest structural issue** is that the repo's *test suite* and its *governance
documents* are both dominated by work that is not the product. 60 of 66 tests are for a
local gateway watchdog; the product's 9 component files have zero. The repo's most
detailed docs are about a Tor workstream that was explicitly stopped. The product is a
4-card prompt list with 14 source files, and it is the least-documented, least-tested
part of the tree.

**The three highest-leverage changes, in order:**

1. **Make the gates real** (P1-2 CI, P1-6 lint decision, P0-2/3 honesty edits). The
   repo's trust model depends on its signals being mechanical.
2. **Restructure the scope** (P1-1). Move the local-ops workstream out. That alone
   makes the product's test suite, documentation, and CI mean something.
3. **Close the two provable coverage holes** (P1-3 real integration test, P1-4 extract
   `filterPrompts`). Both are ~15 minutes, need no new dependency, and convert
   provably-vacuous tests into real ones.

Everything in P0 and P1 is a small, mechanical, low-risk change. Nothing in this
report requires a rewrite, a new framework, or a dependency the project does not
already have — with the single exception of ESLint, which is flagged for explicit
approval per `AGENTS.md` §3.4.

---

*Audit produced by 4 parallel read-only research agents + lead verification.
No tracked file was modified during this audit (`git diff --stat` empty at completion).
Every claim in §3 is backed by a command output shown above; every claim in §4 is
backed by a file:line citation that was independently re-read.*
