"use client";

import React, { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { PromptItem } from "./types";

interface PromptCardProps {
  prompt: PromptItem;
}

export function PromptCard({ prompt }: PromptCardProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(prompt.template);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback if clipboard API is not available
      setCopied(false);
    }
  };

  const categoryBadgeVariant: Record<
    PromptItem["category"],
    "default" | "secondary" | "success" | "outline"
  > = {
    coding: "default",
    architecture: "secondary",
    debugging: "outline",
    refactor: "success",
  };

  return (
    <Card className="flex flex-col justify-between transition-shadow hover:shadow-md">
      <CardHeader>
        <div className="flex items-center justify-between gap-2 mb-1">
          <Badge variant={categoryBadgeVariant[prompt.category]}>
            {prompt.category}
          </Badge>
          <span className="text-xs text-neutral-400 font-mono">#{prompt.id}</span>
        </div>
        <CardTitle>{prompt.title}</CardTitle>
        <p className="text-sm text-neutral-500 mt-1">{prompt.description}</p>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="rounded bg-neutral-100 dark:bg-neutral-800/80 p-3 text-xs font-mono text-neutral-800 dark:text-neutral-200 overflow-x-auto whitespace-pre-wrap max-h-32">
          {prompt.template}
        </div>

        <div className="flex items-center justify-between pt-2">
          <div className="flex flex-wrap gap-1">
            {prompt.tags.map((tag) => (
              <span
                key={tag}
                className="text-[10px] text-neutral-400 bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 rounded"
              >
                #{tag}
              </span>
            ))}
          </div>
          <Button
            size="sm"
            variant={copied ? "secondary" : "outline"}
            onClick={handleCopy}
          >
            {copied ? "Copied!" : "Copy"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
