import { prisma, Prompts, logger, brandSiteFor, isShortVideoDisabled, type Prisma } from "@ca/shared";
import { claude } from "@ca/providers";
import { bumpCost, logStep } from "./util.js";

// Expands a published blog into N short-video scripts using Claude.
// Stores each as a ShortVideoScript row in status "pending_review" so the
// admin can edit/regenerate/approve before render.
//
// Triggered automatically after blog publishes if the business has an
// active ShortVideoPlan with autoGenerate=true.

interface GeneratedScript {
  video_name: string;
  ratio: string;
  voice_profile: string;
  voice_speed: number;
  style: { description: string; colors: string[]; fonts: string[] };
  scenes: Array<{
    explainer: string;
    voiceover: string;
    transition_out: { type: string; duration: number };
  }>;
  _meta: {
    hook: string;
    title: string;
    description: string;
    hashtags: string[];
    tags: string[];
    suggestedSlotIdx: number;
  };
}

export async function runShortScriptsFromBlog(
  contentItemId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (isShortVideoDisabled()) {
    logger.info({ contentItemId }, "shortvideo.scripts.killed_by_env");
    throw new Error(
      "Short-video pipeline is disabled via SHORTVIDEO_DISABLED env var (safety lock). Unset it in Dokploy and redeploy to re-enable.",
    );
  }
  const item = await prisma.contentItem.findUnique({
    where: { id: contentItemId },
    include: { business: true },
  });
  if (!item || item.type !== "blog") {
    logger.info({ contentItemId, type: item?.type }, "shortvideo.skipped_not_blog");
    throw new Error(`Content item ${contentItemId} is not a blog (type=${item?.type ?? "missing"})`);
  }

  const plan = await prisma.shortVideoPlan.findUnique({ where: { businessId: item.businessId } });
  if (!plan) {
    logger.info({ contentItemId, businessId: item.businessId }, "shortvideo.skipped_no_plan");
    throw new Error(
      "No ShortVideoPlan configured for this business. Open the business page → Short-video plan section → fill it in.",
    );
  }
  // Auto-trigger only when autoGenerate is on. Manual triggers (force=true)
  // bypass the gate so an admin can always kick off generation by hand.
  if (!plan.autoGenerate && !opts.force) {
    logger.info({ contentItemId, businessId: item.businessId }, "shortvideo.skipped_autogen_off");
    throw new Error(
      "ShortVideoPlan.autoGenerate is OFF. Enable it on the business page, or click 'Generate scripts now' which forces a run.",
    );
  }

  // Skip if scripts already generated for this blog (idempotent re-run
  // safety). Manual triggers (force=true) bypass this.
  const existing = await prisma.shortVideoScript.count({ where: { contentItemId } });
  if (existing >= plan.scriptsPerBlog && !opts.force) {
    logger.info({ contentItemId, existing }, "shortvideo.skipped_already_generated");
    throw new Error(`Already have ${existing} script(s) for this blog. Use 'Regenerate' to replace them.`);
  }

  await logStep(contentItemId, "shortvideo_scripts", "started", {
    label: `Generate ${plan.scriptsPerBlog} short scripts`,
  });
  const t0 = Date.now();

  // Brand context for the prompt
  const brand = brandSiteFor(item.business.slug);
  const brandKit = await prisma.brandKit.findUnique({ where: { businessId: item.businessId } });
  const brandColors = brand?.coverImageStyle
    ? [brand.coverImageStyle.themeColor, brand.coverImageStyle.backgroundColor]
    : ["#6D28D9", "#FFFFFF"];
  const brandFonts = ["Inter", "Plus Jakarta Sans"];

  // Public URL for the blog — used in the YouTube description.
  const sourceUrl = brand && item.slug ? `${brand.domain}/blog/${item.slug}` : "";

  const voiceProfileName = plan.voiceName ?? `${item.business.slug}-voice`;

  try {
    const res = await claude<{ scripts: GeneratedScript[] }>({
      model: "writing",
      json: true,
      maxTokens: 8000,
      system: [{ text: Prompts.SHORT_VIDEO_SCRIPTS_SYSTEM, cache: true }],
      user: Prompts.shortVideoScriptsUser({
        blogTitle: item.title,
        blogBody: item.bodyMd,
        brandName: brand?.brandName ?? item.business.name,
        brandColors,
        brandFonts,
        voiceProfileName,
        scriptCount: plan.scriptsPerBlog,
        publishSlots: plan.publishSlots,
        sourceUrl,
      }),
    });
    await bumpCost(contentItemId, res.costUsd);
    const scripts = res.json?.scripts ?? [];
    if (scripts.length === 0) throw new Error("no scripts returned");

    // Persist each script as a row.
    for (const [i, s] of scripts.entries()) {
      const meta = s._meta ?? ({} as GeneratedScript["_meta"]);
      // Build scheduledPublishAt from the suggested slot, if plan has slots.
      const scheduledAt = computeNextSlotInstant(
        plan.publishSlots,
        plan.timezone,
        meta.suggestedSlotIdx ?? i,
        i, // offset days per script so a batch of 5 spreads across 5 days
      );
      const ord = i + 1;
      await prisma.shortVideoScript.upsert({
        where: { contentItemId_ord: { contentItemId, ord } },
        create: {
          contentItemId,
          businessId: item.businessId,
          ord,
          status: "pending_review",
          script: s as unknown as Prisma.InputJsonValue,
          title: meta.title ?? `${item.title} — Short ${ord}`,
          description: meta.description ?? "",
          hashtags: meta.hashtags ?? [],
          tags: meta.tags ?? [],
          scheduledPublishAt: scheduledAt,
          costUsd: i === 0 ? res.costUsd : 0, // attribute all cost to ord 1 to avoid double-counting
        },
        update: {
          script: s as unknown as Prisma.InputJsonValue,
          title: meta.title ?? `${item.title} — Short ${ord}`,
          description: meta.description ?? "",
          hashtags: meta.hashtags ?? [],
          tags: meta.tags ?? [],
          scheduledPublishAt: scheduledAt,
        },
      });
    }

    await logStep(contentItemId, "shortvideo_scripts", "completed", {
      label: `Generated ${scripts.length} short scripts`,
      durationMs: Date.now() - t0,
      metadata: { count: scripts.length, costUsd: res.costUsd },
    });
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    logger.error({ err, contentItemId }, "shortvideo.script_generation_failed");
    await logStep(contentItemId, "shortvideo_scripts", "failed", {
      label: "Script generation",
      message: msg,
      durationMs: Date.now() - t0,
    });
  }
}

// Compute the next wall-clock instant matching publishSlots[slotIdx], in UTC.
// dayOffset spreads a batch across multiple days so 5 shorts don't all queue
// for the same slot.
function computeNextSlotInstant(
  slots: string[],
  timezone: string,
  slotIdx: number,
  dayOffset: number,
): Date | null {
  if (!slots || slots.length === 0) return null;
  const safeIdx = ((slotIdx % slots.length) + slots.length) % slots.length;
  const slot = slots[safeIdx];
  if (!slot) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(slot.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);

  // Naive timezone conversion: ignore DST edge cases; the worker re-checks at
  // publish time and corrects via the existing slot resolver.
  const now = new Date();
  // Build target in UTC assuming the slot is in America/New_York (-05:00 / -04:00).
  // We use a rough offset of -4 hours which is correct for ~7 months of the year.
  // Real timezone math happens in the publish step via @ca/shared.scheduling.
  void timezone;
  const utc = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1 + dayOffset, // start tomorrow + offset
    hour + 4, // rough EDT offset
    minute,
  ));
  return utc;
}
