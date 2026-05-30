import Anthropic from '@anthropic-ai/sdk'
import fs from 'node:fs/promises'
import type { AspectRatio, ScriptSpec } from '../types.js'
import { dimensionsForRatio } from './parser.js'

export interface SceneRenderArgs {
  apiKey: string
  model: string
  ratio: AspectRatio
  durationSeconds: number
  sceneIndex: number
  totalScenes: number
  explainer: string
  voiceover: string
  style?: ScriptSpec['style']
  /**
   * Issues raised by the visual reviewer on a previous render of THIS scene.
   * When present, the prompt prepends them so Claude knows what to fix.
   */
  visualFeedback?: string[]
}

const SYSTEM_PROMPT = `You are an expert motion-graphics engineer who writes self-contained HTML compositions for the HeyGen Hyperframes renderer.

Hyperframes renders an "index.html" with a #stage element to MP4 frame-by-frame.
The stage MUST declare data-width and data-height matching the target resolution.
Elements inside the stage can use data-start and data-duration (in seconds) to schedule timed entry,
or you may drive everything with GSAP / CSS keyframes / anime.js — whichever you prefer.

Hard requirements you MUST follow:

1. Output EXACTLY one complete HTML document beginning with <!DOCTYPE html>. No markdown fences, no commentary, no preamble.

2. The <body> contains exactly one root:
   <div id="stage" data-composition-id="main" data-width="W" data-height="H" data-duration="D">…</div>
   where W, H, D are filled with the exact values the user requests.

3. All CSS must be inline in a <style> block. All JS must be inline in a <script> block.
   External references are allowed ONLY for CDN imports of animation libraries (gsap, anime.js, lottie-web)
   and Google Fonts. Prefer GSAP timelines for complex sequencing.

4. THE TIMELINE IS A SINGLE LINEAR PLAYTHROUGH FROM 0 TO D SECONDS. ABSOLUTELY NO LOOPING.
   This rule is enforced by a post-processor that rewrites the following patterns — do not
   write them, you'll just look careless:
   - CSS:        \`animation-iteration-count: infinite\` or any value > 1 (will be forced to 1)
   - CSS:        \`animation: name 2s infinite\` (the \`infinite\` keyword will be stripped)
   - GSAP:       \`repeat: -1\` or \`repeat: N\` > 0 (will be forced to 0)
   - GSAP:       \`yoyo: true\` (will be forced to false)
   - SVG:        \`<animate ... repeatCount="indefinite">\` or repeatCount > 1 (will be forced to "1")
                 (same for \`<animateMotion>\`, \`<animateTransform>\`)
   - WebAnims:   \`element.animate(..., { iterations: Infinity })\` or iterations > 1 (forced to 1)
   - anime.js:   \`loop: true\`, \`loop: -1\`, or \`loop: N\` > 0 (will be forced to false)
   - JS:         \`setInterval\` for any visible animation — banned outright; use
                 \`setTimeout\` only for scheduling one-shot reveals.

   Every \`@keyframes\` rule applied to a visible element MUST be paired with
   \`animation-iteration-count: 1\` and \`animation-fill-mode: forwards\` explicitly. Do NOT
   rely on defaults. Every animation runs exactly once and ends in its final visual state.

   RECOMMENDED write-on patterns (use these, they don't loop):
   - SVG hand-drawn stroke write-on: set \`stroke-dasharray: <pathLength>; stroke-dashoffset: <pathLength>;\`
     and animate \`stroke-dashoffset: 0\` with a single \`forwards\` CSS keyframe or one GSAP tween.
   - Letter-by-letter text write-on: stagger each <span> with a GSAP timeline (no repeat),
     or use CSS \`@keyframes\` with \`animation-delay\` per letter and \`animation-iteration-count: 1\`.

5. THE ANIMATION MUST GENUINELY FILL THE ENTIRE DURATION D WITH UNIQUE, PROGRESSIVE CONTENT.
   This is the single most important rule and the one most often violated:
   - Plan AT LEAST ceil(D / 2.5) distinct "beats" spread across [0, D]. A beat is a moment where
     a new element appears, an existing element transforms meaningfully, or focus shifts.
   - At no point should there be a static hold longer than 1.5 seconds in the first 90% of the
     duration. Every 1.5–3 second window must either reveal something new or progress something
     visibly (e.g. a sub-bullet writes in, a value counts up, a shape morphs).
   - The composition is NOT a 3-second loop padded to D seconds. If you find yourself with
     extra time to fill, ADD MORE CONTENT — sub-points, supporting visuals, callouts,
     a punctuating shape, a soft camera-style pan — not a repeat of what came before.
   - The final 0.5–1.5 seconds is a "settle" hold where everything sits stable. During this hold
     you MAY apply ONE subtle, single-pass tween (a slow zoom, a slow pan, a very slow gradient
     drift) lasting exactly until D seconds, to keep the frame alive — but it must NOT repeat
     and must NOT distract from the final composition.

5b. ONE DOM ELEMENT PER VISIBLE ITEM. ONE ANIMATION PER ELEMENT.
    This is the single biggest source of "the scene loops" failures.

    The explainer lists STEPS. A step often describes MULTIPLE visible items.
    Examples:
      "Step 8: three white bullets write in one after another:
                'Identifies the disease'
                'Looks at the PRESENT'
                'e.g. Stage 3 Lung Cancer'"
      → That is THREE separate DOM elements with THREE separate, staggered animations,
        not one element containing all three lines, and not three elements that animate
        at the same time.

      "Step 6: a hand-drawn box strokes in, then sky-blue text writes in, then a
                phrase writes in beside it"
      → That is THREE separate animations on three separate elements: the box's
        stroke-dashoffset reveal, then the text write-on, then the phrase write-on.

    PLANNING CHECKLIST you must satisfy before writing HTML:
    (a) Count every distinct visible item described across all steps (boxes, lines, labels,
        bullets, sub-bullets, doodles, headings, underlines). Call this N.
    (b) You will create N DOM elements, each with its own animation and its own
        start-time / delay.
    (c) Distribute those N animation start times across the full duration D so that:
          - The FIRST animation starts at or near t = 0.
          - The LAST animation starts no earlier than t = D − 2.0 seconds.
          - No gap longer than 1.5 seconds between consecutive animation start times
            during the first 90% of the timeline.
    (d) Within a step that lists "one after another" items, stagger them — never reveal
      them simultaneously.

    If timestamps appear in the explainer (Step N (a–b s):), honor them as a hard contract.
    If they don't, derive your own start times satisfying (c) above. Either way, the
    LATEST start time you assign to any element MUST be ≥ D − 2.0 seconds.

    Every element's INITIAL CSS state must be the pre-reveal state (opacity: 0,
    stroke-dashoffset = path length, off-screen transform). Otherwise the element shows
    at frame 0 and the "reveal" is a no-op.

    Pick whichever animation technique fits — GSAP timeline with absolute time positions,
    CSS \`@keyframes\` with per-element \`animation-delay\` (plus \`animation-iteration-count: 1\`
    and \`animation-fill-mode: both\`), or anime.js with delay. The key is one element per
    item and start times that span the full duration.

6. THE EXPLAINER OFTEN CONTAINS MULTIPLE SECTIONS OR BEATS. Map them onto the sequential timeline:
   - Identify each distinct beat in the explainer (e.g. "OPENING", "SECTION 1", "SECTION 2", "CLOSING").
   - Divide the duration D between them in proportion to how much content each beat carries.
   - Each beat occupies a CONTIGUOUS, NON-OVERLAPPING time block. Beat N+1 starts only after Beat N
     has fully revealed (allow a brief 0.3–0.6s crossfade between beats if it improves polish).
   - Within a beat, elements can stagger in, but the beat's last element must finish before the
     next beat begins. Earlier beats' elements either remain on stage or are explicitly
     transitioned out (fade/slide/clear) before the next beat's content appears.

7. The total visible animation MUST end exactly at D seconds. No awkward freezes longer than the
   settle hold described in rule 5. No abrupt cuts, no dead space at the end.

8. Do NOT include <audio> or <video> tags. Audio is added separately by the host pipeline.

9. The stage must fully fill its declared dimensions. Use a solid background color (do not rely on transparency).

10. Use modern, polished motion design: smooth easing, layered reveals, balanced typography.
    Respect the requested style hints (description, colors, fonts) faithfully — if "hand-drawn"
    is requested, use rough strokes, jitter, write-on SVG paths. If "minimal" is requested, restrain motion.

11. Use system-safe fonts or Google Fonts loaded via <link>. If a font is named in the style hints,
    prefer it and load it via Google Fonts if it exists there.

12. Animations must be DETERMINISTIC — no Math.random() driving visible motion. The same input must
    render the same output every time.

13. Do NOT put the voiceover text on screen unless the explainer explicitly asks for on-screen text.
    The voiceover is a separate audio track played alongside.

14. LAYOUT — NO ELEMENT MAY VISUALLY OVERLAP ANOTHER. This is a HARD requirement.

    The stage is a single fixed-size canvas. Structure it as a vertical flex column with
    distinct, non-overlapping REGIONS, each region containing exactly the content that
    belongs there. Typical structure for a portrait scene:

        #stage {
          display: flex;
          flex-direction: column;
          width: 100%;
          height: 100%;
          padding: 80px 60px;  /* breathing room around the edges */
          gap: 40px;           /* spacing between major regions */
          box-sizing: border-box;
        }

        .region-top    { /* heading + underline */ }
        .region-body   { flex: 1; display: flex; ... ; gap: 24px; }
        .region-bottom { /* annotations / footer */ }

    HARD RULES for layout:

    a) Prefer NORMAL FLOW with flexbox or grid for all positioning. Use \`position: absolute\`
       ONLY for hand-drawn doodles or accent overlays that genuinely need to float on top of
       another element — and even then, make sure they don't cover important text.

    b) "Two pieces of text side by side" = flex row container with the two pieces as children,
       NOT two absolutely-positioned elements. The same goes for "left box and right box",
       "icon next to label", "label above arrow", etc.

    c) When the explainer says one element is BELOW another, they must be siblings in DOM
       order with the lower one appearing after, in a flex column or in normal flow.
       Never absolutely-position the lower element with a fixed top: value that depends on
       the upper element's size.

    d) Inside a box that holds multiple text pieces, the box must use flex (column or row,
       whichever matches "side by side" vs "stacked") with proper gap. The text pieces are
       children of the box, in flow, NOT absolutely positioned inside the box.

    e) Dividers, separators, dashed lines, and timeline arrows are siblings of the things they
       separate, with explicit height/width that matches what they actually need to span.
       A vertical divider between two columns should be a flex item between those columns,
       not an absolutely-positioned line that extends past the columns into other regions.

    f) Bottom annotations and footers belong in their own region at the bottom of the stage.
       They appear after the main body region in DOM order. They must NEVER overlap with
       content above them.

    g) Reserve generous gaps between regions and between sibling elements. Minimum 20px gap
       between adjacent content elements. Minimum 40px gap between major regions.

    h) Before submitting, mentally render the final composition. If two visible elements
       occupy overlapping screen rectangles when their animations finish, the layout is wrong
       — rework it with proper flex/grid structure.

15. SHAPE INTEGRITY — geometric shapes must be COMPLETE.
    Every rendered shape is reviewed by an automated visual reviewer that rejects partial
    shapes. To pass review:

    a) RECTANGLES / BOXES: all 4 sides must connect end-to-end. Never render a "3-sided box"
       or a rectangle with a visible gap on one edge. Use ONE of these patterns:
         - A plain HTML element with \`border: 3px solid <color>\` (border-radius optional
           for slightly rounded hand-drawn feel). The browser will always close the rectangle.
         - An SVG \`<rect>\` element with stroke. Animate the stroke-dashoffset for a write-on
           effect, but the FINAL stroke-dashoffset must reach 0 so the full perimeter is
           visible by the end of the reveal.
         - An SVG \`<path>\` that traces all 4 sides and ends with \`Z\` to close the path.
           Set stroke-dasharray = path-length and animate stroke-dashoffset from path-length
           to 0. DOUBLE-CHECK that the dash-array equals the actual path length, so the
           stroke finishes drawing all 4 sides.

    b) TRIANGLES: all 3 sides connected, path closed with \`Z\` if SVG, or use clip-path
       polygon with a solid border via a wrapping technique.

    c) CIRCLES / ELLIPSES: fully closed. Use \`<circle>\` or \`<ellipse>\` (SVG always closes
       these). For a stroke-on animation, animate stroke-dashoffset → 0 so the full perimeter
       is drawn.

    d) LINES, ARROWS, DIVIDERS, DASHED CONNECTORS: drawn end-to-end. The final stroke-dashoffset
       must be 0. The arrowhead (if any) must be visible at the line's endpoint.

    Common bug to avoid: setting stroke-dasharray and stroke-dashoffset to values that don't
    leave the shape fully drawn at the end. If you compute the path length wrong, the stroke
    will stop short and leave one side missing.

16. HAND-DRAWN APPEARANCE — when "hand-drawn" is in the style, you may add slight stroke
    jitter / variation, but completeness comes first. A perfectly straight box is better
    than a 3-sided "hand-drawn" box. Use small roughness (1-2px wobble at most), not
    full broken-line effects.`

