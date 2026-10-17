"use client";

import React, { useState, useMemo } from "react";
import type { PromptCategory, PromptItem } from "./types";
import { PromptCard } from "./prompt-card";
import { Button } from "@/components/ui/button";

const INITIAL_PROMPTS: PromptItem[] = [
  {
    id: "spec-first",
    title: "Spec-Driven Development",
    description: "Forces AI to write specification and list edge cases before touching any code.",
    category: "architecture",
    template: "/plan Read docs/specs/SPEC_TEMPLATE.md and create a feature spec with edge cases and binary criteria before implementing.",
    tags: ["spec", "planning", "tdd"],
  },
  {
    id: "ponytail-mode",
    title: "Ponytail Minimal Mode",
    description: "Enforces minimal blast radius, native standard library first, zero speculative abstractions.",
    category: "coding",
    template: "Implement this feature in Ponytail Mode: minimal blast radius, strict YAGNI, standard library first, zero speculative abstractions, zero TODO comments.",
    tags: ["minimal", "yagni", "clean-code"],
  },
  {
    id: "strict-tdd",
    title: "Strict TDD Bugfix Loop",
    description: "Write failing test first, run test to prove RED, then implement minimal code to reach GREEN.",
    category: "debugging",
    template: "Perform strict TDD: 1. Write a failing unit test in tests/. 2. Run it via rtk npm test (verify FAIL). 3. Fix code in src/. 4. Run test (verify PASS 100%).",
    tags: ["tdd", "vitest", "bugfix"],
  },
  {
    id: "refactor-taste",
    title: "Preserve Behavior Refactor",
    description: "Refactors code to simplify flow and improve readability while preserving 100% existing behavior.",
    category: "refactor",
    template: "Refactor this module according to CODE_STYLE.md: preserve behavior, flatten nested logic with guard clauses, single source of truth, 0 diff pollution.",
    tags: ["refactor", "guard-clauses", "house-style"],
  },
];

export function PromptList() {
  const [selectedCategory, setSelectedCategory] = useState<PromptCategory | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");

  const categories: Array<PromptCategory | "all"> = [
    "all",
    "coding",
    "architecture",
    "debugging",
    "refactor",
  ];

  const filteredPrompts = useMemo(() => {
    return INITIAL_PROMPTS.filter((prompt) => {
      const matchesCategory =
        selectedCategory === "all" || prompt.category === selectedCategory;
      const query = searchQuery.toLowerCase().trim();
      const matchesQuery =
        !query ||
        prompt.title.toLowerCase().includes(query) ||
        prompt.description.toLowerCase().includes(query) ||
        prompt.tags.some((tag) => tag.toLowerCase().includes(query));

      return matchesCategory && matchesQuery;
    });
  }, [selectedCategory, searchQuery]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
        {/* Category Filter */}
        <div className="flex flex-wrap gap-2">
          {categories.map((cat) => (
            <Button
              key={cat}
              size="sm"
              variant={selectedCategory === cat ? "primary" : "outline"}
              onClick={() => setSelectedCategory(cat)}
              className="capitalize"
            >
              {cat}
            </Button>
          ))}
        </div>

        {/* Search Input */}
        <div className="w-full sm:w-72">
          <input
            type="text"
            placeholder="Search prompts or tags..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full h-9 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 placeholder:text-neutral-400"
          />
        </div>
      </div>

      {/* Grid */}
      {filteredPrompts.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 dark:border-neutral-800 p-12 text-center text-sm text-neutral-500">
          No prompts matched your search query.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filteredPrompts.map((prompt) => (
            <PromptCard key={prompt.id} prompt={prompt} />
          ))}
        </div>
      )}
    </div>
  );
}
