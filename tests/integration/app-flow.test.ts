import { describe, it, expect } from "vitest";
import type { PromptItem } from "@/features/prompt-studio/types";

describe("Prompt Studio Domain Flow", () => {
  const samplePrompt: PromptItem = {
    id: "test-prompt",
    title: "Test Vibe Coding",
    description: "Sample prompt description",
    category: "coding",
    template: "Write clean code without placeholders.",
    tags: ["test", "vibe"],
  };

  it("should conform to domain schema with required fields", () => {
    expect(samplePrompt.id).toBeDefined();
    expect(samplePrompt.title.length).toBeGreaterThan(0);
    expect(["coding", "architecture", "debugging", "refactor"]).toContain(
      samplePrompt.category
    );
    expect(Array.isArray(samplePrompt.tags)).toBe(true);
  });

  it("should have non-empty prompt template", () => {
    expect(samplePrompt.template.trim().length).toBeGreaterThan(0);
  });
});