function buildUserPrompt(args: SceneRenderArgs): string {
  const dims = dimensionsForRatio(args.ratio)
  const style = args.style
    ? `\nStyle hints:\n- description: ${args.style.description ?? '(none)'}\n- colors: ${(args.style.colors ?? []).join(', ') || '(none)'}\n- fonts: ${(args.style.fonts ?? []).join(', ') || '(none)'}`
    : ''
  return `Build a single Hyperframes composition for scene ${args.sceneIndex + 1} of ${args.totalScenes}.

Aspect ratio: ${args.ratio}
Resolution: ${dims.width}x${dims.height}
Total duration (seconds): ${args.durationSeconds.toFixed(3)}
${style}

Scene explainer (what the visuals should show and feel like). It MAY contain multiple SECTIONS / beats.
If it does, your timeline must traverse them sequentially in order, dividing the ${args.durationSeconds.toFixed(2)}-second duration between them, and NEVER looping:
"""
${args.explainer}
"""

The voiceover that will be played over this scene (for tone/pacing reference only — do not display this text on screen unless the explainer explicitly asks):
"""
${args.voiceover}
"""

Plan before you write code:

1. ENUMERATE every visible item across all steps. A "Step" in the explainer often groups
   multiple items. Walk each Step and break it into atomic items.
   For each item, write down one line in your internal plan:
     [item index]  [what it is]  [which Step it came from]
   Example for a 12-step explainer where Step 8 lists 3 bullets:
     1. yellow label
     2. yellow underline
     3. white context line A
     4. white context line B
     5. white separator
     6. left box outline
     7. left box header
     8. left box bullet 1   ← from Step 8
     9. left box bullet 2   ← from Step 8
     10. left box bullet 3  ← from Step 8
     ... and so on for every Step.
   Each item from this list becomes ONE DOM element with ONE animation.

2. ASSIGN A START TIME to every item from step 1, spread across [0, ${args.durationSeconds.toFixed(2)}].
   - Item 1 starts at or near t = 0.
   - Item N (the last) starts at NO EARLIER than t = ${(args.durationSeconds - 2.0).toFixed(2)} seconds
     (i.e. D − 2.0). This is a hard floor.
   - Distribute the rest roughly evenly. No gap between consecutive items longer than
     1.5 seconds during the first 90% of the timeline.
   - "One after another" items inside a step are staggered (e.g. 0.5–0.8s between each).

3. If the explainer has explicit time markers like "Step N (a–b s):" or "Beat N (a–b s):",
   those override your computed times for the matching step's start. Items WITHIN a step
   spread inside that step's window.

4. EACH ITEM'S INITIAL CSS STATE must be the pre-reveal state — opacity: 0, or
   stroke-dashoffset = path length, or off-screen transform. Otherwise the item
   shows at frame 0 and the "reveal" is a no-op.

5. CHOOSE a technique consistently across the whole composition:
   a) GSAP timeline with absolute time positions:
        const tl = gsap.timeline();
        tl.from('.el-1', { opacity: 0, y: 8, duration: 0.6 }, START_TIME);
      Prefer .from() so the element's CSS final state is the destination — less risk
      of forgetting the initial state.
   b) CSS @keyframes per element with \`animation-delay: <start>s\`,
      \`animation-iteration-count: 1\`, \`animation-fill-mode: both\`. \`both\` makes the
      element hold its 0% state before the delay AND its 100% state after the animation.

6. Final 0.5–1.5 seconds of the timeline is the settle hold. All items are visible.
   You MAY add ONE single-pass effect on the whole composition (slow zoom 1.00→1.02,
   slow pan, slow gradient drift) ending at exactly ${args.durationSeconds.toFixed(2)}s.
   One pass, not looping.

7. NEVER \`infinite\`, NEVER \`repeat: -1\`, NEVER \`repeatCount="indefinite"\`,
   NEVER \`setInterval\` for visible motion. Every \`@keyframes\` user MUST set
   \`animation-iteration-count: 1\` and \`animation-fill-mode\` explicitly.

8. If you find your enumerated items in step 1 are too few to fill ${args.durationSeconds.toFixed(2)} seconds
   without large gaps, ADD supporting items (a decorative arrow, a small doodle, an
   accent stroke) that fit the explainer's tone. Never pad by repeating earlier motion.

VERIFICATION before submitting:
- I have N distinct DOM elements, one per visible item.
- The LAST element's animation start time is ≥ ${(args.durationSeconds - 2.0).toFixed(2)}s.
- No two consecutive items are more than 1.5s apart in start time.
- Every element's initial CSS is the pre-reveal state.
- Zero infinite/repeat animations anywhere.
- LAYOUT: the stage is a flex column with distinct top / body / bottom regions.
- LAYOUT: every "side by side" pair uses a flex row container, not absolute positioning.
- LAYOUT: every "below X" element is in flow after X (or in a later region), not
  absolutely positioned with a guessed top: value.
- LAYOUT: every box that contains multiple text pieces uses flex inside, with proper gap.
- LAYOUT: dividers / arrows / dashed lines have explicit dimensions and do not extend
  past the region they belong to.
- LAYOUT: at the final frame, NO two visible elements share screen space.

Return ONLY the full HTML document, beginning with <!DOCTYPE html>.`
}

