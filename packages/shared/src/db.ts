import { PrismaClient } from "@prisma/client";

// Single shared Prisma client — Node workers + Next.js both reuse one instance.
// On Next.js hot-reload, we stash it on globalThis so we don't leak connections.

declare global {
  // eslint-disable-next-line no-var
  var __caPrisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  globalThis.__caPrisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "production"
        ? ["error", "warn"]
        : ["error", "warn"],
  });

if (process.env.NODE_ENV !== "production") globalThis.__caPrisma = prisma;

export type { Prisma } from "@prisma/client";
export * from "@prisma/client";
