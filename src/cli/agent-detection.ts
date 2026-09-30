import type { Environment } from './terminal.ts'

/**
 * Variables that coding agents set in the shells they run commands in. `CLAUDECODE` is set by Claude
 * Code, `CODEX_THREAD_ID` and `CODEX_SANDBOX` by Codex, `CURSOR_AGENT` by Cursor's agent, `GEMINI_CLI`
 * by Gemini CLI, and `AGENT` and `AI_AGENT` are the generic names any agent may set.
 */
export const agentVariables: readonly string[] = [
  'CLAUDECODE',
  'CODEX_THREAD_ID',
  'CODEX_SANDBOX',
  'CURSOR_AGENT',
  'GEMINI_CLI',
  'AGENT',
  'AI_AGENT',
]

const offValues = new Set(['', '0', 'false'])

/**
 * Whether a coding agent is running Retest, going by its environment.
 *
 * @example isCodingAgent({ CLAUDECODE: '1' }) // true
 */
export function isCodingAgent(env: Environment): boolean {
  return agentVariables.some((name) => {
    const setting = env[name]
    return setting !== undefined && !offValues.has(setting.trim().toLowerCase())
  })
}