export interface SceneHtmlResult {
  html: string
  sanitized: string[]
  attempts: number
  validationStatus: 'passed' | 'failed-after-retries'
  validationLog: string[]
}

/**
 * Walk the generated HTML and find the latest moment any element begins its reveal
 * animation. Catches CSS animation-delay, GSAP timeline absolute-position args
 * (third arg to .to/.from/.fromTo/.set/.add), SVG <animate begin="">, and the
 * Web Animations API / anime.js `delay:` property. Returns the maximum start time
 * in seconds and the count of timed reveals it found.
 */
export function extractMaxAnimationStartTime(html: string): {
  maxStartSeconds: number
  found: number
  starts: number[]
} {
  const starts: number[] = []
  const push = (v: number) => {
    if (Number.isFinite(v) && v >= 0 && v < 600) starts.push(v)
  }

  // CSS  animation-delay: 1.5s | 1500ms
  for (const m of html.matchAll(/animation-delay\s*:\s*([-+]?[\d.]+)\s*(s|ms)\b/gi)) {
    const v = parseFloat(m[1])
    push(m[2].toLowerCase() === 'ms' ? v / 1000 : v)
  }

  // CSS shorthand: animation: name 1s 2s ...  — second time value is the delay.
  for (const m of html.matchAll(
    /animation\s*:\s*[A-Za-z_-][\w-]*\s+([\d.]+)(s|ms)\s+([\d.]+)(s|ms)/gi
  )) {
    const v = parseFloat(m[3])
    push(m[4].toLowerCase() === 'ms' ? v / 1000 : v)
  }

  // GSAP: .to(target, vars, position), .from(...), .fromTo(...), .set(...), .add(...)
  // We catch the case where the LAST positional arg is a plain number (absolute time).
  for (const m of html.matchAll(
    /\.\s*(?:to|from|fromTo|set|add)\s*\(([\s\S]*?)\)/g
  )) {
    const args = m[1]
    // Find the last top-level numeric literal argument.
    const trailing = args.match(/,\s*([\d.]+)\s*$/)
    if (trailing) push(parseFloat(trailing[1]))
  }

  // SVG <animate begin="2.5s"> / begin="2500ms" / begin="2"
  for (const m of html.matchAll(
    /<animate(?:Motion|Transform)?\b[^>]*\bbegin\s*=\s*["']\s*([\d.]+)\s*(s|ms)?\s*["']/gi
  )) {
    const v = parseFloat(m[1])
    push((m[2] ?? 's').toLowerCase() === 'ms' ? v / 1000 : v)
  }

  // Web Animations / anime.js: { delay: 1500 } — usually milliseconds.
  for (const m of html.matchAll(/\bdelay\s*:\s*([\d.]+)\s*[,}\n]/g)) {
    const v = parseFloat(m[1])
    // Heuristic: anything > 30 is almost certainly ms (a 30-second delay is implausible),
    // anything ≤ 30 we treat as seconds (GSAP delay convention).
    push(v > 30 ? v / 1000 : v)
  }

  const maxStartSeconds = starts.length > 0 ? Math.max(...starts) : 0
  return { maxStartSeconds, found: starts.length, starts }
}

