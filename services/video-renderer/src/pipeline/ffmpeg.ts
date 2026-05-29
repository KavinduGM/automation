import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import ffmpegPath from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import type { Transition, TransitionType } from '../types.js'

// In a packaged Electron app, ffmpeg-static returns a path inside app.asar that
// must be unpacked. electron-builder asarUnpack handles that, but the path comes
// back with /app.asar/ still in it — we rewrite to /app.asar.unpacked/.
function resolveBinary(p: string): string {
  if (process.env.NODE_ENV !== 'production' && !p.includes('app.asar')) return p
  return p.replace(/[\\/]app\.asar[\\/]/, `${path.sep}app.asar.unpacked${path.sep}`)
}

const FFMPEG = resolveBinary(ffmpegPath as unknown as string)
const FFPROBE = resolveBinary((ffprobeStatic as any).path as string)

export function runFfmpeg(args: string[], onLog?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { windowsHide: true })
    let stderrTail = ''
    p.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      stderrTail = (stderrTail + text).slice(-4000)
      if (onLog) {
        for (const line of text.split(/\r?\n/)) if (line.trim()) onLog(line)
      }
    })
    p.on('error', reject)
    p.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}: ${stderrTail}`))
    })
  })
}

export async function probeDurationSeconds(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn(
      FFPROBE,
      [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath
      ],
      { windowsHide: true }
    )
    let out = ''
    let err = ''
    p.stdout.on('data', (c) => (out += c.toString()))
    p.stderr.on('data', (c) => (err += c.toString()))
    p.on('error', reject)
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}: ${err}`))
      const v = parseFloat(out.trim())
      if (!Number.isFinite(v)) return reject(new Error(`ffprobe returned non-numeric: ${out}`))
      resolve(v)
    })
  })
}

export interface MuxArgs {
  videoIn: string
  audioIn: string
  out: string
  durationSeconds: number
  /**
   * Optional. Additional time appended to the end of the muxed scene where
   * the LAST video frame is held still and the audio track is padded with
   * silence. Used to give each scene a clean breath before the next one
   * begins. 0 = no tail.
   */
  tailHoldSeconds?: number
}

export async function muxAudioWithVideo(args: MuxArgs, onLog?: (l: string) => void): Promise<void> {
  const tail = Math.max(0, args.tailHoldSeconds ?? 0)
  const totalDuration = args.durationSeconds + tail

  // Without a tail, keep the simple stream-mapping path (fast, well-tested).
  if (tail === 0) {
    await runFfmpeg(
      [
        '-y',
        '-i', args.videoIn,
        '-i', args.audioIn,
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-preset', 'medium',
        '-crf', '20',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-t', totalDuration.toFixed(3),
        args.out
      ],
      onLog
    )
    return
  }

  // With a tail: use filter_complex to (a) clone-pad the video by `tail`
  // seconds at the end (freezing the last frame) and (b) silence-pad the
  // audio by the same amount.
  const t = tail.toFixed(3)
  const filterComplex =
    `[0:v]tpad=stop_mode=clone:stop_duration=${t}[v];` +
    `[1:a]apad=pad_dur=${t}[a]`

  await runFfmpeg(
    [
      '-y',
      '-i', args.videoIn,
      '-i', args.audioIn,
      '-filter_complex', filterComplex,
      '-map', '[v]',
      '-map', '[a]',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'medium',
      '-crf', '20',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-t', totalDuration.toFixed(3),
      args.out
    ],
    onLog
  )
}

export interface ConcatArgs {
  scenes: { videoPath: string; durationSeconds: number; transitionOut: Transition }[]
  out: string
  width: number
  height: number
  fps?: number
}

/**
 * Concatenate scene clips. Transitions are applied at each boundary using ffmpeg's xfade
 * filter for video and acrossfade for audio. The transition.duration overlaps the two
 * adjacent scenes, so the final video is shorter than the sum of scene durations by
 * the total transition time.
 */
