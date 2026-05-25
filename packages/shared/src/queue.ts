import { Queue, QueueEvents, Worker, type ConnectionOptions, type Processor } from "bullmq";
import IORedis from "ioredis";
import { env } from "./env.js";

// Single Redis connection per process. BullMQ wants `maxRetriesPerRequest: null`.
let _conn: IORedis | null = null;
export function redis(): IORedis {
  if (_conn) return _conn;
  _conn = new IORedis(env().REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: true, // don't reach out until something actually issues a command
  });
  return _conn;
}

export const connection: ConnectionOptions = { connection: redis() } as unknown as ConnectionOptions;

// Queue names — keep this list canonical so producers + consumers agree.
export const QUEUES = {
  research:    "research",
  draft:       "draft",
  media:       "media",
  critique:    "critique",
  route:       "route",
  publish:     "publish",
  social:      "social",
  webinar:     "webinar",
  digest:      "digest",
  heygen_poll: "heygen_poll",   // self-rescheduling polling for HeyGen renders
  animate:     "animate",       // animated-webinar ffmpeg stitcher
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

const _queues = new Map<QueueName, Queue>();
export function queue(name: QueueName): Queue {
  let q = _queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: redis() });
    _queues.set(name, q);
  }
  return q;
}

export function spawnWorker<T = unknown, R = unknown>(
  name: QueueName,
  processor: Processor<T, R>,
  opts: { concurrency?: number } = {},
): Worker<T, R> {
  return new Worker<T, R>(name, processor, {
    connection: redis(),
    concurrency: opts.concurrency ?? env().WORKER_CONCURRENCY,
  });
}

export function events(name: QueueName): QueueEvents {
  return new QueueEvents(name, { connection: redis() });
}