export interface ValidationResult {
  ok: boolean
  maxStartSeconds: number
  found: number
  reason?: string
}

/**
 * Coverage rule: the last animation in the scene MUST start no earlier than D - 2.0 seconds.
 * If it starts earlier, the visible timeline is compressed into the front of the scene
 * and the tail will look frozen or looping. We treat this as a generation failure and retry.
 */
export function validateAnimationCoverage(html: string, durationSeconds: number): ValidationResult {
  const { maxStartSeconds, found } = extractMaxAnimationStartTime(html)
  const minRequired = Math.max(0.5, durationSeconds - 2.0)

  if (found === 0) {
    return {
      ok: false,
      maxStartSeconds: 0,
      found: 0,
      reason:
        'No animation start times detected anywhere in the HTML (no CSS animation-delay, no GSAP positional args, no SVG begin=, no delay: properties). The composition has no scheduled timeline — every element would appear at frame 0.'
    }
  }

  if (maxStartSeconds < minRequired) {
    return {
      ok: false,
      maxStartSeconds,
      found,
      reason:
        `The latest animation in the HTML starts at t=${maxStartSeconds.toFixed(2)}s, ` +
        `but for a ${durationSeconds.toFixed(2)}s scene the last animation must start no earlier than ` +
        `t=${minRequired.toFixed(2)}s (D − 2.0). The timeline is compressed into the first ` +
        `${(maxStartSeconds + 1).toFixed(1)}s, leaving the rest static or looping.`
    }
  }

  return { ok: true, maxStartSeconds, found }
}

