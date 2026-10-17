export type PromptCategory = "coding" | "architecture" | "debugging" | "refactor";

export interface PromptItem {
  id: string;
  title: string;
  description: string;
  category: PromptCategory;
  template: string;
  tags: string[];
}
