import { NextRequest, NextResponse } from "next/server";
import { prisma, queue, QUEUES } from "@ca/shared";
import { requireUser } from "@/lib/auth";

// Intake form endpoint — creates the ContentItem and CaseStudyIntake together,
// then kicks the pipeline.

export async function POST(req: NextRequest) {
  await requireUser();
  const body = (await req.json()) as {
    businessId: string;
    clientName: string;
    problem: string;
    solution: string;
    metric: string;
    quote?: string;
    quoteAuthor?: string;
  };
  if (!body.businessId || !body.clientName || !body.metric) {
    return NextResponse.json({ error: "businessId, clientName, metric required" }, { status: 400 });
  }
  const item = await prisma.contentItem.create({
    data: {
      businessId: body.businessId,
      type: "case_study",
      title: `${body.clientName}: ${body.metric}`,
      status: "queued",
    },
  });
  await prisma.caseStudyIntake.create({
    data: {
      contentItemId: item.id,
      clientName: body.clientName,
      problem: body.problem,
      solution: body.solution,
      metric: body.metric,
      quote: body.quote ?? null,
      quoteAuthor: body.quoteAuthor ?? null,
    },
  });
  await queue(QUEUES.draft).add(`case_study:${item.id}`, { contentItemId: item.id, type: "case_study" });
  return NextResponse.json({ id: item.id });
}