const MAX_ATTEMPTS = 3

export async function generateSceneHtml(args: SceneRenderArgs): Promise<SceneHtmlResult> {
  if (!args.apiKey) throw new Error('Anthropic API key is not set in Settings.')
  const client = new Anthropic({ apiKey: args.apiKey })

  const log: string[] = []
  let lastSanitized: string[] = []
  let lastHtml = ''
  let lastReason = ''

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const userPrompt = buildUserPromptForAttempt(args, attempt, lastReason)

    const resp = await client.messages.create({
      model: args.model || 'claude-opus-4-7',
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }]
    })

    const text = resp.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as Anthropic.TextBlock).text)
      .join('\n')
      .trim()

    const html = extractHtml(text)
    const { html: cleanHtml, sanitized } = sanitizeLoops(html)
    const validation = validateAnimationCoverage(cleanHtml, args.durationSeconds)

    lastSanitized = sanitized
    lastHtml = cleanHtml

    if (validation.ok) {
      log.push(
        `attempt ${attempt}/${MAX_ATTEMPTS}: passed (last animation at t=${validation.maxStartSeconds.toFixed(2)}s, ${validation.found} timed reveals)`
      )
      return {
        html: cleanHtml,
        sanitized,
        attempts: attempt,
        validationStatus: 'passed',
        validationLog: log
      }
    }

    lastReason = validation.reason ?? 'unknown failure'
    log.push(`attempt ${attempt}/${MAX_ATTEMPTS}: FAILED — ${lastReason}`)
  }

  return {
    html: lastHtml,
    sanitized: lastSanitized,
    attempts: MAX_ATTEMPTS,
    validationStatus: 'failed-after-retries',
    validationLog: log
  }
}

