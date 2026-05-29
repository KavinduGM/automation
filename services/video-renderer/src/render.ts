// Slim orchestrator. Re-implements the parts of runner.ts we actually need
// without the Electron settings store, IPC bridge, or SQLite job queue.
//
// Inputs: one ScriptSpec + voiceId + Anthropic key. Outputs: an MP4 path.
//
// Pipeline per scene:
//   1. ElevenLabs TTS → audio file → ffprobe duration
//   2. Claude HTML generation (with visual review feedback loop, max 2 retries)
//   3. Hyperframes render → scene MP4 (silent)
//   4. ffmpeg mux audio onto scene
// After all scenes done:
//   5. ffmpeg concat with the requested transitions
//   6. Generate thumbnail from frame 0 of the first scene

import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { dimensionsForRatio } from './pipeline/parser.js'
import type { ScriptSpec, SceneSpec } from './types.js'
import { generateAudio } from './pipeline/tts.js'
import { generateSceneHtml, reviewScene } from './pipeline/claude.js'
import { scaffoldProject, renderHyperframes } from './pipeline/hyperframes.js'
import {
  muxAudioWithVideo,
  concatScenesWithTransitions,
  probeDurationSeconds,
  extractFrame,
} from './pipeline/ffmpeg.js'

export interface RenderJobInput {
  spec: ScriptSpec
  elevenLabsApiKey: string
  voiceId: string
  voiceModelId?: string         // default eleven_flash_v2_5
  anthropicApiKey: string
  claudeModel?: string          // default claude-sonnet-4-6
  hyperframesCommand?: string   // default "npx hyperframes"
  workDir?: string              // default OS tmp + uuid
  visualReviewMaxAttempts?: number // default 2 (0 = skip review)
  onLog?: (line: string) => void
}

export interface RenderJobOutput {
  videoPath: string
  thumbnailPath: string
  totalDurationSeconds: number
  costUsdBreakdown: {
    tts: number
    claudeHtml: number
    visualReview: number
    total: number
  }
  perSceneLogs: string[]
}

