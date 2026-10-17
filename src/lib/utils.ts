import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Combines Tailwind classes with clsx and resolves collisions with tailwind-merge.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Formats an ISO date string or timestamp into a readable date.
 */
export function formatDate(date: string | number | Date): string {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) {
    return "Invalid Date";
  }
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