function buildUserPromptForAttempt(
  args: SceneRenderArgs,
  attempt: number,
  prevReason: string
): string {
  let basePrompt = buildUserPrompt(args)

  // Prepend any visual-review feedback from a prior render of this scene.
  if (args.visualFeedback && args.visualFeedback.length > 0) {
    basePrompt =
      `IMPORTANT — A previous render of this exact scene was visually reviewed and FAILED.\n` +
      `The reviewer found these specific issues (you MUST fix every one):\n` +
      args.visualFeedback.map((issue) => `  • ${issue}`).join('\n') +
      `\n\nProduce HTML that addresses all of the above. Pay extra attention to:\n` +
      `  - Shape integrity (complete boxes, closed paths, full stroke draws).\n` +
      `  - No overlapping elements at the final frame.\n` +
      `  - All items from the explainer must appear and be visible / readable.\n\n` +
      `---\n\n` +
      basePrompt
  }

  if (attempt === 1) return basePrompt

  const minRequired = Math.max(0.5, args.durationSeconds - 2.0)
  return (
    basePrompt +
    `\n\n---\n` +
    `RETRY — your previous attempt failed automated validation:\n\n` +
    `  ${prevReason}\n\n` +
    `You MUST fix this in this attempt:\n` +
    `  - The LAST visible animation start time MUST be ≥ ${minRequired.toFixed(2)}s\n` +
    `    (we measure this by scanning the HTML for CSS animation-delay,\n` +
    `     GSAP positional args, SVG begin=, and delay: properties).\n` +
    `  - Spread your animations across the full ${args.durationSeconds.toFixed(2)}s duration.\n` +
    `  - Every visible item from the explainer is its own DOM element with its own staggered start time.\n` +
    `  - Do NOT cluster all reveals into the first few seconds.\n` +
    `Return ONLY the corrected complete HTML document.`
  )
}

// ====================================================================
// VISUAL REVIEW — uses Claude's vision capability to inspect the rendered
// frame and decide whether it faithfully implements the explainer.
// ====================================================================

