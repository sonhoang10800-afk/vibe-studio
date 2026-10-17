import React from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";

export function Header() {
  return (
    <header className="sticky top-0 z-40 w-full border-b border-neutral-200 dark:border-neutral-800 bg-white/80 dark:bg-neutral-900/80 backdrop-blur-md">
      <div className="container mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2 font-bold text-lg tracking-tight">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600 text-white text-xs font-black">
              V
            </span>
            <span>Vibe Studio</span>
          </Link>
          <Badge variant="success">Online</Badge>
        </div>

        <nav className="flex items-center gap-6 text-sm font-medium text-neutral-600 dark:text-neutral-400">
          <Link
            href="/"
            className="transition-colors hover:text-neutral-950 dark:hover:text-neutral-100"
          >
            Studio
          </Link>
          <Link
            href="/api/health"
            className="transition-colors hover:text-neutral-950 dark:hover:text-neutral-100"
            target="_blank"
          >
            Health API
          </Link>
          <a
            href="https://github.com"
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-neutral-950 dark:hover:text-neutral-100"
          >
            Docs
          </a>
        </nav>
      </div>
    </header>
  );
}
