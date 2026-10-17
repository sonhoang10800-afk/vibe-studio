import { PromptList } from "@/features/prompt-studio/prompt-list";
import { Badge } from "@/components/ui/badge";

export default function Home() {
  return (
    <div className="container mx-auto max-w-6xl px-4 py-10 sm:px-6 space-y-12">
      {/* Hero Section */}
      <section className="space-y-4 text-center sm:text-left">
        <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2">
          <Badge variant="default">Next.js 15.2</Badge>
          <Badge variant="secondary">TypeScript 5.8 (Strict)</Badge>
          <Badge variant="success">Vibe Coding Ready</Badge>
        </div>

        <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight">
          Welcome to <span className="text-blue-600">Vibe Studio</span>
        </h1>
        <p className="max-w-2xl text-base sm:text-lg text-neutral-600 dark:text-neutral-400">
          A high-velocity, low-friction workspace engineered specifically for paired
          development with AI coding agents. Structured boundaries, zero bloat, and
          strict test-driven guardrails.
        </p>
      </section>

      {/* Feature Showcase: Prompt Studio */}
      <section className="space-y-6">
        <div className="border-b border-neutral-200 dark:border-neutral-800 pb-4">
          <h2 className="text-xl font-bold tracking-tight">Vibe Coding Prompt Library</h2>
          <p className="text-sm text-neutral-500">
            Battle-tested prompt patterns to steer Claude Code, Antigravity, and OpenCode with high taste and zero hallucinations.
          </p>
        </div>

        <PromptList />
      </section>
    </div>
  );
}