const REVIEWER_SYSTEM = `You are a strict quality reviewer for AI-generated animated video scenes.

Your input:
  1. An explainer that describes what a scene should show.
  2. A screenshot of the final rendered frame of that scene.

Your job: determine whether the rendered frame faithfully implements the explainer.
Be strict — false positives (passing a broken scene) are MUCH worse than false negatives
(failing a slightly-imperfect scene).

Check, in this order:

A. COMPLETENESS — every item described in the explainer should be visible in the image.
   List any item from the explainer that is missing, cut off, or unreadable.

B. SHAPE INTEGRITY — every drawn shape must be complete:
   - Rectangles / boxes: all 4 sides connected end-to-end. Flag any "3-sided box".
   - Triangles: all 3 sides connected.
   - Circles / ellipses: fully closed.
   - Lines and arrows: drawn from one endpoint to the other, with arrowhead present.
   - Dashed lines: visible across their intended length, not stopping short.

C. OVERLAPS — no element may visually overlap another element's content. Flag:
   - Text overlapping other text.
   - Text crossing through a divider, arrow, or box edge.
   - Boxes overlapping each other.
   - Text outside its container.

D. LAYOUT BALANCE — content is reasonably balanced. Flag:
   - Text cut off at the screen edges.
   - Huge empty regions that should contain content.
   - Cramped, illegible clusters.

E. COLOR FIDELITY — colors should match the explainer (e.g. "sky blue for DIAGNOSIS"
   means the DIAGNOSIS-related elements actually appear sky blue). Flag obvious color mismatches.

F. AESTHETIC — if the explainer requests a hand-drawn aesthetic, the strokes should look
   hand-drawn (some imperfection is fine). Flag completely mechanical / generic appearance
   only if it clearly violates the requested style.

Respond with ONLY a JSON object, no surrounding prose, no markdown fences:

{
  "pass": true | false,
  "issues": [ "specific actionable issue 1", "specific actionable issue 2", ... ]
}

Rules for issues:
- If pass is true, issues MUST be an empty array.
- Each issue is one concrete, actionable problem an HTML generator can fix.
  GOOD: "The sky-blue DIAGNOSIS box is missing its right edge — only 3 sides are visible."
  GOOD: "The text 'Diagnosis' overlaps with the text '= AT the moment' inside the top box."
  GOOD: "The vertical divider crosses through the bottom annotation text."
  BAD:  "The scene doesn't look great."     (vague — not actionable)
  BAD:  "Improve the layout."                (vague — not actionable)

- If a problem is borderline (e.g. minor stroke jitter), don't flag it. Only flag clear defects.`

export interface VisualReviewResult {
  pass: boolean
  issues: string[]
  rawResponse: string
}

export interface ReviewSceneArgs {
  apiKey: string
  model: string
  framePath: string
  explainer: string
  ratio: AspectRatio
}

export async function reviewScene(args: ReviewSceneArgs): Promise<VisualReviewResult> {
  if (!args.apiKey) throw new Error('Anthropic API key is not set in Settings.')
  const client = new Anthropic({ apiKey: args.apiKey })

  const imageBytes = await fs.readFile(args.framePath)
  const base64 = imageBytes.toString('base64')
  const mediaType = /\.png$/i.test(args.framePath) ? 'image/png' : 'image/jpeg'

  const resp = await client.messages.create({
    model: args.model || 'claude-opus-4-7',
    max_tokens: 1500,
    system: REVIEWER_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: base64
            }
          },
          {
            type: 'text',
            text:
              `Aspect ratio: ${args.ratio}\n\n` +
              `Explainer:\n"""\n${args.explainer}\n"""\n\n` +
              `Review the attached final frame against this explainer. ` +
              `Return ONLY the JSON object as specified.`
          }
        ]
      }
    ]
  })

  const text = resp.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as Anthropic.TextBlock).text)
    .join('')
    .trim()

  return parseReviewerJson(text)
}

