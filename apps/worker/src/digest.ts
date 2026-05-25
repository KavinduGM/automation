import { prisma, env, signApprovalToken, logger } from "@ca/shared";
import { sendEmail } from "@ca/providers";

// Sends one digest email listing every ContentItem in status=review.
// Each row gets a one-click signed approval link that bypasses login.

export async function runDigestNow(): Promise<{ to: string; count: number } | { skipped: true }> {
  const to = env().APPROVAL_DIGEST_TO;
  if (!to) {
    logger.warn("digest: APPROVAL_DIGEST_TO not set; skipping");
    return { skipped: true };
  }
  const pending = await prisma.contentItem.findMany({
    where: { status: "review" },
    include: { business: true },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  if (pending.length === 0) {
    logger.info("digest: nothing pending");
    return { to, count: 0 };
  }
  const baseUrl = env().DASHBOARD_URL.replace(/\/$/, "");
  const rows = pending.map((p) => {
    const approveTok = signApprovalToken({ a: "approve", id: p.id });
    const rejectTok  = signApprovalToken({ a: "reject",  id: p.id });
    const editUrl    = `${baseUrl}/content/${p.id}`;
    const approveUrl = `${baseUrl}/api/approve?t=${approveTok}`;
    const rejectUrl  = `${baseUrl}/api/approve?t=${rejectTok}`;
    return `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #eee">
          <div style="font-weight:600">${escapeHtml(p.title || "(untitled)")}</div>
          <div style="color:#666;font-size:12px">${p.business.name} · ${p.type}</div>
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee">
          <a href="${editUrl}">Review</a> ·
          <a href="${approveUrl}">Approve</a> ·
          <a href="${rejectUrl}" style="color:#c00">Reject</a>
        </td>
      </tr>`;
  }).join("");

  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:640px">
      <h2 style="margin:0 0 12px">Pending review (${pending.length})</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px">${rows}</table>
      <p style="color:#666;font-size:12px;margin-top:16px">
        Approve/reject links expire in 72 hours. Open the dashboard to edit before approving.
      </p>
    </div>`;

  await sendEmail({
    to,
    subject: `Content Automation: ${pending.length} item${pending.length === 1 ? "" : "s"} awaiting review`,
    html,
  });
  return { to, count: pending.length };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string),
  );
}