export async function concatScenesWithTransitions(
  args: ConcatArgs,
  onLog?: (l: string) => void
): Promise<void> {
  const { scenes, out, width, height } = args
  const fps = args.fps ?? 30
  if (scenes.length === 0) throw new Error('concat: scenes is empty')
  if (scenes.length === 1) {
    // Just re-encode to the target dimensions to be safe.
    await runFfmpeg(
      [
        '-y',
        '-i', scenes[0].videoPath,
        '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fps}`,
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-preset', 'medium',
        '-crf', '20',
        '-c:a', 'aac',
        '-b:a', '192k',
        out
      ],
      onLog
    )
    return
  }

  // Build filter_complex chain.
  const inputs: string[] = []
  for (const s of scenes) {
    inputs.push('-i', s.videoPath)
  }

  // Pre-normalise every scene's video stream (size, fps, pix_fmt) and audio (sample rate).
  const filterParts: string[] = []
  const vLabels: string[] = []
  const aLabels: string[] = []
  for (let i = 0; i < scenes.length; i++) {
    const v = `v${i}`
    const a = `a${i}`
    filterParts.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fps},format=yuv420p,setpts=PTS-STARTPTS[${v}]`
    )
    filterParts.push(`[${i}:a]aformat=channel_layouts=stereo:sample_rates=48000,asetpts=PTS-STARTPTS[${a}]`)
    vLabels.push(v)
    aLabels.push(a)
  }

  // Chain xfade / acrossfade across the scenes.
  let prevV = vLabels[0]
  let prevA = aLabels[0]
  let prevDur = scenes[0].durationSeconds

  for (let i = 1; i < scenes.length; i++) {
    const trans = scenes[i - 1].transitionOut
    const xfadeName = mapTransitionToXfade(trans.type)
    const dur = trans.type === 'none' || !xfadeName ? 0 : Math.min(trans.duration, scenes[i].durationSeconds, prevDur)

    const outV = `vx${i}`
    const outA = `ax${i}`

    if (dur > 0 && xfadeName) {
      const offset = prevDur - dur
      filterParts.push(
        `[${prevV}][${vLabels[i]}]xfade=transition=${xfadeName}:duration=${dur.toFixed(3)}:offset=${offset.toFixed(3)}[${outV}]`
      )
      filterParts.push(
        `[${prevA}][${aLabels[i]}]acrossfade=d=${dur.toFixed(3)}:c1=tri:c2=tri[${outA}]`
      )
      prevDur = prevDur + scenes[i].durationSeconds - dur
    } else {
      filterParts.push(`[${prevV}][${vLabels[i]}]concat=n=2:v=1:a=0[${outV}]`)
      filterParts.push(`[${prevA}][${aLabels[i]}]concat=n=2:v=0:a=1[${outA}]`)
      prevDur = prevDur + scenes[i].durationSeconds
    }
    prevV = outV
    prevA = outA
  }

  const filter = filterParts.join(';')
  await runFfmpeg(
    [
      '-y',
      ...inputs,
      '-filter_complex', filter,
      '-map', `[${prevV}]`,
      '-map', `[${prevA}]`,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'medium',
      '-crf', '20',
      '-c:a', 'aac',
      '-b:a', '192k',
      out
    ],
    onLog
  )
}

function mapTransitionToXfade(t: TransitionType): string | null {
  switch (t) {
    case 'fade':
      return 'fade'
    case 'dissolve':
      return 'dissolve'
    case 'slide_left':
      return 'slideleft'
    case 'slide_right':
      return 'slideright'
    case 'slide_up':
      return 'slideup'
    case 'slide_down':
      return 'slidedown'
    case 'wipe_left':
      return 'wipeleft'
    case 'wipe_right':
      return 'wiperight'
    case 'wipe_up':
      return 'wipeup'
    case 'wipe_down':
      return 'wipedown'
    case 'none':
    default:
      return null
  }
}

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

/**
 * Extract a single still frame from a rendered MP4 at the given timestamp,
 * encoded as a JPEG for passing to Claude's vision API. Captures near the end
 * by default so the composition is in its final, settled state.
 */
export async function extractFrame(
  args: { videoIn: string; atSeconds: number; out: string; quality?: number },
  onLog?: (l: string) => void
): Promise<void> {
  const q = args.quality ?? 3 // 2 = best, 31 = worst; 3 is high quality, small file
  await runFfmpeg(
    [
      '-y',
      '-ss', args.atSeconds.toFixed(3),
      '-i', args.videoIn,
      '-vframes', '1',
      '-q:v', String(q),
      args.out
    ],
    onLog
  )
}
