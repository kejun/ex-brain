export type PageType =
  | "person"
  | "company"
  | "deal"
  | "yc"
  | "civic"
  | "project"
  | "note"
  | "other";

export interface PageRecord {
  slug: string;
  type: PageType | string;
  title: string;
  compiledTruth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TimelineEntry {
  id?: number;
  pageSlug: string;
  date: string;
  source: string;
  summary: string;
  detail: string;
  importance?: number;
}

export interface SearchHit {
  slug: string;
  title: string;
  type: string;
  score: number;
  excerpt?: string;
  updatedAt?: string;
}

export interface BrainStats {
  pages: number;
  links: number;
  tags: number;
  timelineEntries: number;
  rawRows: number;
}

export interface PutPageInput {
  slug: string;
  type: string;
  title: string;
  compiledTruth: string;
  timeline?: string;
  frontmatter?: Record<string, unknown>;
}
