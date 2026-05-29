import { parse } from 'yaml'
import type { ScriptSpec, AspectRatio, SceneSpec, TransitionType } from '../types.js'
import { RATIO_DIMENSIONS } from '../types.js'

const VALID_RATIOS: AspectRatio[] = ['16:9', '9:16', '1:1', '4:5', '21:9']
const VALID_TRANSITIONS: TransitionType[] = [
  'none',
  'fade',
  'dissolve',
  'slide_left',
  'slide_right',
  'slide_up',
  'slide_down',
  'wipe_left',
  'wipe_right',
  'wipe_up',
  'wipe_down'
]

const ALLOWED_TOP_LEVEL = new Set([
  'video_name',
  'ratio',
  'output_folder',
  'voice_profile',
  'voice_speed',
  'style',
  // Style fields are also accepted at the top level for ergonomics.
  'description',
  'colors',
  'fonts',
  'scenes'
])

const ALLOWED_SCENE_KEYS = new Set(['explainer', 'voiceover', 'transition_out'])

export class ScriptValidationError extends Error {
  constructor(message: string, public path?: string) {
    super(path ? `${path}: ${message}` : message)
  }
}

export function parseScript(yaml: string): ScriptSpec {
  let raw: unknown
  try {
    raw = parse(yaml)
  } catch (err: any) {
    throw new ScriptValidationError(`Invalid YAML: ${err.message}`)
  }
  if (!raw || typeof raw !== 'object') {
    throw new ScriptValidationError('Script must be a YAML mapping at the top level.')
  }
  const r = raw as Record<string, unknown>

  // Reject unknown top-level keys so typos surface immediately.
  for (const k of Object.keys(r)) {
    if (!ALLOWED_TOP_LEVEL.has(k)) {
      throw new ScriptValidationError(
        `Unknown top-level key "${k}". Allowed keys: ${Array.from(ALLOWED_TOP_LEVEL).join(', ')}.`,
        k
      )
    }
  }

  const video_name = requireString(r, 'video_name')
  if (!/^[A-Za-z0-9_\- ]+$/.test(video_name)) {
    throw new ScriptValidationError(
      'video_name may only contain letters, numbers, spaces, hyphens, and underscores.',
      'video_name'
    )
  }

  const ratio = requireString(r, 'ratio') as AspectRatio
  if (!VALID_RATIOS.includes(ratio)) {
    throw new ScriptValidationError(
      `ratio must be one of ${VALID_RATIOS.join(', ')}.`,
      'ratio'
    )
  }

  // output_folder is required by the desktop YAML format but ignored in the
  // service path — the renderer writes to a temp dir and returns the path.
  // Accept any value; default to a placeholder so the validator passes.
  const output_folder = typeof r.output_folder === 'string' && r.output_folder.trim().length > 0
    ? r.output_folder
    : '/tmp/video-renderer-output'
  const voice_profile = requireString(r, 'voice_profile')

  const voice_speed =
    r.voice_speed !== undefined ? requireNumber(r, 'voice_speed', 0.5, 2.0) : undefined

  const style = parseStyle(r)

  if (!Array.isArray(r.scenes) || r.scenes.length === 0) {
    throw new ScriptValidationError('scenes must be a non-empty array.', 'scenes')
  }

  const scenes: SceneSpec[] = (r.scenes as unknown[]).map((s, i) => parseScene(s, i))

  return {
    video_name,
    ratio,
    output_folder,
    voice_profile,
    voice_speed,
    style,
    scenes
  }
}

/**
 * Accepts style either at the top level or nested under `style:`.
 * Each of description / colors / fonts can be a plain string OR a list of strings.
 * Top-level fields take precedence if both forms are provided.
 */
