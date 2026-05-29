import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface RenderArgs {
  command: string // e.g. "npx hyperframes" or absolute binary
  projectDir: string
  outputMp4: string
  onLog?: (line: string) => void
}

/**
 * Scaffold a minimal Hyperframes project containing an index.html written by Claude.
 * Hyperframes expects index.html (with a #stage element) and an assets/ folder.
 */
export async function scaffoldProject(projectDir: string, indexHtml: string): Promise<void> {
  await fs.promises.mkdir(projectDir, { recursive: true })
  await fs.promises.mkdir(path.join(projectDir, 'assets'), { recursive: true })
  await fs.promises.mkdir(path.join(projectDir, 'compositions'), { recursive: true })
  await fs.promises.writeFile(path.join(projectDir, 'index.html'), indexHtml, 'utf8')
}

export async function renderHyperframes(args: RenderArgs): Promise<void> {
  await fs.promises.mkdir(path.dirname(args.outputMp4), { recursive: true })
  const { cmd, baseArgs } = splitCommand(args.command)
  const fullArgs = [...baseArgs, 'render', '--output', args.outputMp4]
  await run(cmd, fullArgs, args.projectDir, args.onLog)
}

function splitCommand(command: string): { cmd: string; baseArgs: string[] } {
  const parts = command.trim().split(/\s+/)
  if (parts.length === 0) throw new Error('hyperframes command is empty in settings')
  return { cmd: parts[0], baseArgs: parts.slice(1) }
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
  onLog?: (line: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32'
    // On Windows, npx/node CLIs are .cmd files — spawn needs shell:true to find them.
    const p = spawn(cmd, args, {
      cwd,
      shell: isWindows,
      windowsHide: true,
      env: process.env
    })
    let stderrTail = ''
    p.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      if (onLog) for (const line of text.split(/\r?\n/)) if (line.trim()) onLog(line)
    })
    p.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      stderrTail = (stderrTail + text).slice(-4000)
      if (onLog) for (const line of text.split(/\r?\n/)) if (line.trim()) onLog(line)
    })
    p.on('error', reject)
    p.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`hyperframes exited ${code}: ${stderrTail}`))
    })
  })
}
