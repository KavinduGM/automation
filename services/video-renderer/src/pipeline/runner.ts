import fs from 'node:fs'
import path from 'node:path'
import type { Job, JobLogEntry } from '../types.js'
import { parseScript, dimensionsForRatio } from './parser'
import { generateSceneHtml, reviewScene } from './claude'
import { generateAudio } from './tts'
import { scaffoldProject, renderHyperframes } from './hyperframes'
import {
  concatScenesWithTransitions,
  extractFrame,
  muxAudioWithVideo,
  probeDurationSeconds,
  ensureDir
} from './ffmpeg'
import { getSettings, findProfileByName, getStoragePaths } from '../settings'

const MAX_VISUAL_REVIEW_ATTEMPTS = 3

export interface RunnerHandle {
  cancel(): void
}

export interface RunnerCallbacks {
  onProgress(progress: number, step: string): void
  onLog(entry: JobLogEntry): void
}

export async function runJob(job: Job, cb: RunnerCallbacks, handle: { cancelled: boolean }): Promise<string> {
  const settings = getSettings()
  if (!settings.anthropic_api_key) throw new Error('Anthropic API key is missing in Settings.')
  if (!settings.tts_base_url || !settings.tts_api_key) {
    throw new Error('TTS base URL or API key is missing in Settings.')
  }

  const spec = parseScript(job.script_yaml)

  const profile = findProfileByName(spec.voice_profile)
  if (!profile) {
    throw new Error(`Voice profile "${spec.voice_profile}" not found. Add it in the Voice Profiles tab.`)
  }

  const dims = dimensionsForRatio(spec.ratio)

  const { workspace } = getStoragePaths()
  const jobWorkDir = path.join(workspace, job.id)
  ensureDir(jobWorkDir)

  const sceneResults: {
    finalMp4: string
    durationSeconds: number
    transition_out: (typeof spec.scenes)[number]['transition_out']
  }[] = []

  const totalScenes = spec.scenes.length
  // Roughly: 60% scenes (split equally), 30% concat, 10% finalize.
  const sceneShare = 0.6 / totalScenes

  // Each scene gets a 1-second tail: the final video frame is held still
  // and the audio is padded with silence. Gives every scene a clean breath
  // before the next one begins (and a clean ending on the very last one).
  const SCENE_TAIL_SECONDS = 1.0

  for (let i = 0; i < spec.scenes.length; i++) {
    if (handle.cancelled) throw new Error('Cancelled')
    const scene = spec.scenes[i]
    const sceneDir = path.join(jobWorkDir, `scene_${i + 1}`)
    ensureDir(sceneDir)
    const baseProgress = i * sceneShare

    cb.onProgress(baseProgress + sceneShare * 0.0, `Scene ${i + 1}/${totalScenes}: generating audio`)
    cb.onLog(info(`Scene ${i + 1}: generating audio (voice=${profile.name})`))
    const audioFmt = profile.default_format ?? 'mp3'
    const audioPath = path.join(sceneDir, `audio.${audioFmt}`)
    await generateAudio(
      { baseUrl: settings.tts_base_url, apiKey: settings.tts_api_key },
      {
        text: scene.voiceover,
        profile,
        speedOverride: spec.voice_speed,
        outPath: audioPath
      }
    )

    const audioDuration = await probeDurationSeconds(audioPath)
    cb.onLog(info(`Scene ${i + 1}: audio is ${audioDuration.toFixed(2)}s`))
    if (handle.cancelled) throw new Error('Cancelled')

    // ---------- Generate → render → visual-review loop ----------
    // Up to MAX_VISUAL_REVIEW_ATTEMPTS times, generate HTML, render via
    // Hyperframes, extract a representative frame, and ask Claude (with
    // vision) to verify the frame matches the explainer. On failure, the
    // reviewer's issues feed into the next HTML attempt.
    const rawMp4 = path.join(sceneDir, 'render.mp4')
    const projectDir = path.join(sceneDir, 'hyperframes')
    let html = ''
    let visualFeedback: string[] = []
    let reviewPassed = false
    let lastReviewIssues: string[] = []
    let visualAttempt = 0

    while (visualAttempt < MAX_VISUAL_REVIEW_ATTEMPTS) {
      visualAttempt++
      const tag = `Scene ${i + 1} attempt ${visualAttempt}/${MAX_VISUAL_REVIEW_ATTEMPTS}`

      cb.onProgress(
        baseProgress + sceneShare * 0.2,
        `${tag}: composing HTML with Claude`
      )
      cb.onLog(info(`${tag}: asking Claude (${settings.claude_model}) for HTML${visualFeedback.length ? ` with ${visualFeedback.length} reviewer issue(s) to fix` : ''}`))
      const claudeResult = await generateSceneHtml({
        apiKey: settings.anthropic_api_key,
        model: settings.claude_model,
        ratio: spec.ratio,
        durationSeconds: audioDuration,
        sceneIndex: i,
        totalScenes,
        explainer: scene.explainer,
        voiceover: scene.voiceover,
        style: spec.style,
        visualFeedback: visualFeedback.length ? visualFeedback : undefined
      })
      html = claudeResult.html
      for (const line of claudeResult.validationLog) cb.onLog(info(`${tag}: ${line}`))
      if (claudeResult.validationStatus === 'failed-after-retries') {
        cb.onLog({
          ts: Date.now(),
          level: 'warn',
          message: `${tag}: animation-coverage validation failed after ${claudeResult.attempts} HTML attempts — proceeding with the best output.`
        })
      }
      if (claudeResult.sanitized.length > 0) {
        cb.onLog(info(`${tag}: sanitized ${claudeResult.sanitized.length} looping construct(s):`))
        for (const note of claudeResult.sanitized) cb.onLog(info(`  - ${note}`))
      }

      // Render the HTML
      await scaffoldProject(projectDir, html)
      if (handle.cancelled) throw new Error('Cancelled')

      cb.onProgress(
        baseProgress + sceneShare * 0.4,
        `${tag}: rendering with Hyperframes`
      )
      await renderHyperframes({
        command: settings.hyperframes_command,
        projectDir,
        outputMp4: rawMp4,
        onLog: (line) => cb.onLog(info(`hyperframes: ${line}`))
      })
      if (handle.cancelled) throw new Error('Cancelled')

      // Render duration sanity check (informational only — doesn't trigger retry on its own)
      try {
        const renderDuration = await probeDurationSeconds(rawMp4)
        const diff = renderDuration - audioDuration
        if (Math.abs(diff) > 0.5) {
          cb.onLog(info(
            `${tag}: WARNING — Hyperframes rendered ${renderDuration.toFixed(2)}s, audio is ${audioDuration.toFixed(2)}s (diff ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}s).`
          ))
        } else {
          cb.onLog(info(`${tag}: render duration ${renderDuration.toFixed(2)}s matches audio (${audioDuration.toFixed(2)}s) ✓`))
        }
      } catch (err: any) {
        cb.onLog(info(`${tag}: could not probe render duration — ${err.message}`))
      }

      // Extract the final frame for visual review
      cb.onProgress(
        baseProgress + sceneShare * 0.6,
        `${tag}: visual review (frame extraction)`
      )
      const reviewFramePath = path.join(sceneDir, `review_attempt_${visualAttempt}.jpg`)
      const grabAt = Math.max(0.1, audioDuration - 0.3)
      try {
        await extractFrame(
          { videoIn: rawMp4, atSeconds: grabAt, out: reviewFramePath, quality: 3 },
          (line) => cb.onLog(info(`ffmpeg: ${line}`))
        )
      } catch (err: any) {
        cb.onLog({
          ts: Date.now(),
          level: 'warn',
          message: `${tag}: frame extraction failed (${err.message}) — skipping visual review for this attempt.`
        })
        // Treat as pass so we proceed; no point retrying without a frame to compare.
        reviewPassed = true
        lastReviewIssues = []
        break
      }

      cb.onProgress(
        baseProgress + sceneShare * 0.65,
        `${tag}: visual review (Claude vision)`
      )
      cb.onLog(info(`${tag}: visual review — comparing rendered frame to explainer`))
      let review
      try {
        review = await reviewScene({
          apiKey: settings.anthropic_api_key,
          model: settings.claude_model,
          framePath: reviewFramePath,
          explainer: scene.explainer,
          ratio: spec.ratio
        })
      } catch (err: any) {
        cb.onLog({
          ts: Date.now(),
          level: 'warn',
          message: `${tag}: visual review call failed (${err.message}) — accepting the render and moving on.`
        })
        reviewPassed = true
        lastReviewIssues = []
        break
      }

      lastReviewIssues = review.issues
      if (review.pass) {
        cb.onLog(info(`${tag}: visual review PASSED ✓`))
        reviewPassed = true
        break
      }

      cb.onLog({
        ts: Date.now(),
        level: 'warn',
        message: `${tag}: visual review FAILED — ${review.issues.length} issue(s):`
      })
      for (const issue of review.issues) {
        cb.onLog({ ts: Date.now(), level: 'warn', message: `  • ${issue}` })
      }
      // Feed the issues into the next HTML attempt
      visualFeedback = review.issues
    }

    if (!reviewPassed) {
      cb.onLog({
        ts: Date.now(),
        level: 'warn',
        message: `Scene ${i + 1}: visual review did not pass after ${MAX_VISUAL_REVIEW_ATTEMPTS} attempts. Using the best output anyway. Remaining issues:`
      })
      for (const issue of lastReviewIssues) {
        cb.onLog({ ts: Date.now(), level: 'warn', message: `  • ${issue}` })
      }
    }

    // Mux audio + 1s held-frame tail into the final scene MP4
    cb.onProgress(
      baseProgress + sceneShare * 0.85,
      `Scene ${i + 1}/${totalScenes}: muxing audio + ${SCENE_TAIL_SECONDS}s tail`
    )
    const finalMp4 = path.join(sceneDir, 'scene.mp4')
    await muxAudioWithVideo(
      {
        videoIn: rawMp4,
        audioIn: audioPath,
        out: finalMp4,
        durationSeconds: audioDuration,
        tailHoldSeconds: SCENE_TAIL_SECONDS
      },
      (line) => cb.onLog(info(`ffmpeg: ${line}`))
    )
    const sceneTotalSeconds = audioDuration + SCENE_TAIL_SECONDS
    cb.onLog(info(
      `✓ Scene ${i + 1}/${totalScenes} saved (${audioDuration.toFixed(2)}s audio + ${SCENE_TAIL_SECONDS.toFixed(1)}s held-frame tail = ${sceneTotalSeconds.toFixed(2)}s, ${visualAttempt} render attempt${visualAttempt === 1 ? '' : 's'}) → ${finalMp4}`
    ))

    sceneResults.push({
      finalMp4,
      durationSeconds: sceneTotalSeconds,
      transition_out: scene.transition_out
    })
  }

  cb.onLog(info(`All ${totalScenes} scene MP4(s) saved. Beginning final concatenation…`))

  if (handle.cancelled) throw new Error('Cancelled')
  cb.onProgress(0.7, 'Concatenating scenes')
  cb.onLog(info('Concatenating all scenes with transitions'))

  ensureDir(spec.output_folder)
  const safeName = spec.video_name.replace(/[\\/:*?"<>|]/g, '_')
  const finalPath = uniquePath(path.join(spec.output_folder, `${safeName}.mp4`))

  await concatScenesWithTransitions(
    {
      scenes: sceneResults.map((s) => ({
        videoPath: s.finalMp4,
        durationSeconds: s.durationSeconds,
        transitionOut: s.transition_out
      })),
      out: finalPath,
      width: dims.width,
      height: dims.height,
      fps: 30
    },
    (line) => cb.onLog(info(`ffmpeg: ${line}`))
  )

  cb.onProgress(1, 'Done')
  cb.onLog(info(`Saved final video to ${finalPath}`))

  // Optional: clean intermediate workspace on success — keep for now for debugging.
  return finalPath
}

function uniquePath(p: string): string {
  if (!fs.existsSync(p)) return p
  const parsed = path.parse(p)
  let i = 2
  while (true) {
    const candidate = path.join(parsed.dir, `${parsed.name} (${i})${parsed.ext}`)
    if (!fs.existsSync(candidate)) return candidate
    i++
  }
}

function info(message: string): JobLogEntry {
  return { ts: Date.now(), level: 'info', message }
}
