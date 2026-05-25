import { z } from "zod";

// Parse + freeze environment once. Importing modules get a typed object.
// Optional vars are kept loose because the same env is shared by dashboard /
// worker / scheduler — each process only needs a subset.

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  TZ: z.string().default("UTC"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  DASHBOARD_URL: z.string().url().default("http://localhost:3000"),
  DASHBOARD_PORT: z.coerce.number().default(3000),

  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  SESSION_SECRET: z.string().min(32).optional(),
  TOKEN_ENCRYPTION_KEY: z.string().length(64).optional(), // hex (32 bytes)
  ALLOWED_LOGIN_EMAILS: z.string().default(""),

  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM: z.string().default("Content Automation <noreply@example.com>"),
  APPROVAL_DIGEST_TO: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL_WRITING: z.string().default("claude-sonnet-4-6"),
  ANTHROPIC_MODEL_ROUTING: z.string().default("claude-haiku-4-5"),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_IMAGE_MODEL: z.string().default("gpt-image-1"),

  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_DEFAULT_VOICE_ID: z.string().optional(),

  HEYGEN_API_KEY: z.string().optional(),
  HEYGEN_DEFAULT_AVATAR_ID: z.string().optional(),
  HEYGEN_DEFAULT_VOICE_ID: z.string().optional(),

  CANVA_API_KEY: z.string().optional(),

  BUFFER_ACCESS_TOKEN: z.string().optional(),

  GROK_API_KEY: z.string().optional(),
  REDDIT_CLIENT_ID: z.string().optional(),
  REDDIT_CLIENT_SECRET: z.string().optional(),
  REDDIT_USER_AGENT: z.string().default("content-automation/0.1"),

  YT_AUTOMATION_API_URL: z.string().optional(),
  YT_AUTOMATION_API_TOKEN: z.string().optional(),

  ASSETS_DIR: z.string().default("/app/assets"),
  TMP_DIR: z.string().default("/app/tmp"),

  B2_KEY_ID: z.string().optional(),
  B2_APPLICATION_KEY: z.string().optional(),
  B2_BUCKET: z.string().optional(),
  B2_ENDPOINT: z.string().optional(),

  WORKER_CONCURRENCY: z.coerce.number().default(4),
  SCHEDULER_TICK_SECONDS: z.coerce.number().default(60),
  RESEARCH_CRON: z.string().default("0 4 * * *"),
  DIGEST_CRON: z.string().default("0 9,13,17 * * *"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

// During `next build` the routes are imported just to read their config
// (dynamic flag, revalidate, etc.). The actual env isn't available then, so
// we fall back to a permissive default — the values are never used because
// no request handlers run during build.
function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build" || process.env.CA_SKIP_ENV === "1";
}

export function env(): Env {
  if (cached) return cached;
  const source = { ...process.env };
  if (isBuildPhase() && !source.DATABASE_URL) {
    source.DATABASE_URL = "postgresql://build:build@localhost:5432/build";
  }
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    if (isBuildPhase()) {
      // Should never happen given the fallback above, but stay quiet at build.
      cached = Object.freeze({ ...schema.parse({ DATABASE_URL: "postgresql://build:build@localhost:5432/build" }) });
      return cached;
    }
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  cached = Object.freeze(parsed.data);
  return cached;
}

export function allowedLoginEmails(): string[] {
  return env()
    .ALLOWED_LOGIN_EMAILS.split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}
