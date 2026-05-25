import { env, logger } from "@ca/shared";

// Stub: Canva Connect API for autofilling brand templates.
// The real product requires per-app OAuth — wire when you supply CANVA_API_KEY +
// per-business connected accounts. For v1 this is optional; calls throw a
// helpful error when unconfigured so pipelines can skip Canva gracefully.

export interface CanvaAutofillInput {
  templateId: string;
  data: Record<string, string>;
}

export interface CanvaAutofillResult {
  exportUrl: string;
}

export async function autofillTemplate(_input: CanvaAutofillInput): Promise<CanvaAutofillResult> {
  if (!env().CANVA_API_KEY) {
    throw new Error("canva: CANVA_API_KEY not configured; skip or set it");
  }
  logger.warn("canva.autofill: stub — implement when Canva integration is needed");
  throw new Error("canva.autofill: not implemented");
}