function parseStyle(r: Record<string, unknown>): ScriptSpec['style'] | undefined {
  let nested: Record<string, unknown> = {}
  if (r.style !== undefined) {
    if (typeof r.style === 'string') {
      // Whole style as a single descriptive paragraph.
      nested.description = r.style
    } else if (r.style && typeof r.style === 'object') {
      nested = r.style as Record<string, unknown>
    } else {
      throw new ScriptValidationError('style must be a mapping or string.', 'style')
    }
  }

  const description = pickString(r.description ?? nested.description, 'description')
  const colors = pickStringList(r.colors ?? nested.colors, 'colors')
  const fonts = pickStringList(r.fonts ?? nested.fonts, 'fonts')

  if (description === undefined && colors === undefined && fonts === undefined) {
    return undefined
  }
  return { description, colors, fonts }
}

function parseScene(raw: unknown, idx: number): SceneSpec {
  const path = `scenes[${idx}]`
  if (!raw || typeof raw !== 'object') {
    throw new ScriptValidationError('Scene must be a mapping.', path)
  }
  const s = raw as Record<string, unknown>
  for (const k of Object.keys(s)) {
    if (!ALLOWED_SCENE_KEYS.has(k)) {
      throw new ScriptValidationError(
        `Unknown scene key "${k}". Allowed: ${Array.from(ALLOWED_SCENE_KEYS).join(', ')}.`,
        `${path}.${k}`
      )
    }
  }
  const explainer = requireString(s, 'explainer', `${path}.explainer`)
  const voiceover = requireString(s, 'voiceover', `${path}.voiceover`)

  const transitionRaw = (s.transition_out ?? { type: 'none', duration: 0 }) as Record<
    string,
    unknown
  >
  const ttype = String(transitionRaw.type ?? 'none') as TransitionType
  if (!VALID_TRANSITIONS.includes(ttype)) {
    throw new ScriptValidationError(
      `transition_out.type must be one of ${VALID_TRANSITIONS.join(', ')}.`,
      `${path}.transition_out.type`
    )
  }
  const tdur = Number(transitionRaw.duration ?? 0)
  if (!Number.isFinite(tdur) || tdur < 0 || tdur > 5) {
    throw new ScriptValidationError(
      'transition_out.duration must be a number between 0 and 5 seconds.',
      `${path}.transition_out.duration`
    )
  }
  return {
    explainer,
    voiceover,
    transition_out: { type: ttype, duration: ttype === 'none' ? 0 : tdur }
  }
}

function requireString(obj: Record<string, unknown>, key: string, path?: string): string {
  const v = obj[key]
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ScriptValidationError(`${key} is required and must be a non-empty string.`, path ?? key)
  }
  return v.trim()
}

function requireNumber(
  obj: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  path?: string
): number {
  const v = Number(obj[key])
  if (!Number.isFinite(v) || v < min || v > max) {
    throw new ScriptValidationError(
      `${key} must be a number between ${min} and ${max}.`,
      path ?? key
    )
  }
  return v
}

function pickString(v: unknown, path: string): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v === 'string') return v.trim() || undefined
  if (Array.isArray(v)) {
    const joined = v.map(String).filter((s) => s.trim() !== '').join(' ')
    return joined || undefined
  }
  throw new ScriptValidationError('Must be a string.', path)
}

function pickStringList(v: unknown, path: string): string[] | undefined {
  if (v === undefined || v === null) return undefined
  if (Array.isArray(v)) {
    const arr = v.map((x) => String(x).trim()).filter((s) => s !== '')
    return arr.length > 0 ? arr : undefined
  }
  if (typeof v === 'string') {
    // Allow "red, blue, green" or a single descriptive sentence — treat as one entry.
    const trimmed = v.trim()
    if (!trimmed) return undefined
    // If it looks like a comma list (multiple commas and no full sentences), split it.
    if (trimmed.includes(',') && trimmed.split(',').every((p) => p.trim().length < 60)) {
      return trimmed.split(',').map((s) => s.trim()).filter((s) => s !== '')
    }
    return [trimmed]
  }
  throw new ScriptValidationError('Must be a string or array of strings.', path)
}

export function dimensionsForRatio(ratio: AspectRatio) {
  return RATIO_DIMENSIONS[ratio]
}
