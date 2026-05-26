import clsx from "clsx";
import type { ContentStatus } from "@prisma/client";

const colors: Record<ContentStatus, string> = {
  queued:           "bg-gray-100 text-gray-700",
  researching:      "bg-yellow-100 text-yellow-800",
  drafting:         "bg-yellow-100 text-yellow-800",
  generating_media: "bg-yellow-100 text-yellow-800",
  self_critique:    "bg-blue-100 text-blue-800",
  review:           "bg-orange-100 text-orange-800",
  approved:         "bg-green-100 text-green-800",
  scheduled:        "bg-indigo-100 text-indigo-800",
  publishing:       "bg-blue-100 text-blue-800",
  published:        "bg-emerald-100 text-emerald-800",
  rejected:         "bg-red-100 text-red-700",
  failed:           "bg-red-100 text-red-700",
  cancelled:        "bg-gray-100 text-gray-500",
};

export function StatusBadge({ status }: { status: ContentStatus }) {
  return <span className={clsx("badge", colors[status])}>{status}</span>;
}
