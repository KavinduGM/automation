// Fastify HTTP API for the video renderer service.
//
//   POST /render
//     body: { spec, voiceId, voiceModelId?, visualReviewMaxAttempts?, outputDir? }
//     headers: X-Renderer-Token (must match RENDERER_AUTH_TOKEN env)
//     returns: { videoPath, thumbnailPath, totalDurationSeconds, costUsdBreakdown }
//
//   GET /healthz
//     returns: { ok: true } once env vars are present
//
// All work is synchronous within one request. The worker on the main
// automation tool queues renders one at a time (concurrency 1) and runs
// them only during the off-hours window — see app/worker shortvideo_render handler.

import Fastify from 'fastify'
import { renderScript } from './render.js'
import { parseScript } from './pipeline/parser.js'
import path from 'node:path'
import fs from 'node:fs'

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  bodyLimit: 5 * 1024 * 1024, // 5 MB — script + meta only, no binaries
})

const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY ?? ''
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? ''
const AUTH_TOKEN = process.env.RENDERER_AUTH_TOKEN ?? ''
const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL_WRITING ?? 'claude-sonnet-4-6'
const HYPERFRAMES_CMD = process.env.HYPERFRAMES_COMMAND ?? 'npx hyperframes'
const ASSETS_DIR = process.env.ASSETS_DIR ?? '/app/assets'

app.get('/healthz', async () => {
  return {
    ok: !!ELEVEN_KEY && !!ANTHROPIC_KEY,
    envChecks: {
      elevenLabs: !!ELEVEN_KEY,
      anthropic: !!ANTHROPIC_KEY,
      authToken: !!AUTH_TOKEN,
    },
  }
})

app.post('/render', async (request, reply) => {
  if (AUTH_TOKEN) {
    const provided = request.headers['x-renderer-token']
    if (provided !== AUTH_TOKEN) {
      reply.code(401).send({ error: 'unauthorized' })
      return
    }
  }
  if (!ELEVEN_KEY || !ANTHROPIC_KEY) {
    reply.code(500).send({ error: 'renderer missing ELEVENLABS_API_KEY or ANTHROPIC_API_KEY' })
    return
  }

  const body = request.body as {
    spec: unknown
    voiceId: string
    voiceModelId?: string
    visualReviewMaxAttempts?: number
    outputDir?: string
  }
  if (!body?.spec || !body?.voiceId) {
    reply.code(400).send({ error: 'spec and voiceId are required' })
    return
  }

  // Validate the spec via the ported AI Video Creator parser.
  let spec
  try {
    spec = parseScript(body.spec)
  } catch (err) {
    reply.code(400).send({ error: `invalid spec: ${(err as Error).message}` })
    return
  }

  // Decide work dir. If outputDir is set, write into ASSETS_DIR/<outputDir>
  // so the result is visible to the rest of the stack via the shared volume.
  const workDir = body.outputDir
    ? path.join(ASSETS_DIR, body.outputDir)
    : undefined

  try {
    const result = await renderScript({
      spec,
      elevenLabsApiKey: ELEVEN_KEY,
      voiceId: body.voiceId,
      voiceModelId: body.voiceModelId,
      anthropicApiKey: ANTHROPIC_KEY,
      claudeModel: CLAUDE_MODEL,
      hyperframesCommand: HYPERFRAMES_CMD,
      workDir,
      visualReviewMaxAttempts: body.visualReviewMaxAttempts ?? 2,
      onLog: (line) => request.log.info(line),
    })

    // Return paths relative to ASSETS_DIR when they live inside it (so the
    // dashboard's assetUrl helper can resolve them). Otherwise return absolute.
    const relVideo = result.videoPath.startsWith(ASSETS_DIR)
      ? result.videoPath.slice(ASSETS_DIR.length).replace(/^\/+/, '')
      : result.videoPath
    const relThumb = result.thumbnailPath.startsWith(ASSETS_DIR)
      ? result.thumbnailPath.slice(ASSETS_DIR.length).replace(/^\/+/, '')
      : result.thumbnailPath

    return {
      ok: true,
      videoPath: relVideo,
      thumbnailPath: fs.existsSync(result.thumbnailPath) ? relThumb : null,
      totalDurationSeconds: result.totalDurationSeconds,
      costUsdBreakdown: result.costUsdBreakdown,
      sceneNotes: result.perSceneLogs,
    }
  } catch (err) {
    request.log.error({ err }, 'render failed')
    reply.code(500).send({ error: (err as Error).message ?? String(err) })
  }
})

const PORT = Number(process.env.PORT ?? 4100)
app.listen({ host: '0.0.0.0', port: PORT }).catch((err) => {
  app.log.error(err)
  process.exit(1)
})
