import type { ContentType } from "@prisma/client";

// Shared message payloads between scheduler/dashboard (producers) and workers
// (consumers). Keeping them centralized avoids drift.

export interface ResearchJobData {
  businessId: string;
}

export interface PipelineJobData {
  contentItemId: string;
}

export interface CreateContentItemInput {
  businessId: string;
  type: ContentType;
  topicCandidateId?: string;
  // Optional seed — caller can pre-fill title/meta (used by manual triggers).
  seed?: {
    title?: string;
    meta?: Record<string, unknown>;
  };
}

export interface BrandVoice {
  tone?: string;
  audience?: string;
  persona?: string;
  dosAndDonts?: { dos: string[]; donts: string[] };
  readingLevel?: string;
  pointOfView?: "first" | "second" | "third";
  exampleHooks?: string[];
}