export async function renderScript(input: RenderJobInput): Promise<RenderJobOutput> {
  const work = input.workDir ?? path.join(tmpdir(), `vr-${randomUUID()}`)
  await fs.promises.mkdir(work, { recursive: true })

  const log = (line: string) => {
    input.onLog?.(line)
  }

  const { width, height } = dimensionsForRatio(input.spec.ratio)

  let ttsCostUsd = 0
  let claudeCostUsd = 0
  let visualReviewCostUsd = 0
  const sceneFiles: Array<{
    finalSceneMp4: string
    durationSeconds: number
    transitionOutTo: SceneSpec['transition_out']
  }> = []
  const perSceneLogs: string[] = []

  for (let i = 0; i < input.spec.scenes.length; i += 1) {
    const scene = input.spec.scenes[i]
    const sceneDir = path.join(work, `scene_${i + 1}`)
    await fs.promises.mkdir(sceneDir, { recursive: true })
    log(`[scene ${i + 1}/${input.spec.scenes.length}] start`)

    // 1. TTS
    const audioPath = path.join(sceneDir, 'voice.mp3')
    const tts = await generateAudio({
      apiKey: input.elevenLabsApiKey,
      voiceId: input.voiceId,
      modelId: input.voiceModelId,
      text: scene.voiceover,
      outAudioPath: audioPath,
      speed: input.spec.voice_speed,
    })
    ttsCostUsd += tts.costUsd
    // Use real audio duration (more accurate than the chars heuristic).
    let realDuration = tts.durationSeconds
    try {
      realDuration = Math.max(1, Math.ceil(await probeDurationSeconds(audioPath)))
    } catch {
      /* fall back to estimate */
    }
    log(`[scene ${i + 1}] tts ok — ${realDuration}s audio, $${tts.costUsd.toFixed(4)}`)

    // 2. Claude HTML generation with visual-review loop
    let html = ''
    let visualFeedback: string[] = []
    const maxAttempts = input.visualReviewMaxAttempts ?? 2
    const attemptsBudget = Math.max(1, maxAttempts + 1)
    let attempt = 0
    let rawMp4 = ''
    let lastReviewIssues: string[] = []
    while (attempt < attemptsBudget) {
      attempt += 1
      log(`[scene ${i + 1}] claude html (attempt ${attempt}/${attemptsBudget})${visualFeedback.length ? ` with ${visualFeedback.length} review issue(s)` : ''}`)
      const htmlRes = await generateSceneHtml({
        apiKey: input.anthropicApiKey,
        model: input.claudeModel ?? 'claude-sonnet-4-6',
        ratio: input.spec.ratio,
        durationSeconds: realDuration,
        sceneIndex: i,
        totalScenes: input.spec.scenes.length,
        explainer: scene.explainer,
        voiceover: scene.voiceover,
        style: input.spec.style,
        visualFeedback,
      })
      html = htmlRes.html
      claudeCostUsd += htmlRes.costUsd

      // 3. Hyperframes render
      const projectDir = path.join(sceneDir, `attempt_${attempt}`)
      await scaffoldProject(projectDir, html)
      rawMp4 = path.join(sceneDir, `scene_attempt_${attempt}.mp4`)
      await renderHyperframes({
        command: input.hyperframesCommand ?? 'npx hyperframes',
        projectDir,
        outputMp4: rawMp4,
        onLog: log,
      })
      log(`[scene ${i + 1}] hyperframes ok`)

      // Skip review if budget is exhausted or disabled.
      if (maxAttempts === 0 || attempt >= attemptsBudget) break

      // 4. Visual review — extract frame, ask Claude vision
      try {
        const framePath = path.join(sceneDir, `review_attempt_${attempt}.jpg`)
        await extractFrame({
          videoIn: rawMp4,
          atSeconds: Math.min(1.5, realDuration * 0.5),
          out: framePath,
          quality: 3,
        })
        const review = await reviewScene({
          apiKey: input.anthropicApiKey,
          model: input.claudeModel ?? 'claude-sonnet-4-6',
          framePath,
          explainer: scene.explainer,
          voiceover: scene.voiceover,
          ratio: input.spec.ratio,
        })
        visualReviewCostUsd += review.costUsd
        lastReviewIssues = review.issues ?? []
        if (review.pass) {
          log(`[scene ${i + 1}] visual review passed`)
          break
        }
        visualFeedback = lastReviewIssues
        log(`[scene ${i + 1}] visual review found ${lastReviewIssues.length} issue(s) — retrying`)
      } catch (err) {
        log(`[scene ${i + 1}] visual review skipped (${(err as Error).message})`)
        break
      }
    }
    if (lastReviewIssues.length > 0) {
      perSceneLogs.push(`Scene ${i + 1}: rendered with ${lastReviewIssues.length} unresolved review issue(s): ${lastReviewIssues.slice(0, 3).join(' | ')}`)
    }

    // 5. Mux audio onto rendered scene
    const finalSceneMp4 = path.join(sceneDir, `scene_${i + 1}_final.mp4`)
    await muxAudioWithVideo({
      videoIn: rawMp4,
      audioIn: audioPath,
      out: finalSceneMp4,
      durationSeconds: realDuration,
    })
    log(`[scene ${i + 1}] audio muxed`)

    sceneFiles.push({
      finalSceneMp4,
      durationSeconds: realDuration,
      transitionOutTo: scene.transition_out,
    })
  }

  // 6. Concat scenes with transitions
  const outputMp4 = path.join(work, `${input.spec.video_name}.mp4`)
  await concatScenesWithTransitions({
    scenes: sceneFiles.map((s) => ({
      videoPath: s.finalSceneMp4,
      durationSeconds: s.durationSeconds,
      transitionOut: s.transitionOutTo,
    })),
    out: outputMp4,
    width,
    height,
  })

  // 7. Thumbnail — frame at 0.5s of the first scene
  const thumbnailPath = path.join(work, `${input.spec.video_name}.jpg`)
  try {
    await extractFrame({
      videoIn: sceneFiles[0]!.finalSceneMp4,
      atSeconds: 0.5,
      out: thumbnailPath,
      quality: 2,
    })
  } catch {
    /* thumbnail is non-fatal */
  }

  const total = sceneFiles.reduce((s, x) => s + x.durationSeconds, 0)
  return {
    videoPath: outputMp4,
    thumbnailPath,
    totalDurationSeconds: total,
    costUsdBreakdown: {
      tts: ttsCostUsd,
      claudeHtml: claudeCostUsd,
      visualReview: visualReviewCostUsd,
      total: ttsCostUsd + claudeCostUsd + visualReviewCostUsd,
    },
    perSceneLogs,
  }
}