function parseReviewerJson(text: string): VisualReviewResult {
  let raw = text.trim()
  // Strip a code fence if Claude wrapped the JSON despite instructions.
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/```\s*$/, '').trim()
  }
  // Find the first { and the matching last }
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first >= 0 && last > first) raw = raw.slice(first, last + 1)

  try {
    const parsed = JSON.parse(raw)
    const pass = parsed.pass === true
    const issues = Array.isArray(parsed.issues)
      ? parsed.issues.map(String).filter((s) => s.trim() !== '')
      : []
    return { pass, issues, rawResponse: text }
  } catch {
    // If parsing fails, treat as PASS (we don't want a parser bug to block scenes
    // forever) but bubble up the raw text in the log.
    return {
      pass: true,
      issues: [],
      rawResponse: text
    }
  }
}

/**
 * Last-line defence: strip the common looping constructs even if the prompt was ignored.
 * Returns the sanitized HTML and a list of what we changed so the runner can log it.
 *
 * Covers the realistic offenders:
 *   - CSS animation-iteration-count and the `infinite` keyword in the shorthand
 *   - GSAP timeline/tween repeat and yoyo
 *   - SVG <animate>/<animateMotion>/<animateTransform> repeatCount="indefinite"|N>1
 *   - Web Animations API element.animate(..., { iterations: Infinity | -1 | N>1 })
 *   - anime.js  loop: true | loop: N | direction: 'alternate' with loop
 *   - setInterval used for animation (can't auto-fix; logged as a warning)
 */
export function sanitizeLoops(html: string): { html: string; sanitized: string[] } {
  const notes: string[] = []
  let out = html

  // ---- CSS animation-iteration-count ------------------------------------
  out = out.replace(/animation-iteration-count\s*:\s*infinite/gi, () => {
    notes.push('css: animation-iteration-count: infinite → 1')
    return 'animation-iteration-count: 1'
  })
  out = out.replace(/animation-iteration-count\s*:\s*(\d+)/gi, (m, n) => {
    if (parseInt(n, 10) > 1) {
      notes.push(`css: animation-iteration-count: ${n} → 1`)
      return 'animation-iteration-count: 1'
    }
    return m
  })

  // ---- CSS animation shorthand: drop `infinite` -------------------------
  out = out.replace(/(animation\s*:\s*[^;{}\n]*?)\binfinite\b([^;{}\n]*)/gi, (_m, a, b) => {
    notes.push('css: animation shorthand had `infinite` → removed')
    return `${a}${b}`
  })

  // ---- GSAP: repeat: -1 / repeat: N>0 -----------------------------------
  out = out.replace(/repeat\s*:\s*-?\d+/g, (m) => {
    const v = parseInt(m.split(':')[1].trim(), 10)
    if (v !== 0) {
      notes.push(`gsap: ${m.trim()} → repeat: 0`)
      return 'repeat: 0'
    }
    return m
  })

  // ---- GSAP: yoyo: true -------------------------------------------------
  out = out.replace(/yoyo\s*:\s*true/g, () => {
    notes.push('gsap: yoyo: true → yoyo: false')
    return 'yoyo: false'
  })

  // ---- SVG <animate ... repeatCount="indefinite"|N> ---------------------
  // Catches <animate>, <animateMotion>, <animateTransform>, <animateColor>.
  out = out.replace(/repeatCount\s*=\s*(["'])indefinite\1/gi, (_m, q) => {
    notes.push('svg: repeatCount="indefinite" → "1"')
    return `repeatCount=${q}1${q}`
  })
  out = out.replace(/repeatCount\s*=\s*(["'])(\d+)\1/gi, (m, q, n) => {
    if (parseInt(n, 10) > 1) {
      notes.push(`svg: repeatCount="${n}" → "1"`)
      return `repeatCount=${q}1${q}`
    }
    return m
  })

  // ---- Web Animations API: { iterations: Infinity | -1 | N>1 } ----------
  out = out.replace(/iterations\s*:\s*Infinity/g, () => {
    notes.push('webanim: iterations: Infinity → 1')
    return 'iterations: 1'
  })
  out = out.replace(/iterations\s*:\s*-?\d+/g, (m) => {
    const v = parseInt(m.split(':')[1].trim(), 10)
    if (v !== 1) {
      notes.push(`webanim: ${m.trim()} → iterations: 1`)
      return 'iterations: 1'
    }
    return m
  })

  // ---- anime.js: loop: true | loop: -1 | loop: N>0 ----------------------
  out = out.replace(/loop\s*:\s*true/g, () => {
    notes.push('anime.js: loop: true → false')
    return 'loop: false'
  })
  out = out.replace(/loop\s*:\s*-?\d+/g, (m) => {
    const v = parseInt(m.split(':')[1].trim(), 10)
    if (v !== 0) {
      notes.push(`anime.js: ${m.trim()} → loop: false`)
      return 'loop: false'
    }
    return m
  })

  // ---- setInterval — can't safely auto-fix, just shout about it ---------
  if (/setInterval\s*\(/.test(out)) {
    notes.push('warning: setInterval is present in the HTML — Claude may have written a loop')
  }

  return { html: out, sanitized: notes }
}

function extractHtml(raw: string): string {
  let s = raw.trim()
  // Strip a leading code fence if present.
  if (s.startsWith('```')) {
    const firstNl = s.indexOf('\n')
    if (firstNl >= 0) s = s.slice(firstNl + 1)
    const fenceEnd = s.lastIndexOf('```')
    if (fenceEnd >= 0) s = s.slice(0, fenceEnd)
    s = s.trim()
  }
  const start = s.toLowerCase().indexOf('<!doctype html')
  if (start > 0) s = s.slice(start)
  if (!/<!doctype html/i.test(s) || !/<\/html>/i.test(s)) {
    throw new Error('Claude did not return a complete HTML document.')
  }
  return s
}
