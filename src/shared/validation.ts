import { z } from 'zod'
import { claudeEfforts, codexEfforts, harnesses, piThinkingLevels } from './types'

const text = z.string().trim().min(1)
const singleLine = text.refine((value) => !/[\0\r\n]/.test(value), 'Use a single line')
const model = singleLine.max(200).optional()
export const idSchema = text.max(512)
export const promptSchema = text.max(200_000)
export const prUrlSchema = text
  .max(8192)
  .url()
  .refine((value) => /^https?:\/\//i.test(value), 'Enter an HTTP or HTTPS pull request URL.')
export const newSessionSchema = z
  .object({
    profileId: text.max(120),
    initialPrompt: promptSchema.optional(),
    prUrl: prUrlSchema.optional(),
    cwd: text.max(4096),
    resumeId: text.max(4096).optional(),
  })
  .strict()

const commonSettings = {
  name: z
    .string()
    .trim()
    .max(80)
    .refine((value) => !/[\0\r\n]/.test(value), 'Use a single-line name'),
  executable: singleLine.max(4096).optional(),
  configDir: singleLine
    .max(4096)
    .refine(
      (value) => /^(?:\/|[A-Za-z]:[\\/]|\\\\|~(?:\/|$))/.test(value),
      'Use an absolute configuration directory path or ~/path',
    )
    .optional(),
}
const codexSettings = z
  .object({
    ...commonSettings,
    harness: z.literal('codex'),
    options: z
      .object({
        model,
        reasoningEffort: z.enum(codexEfforts).optional(),
        approvalPolicy: z.enum(['untrusted', 'on-request', 'never']).optional(),
        sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
      })
      .strict(),
  })
  .strict()
const claudeSettings = z
  .object({
    ...commonSettings,
    harness: z.literal('claude'),
    options: z
      .object({
        model,
        effort: z.enum(claudeEfforts).optional(),
        permissionMode: z
          .enum(['default', 'acceptEdits', 'plan', 'dontAsk', 'auto', 'bypassPermissions'])
          .optional(),
        maxTurns: z.number().int().positive().max(10000).optional(),
      })
      .strict(),
  })
  .strict()
const piSettings = z
  .object({
    ...commonSettings,
    harness: z.literal('pi'),
    options: z
      .object({
        provider: singleLine.max(200).optional(),
        model,
        thinking: z.enum(piThinkingLevels).optional(),
      })
      .strict()
      .refine((options) => !options.provider || !!options.model, {
        message: 'Pi requires a model when a provider is selected',
        path: ['model'],
      }),
  })
  .strict()
export const agentSettingsSchema = z.discriminatedUnion('harness', [
  codexSettings,
  claudeSettings,
  piSettings,
])
export const settingsMigrationSchema = z.object({
  command: z.string(),
  issues: z.array(z.string()).min(1),
  needsIntegration: z.boolean().optional(),
})
const profileFields = { id: text.max(120), migration: settingsMigrationSchema.optional() }
const profileSchema = z.discriminatedUnion('harness', [
  codexSettings.extend(profileFields),
  claudeSettings.extend(profileFields),
  piSettings.extend(profileFields),
])
const configFields = { defaultProfileId: text.max(120).optional() }
function checkProfiles(
  config: { defaultProfileId?: string; profiles: { id: string }[] },
  context: z.RefinementCtx,
) {
  if (new Set(config.profiles.map((p) => p.id)).size !== config.profiles.length)
    context.addIssue({ code: 'custom', message: 'Profile IDs must be unique', path: ['profiles'] })
  if (config.defaultProfileId && !config.profiles.some((p) => p.id === config.defaultProfileId))
    context.addIssue({
      code: 'custom',
      message: 'Choose an existing default profile',
      path: ['defaultProfileId'],
    })
}
export const configSchema = z
  .object({
    version: z.literal(2),
    ...configFields,
    profiles: z.array(profileSchema).max(50),
  })
  .strict()
  .superRefine(checkProfiles)
// Only the migration reader accepts command strings. New settings never do.
export const legacyConfigSchema = z
  .object({
    version: z.literal(1),
    ...configFields,
    profiles: z
      .array(
        z.object({
          id: text.max(120),
          name: singleLine.max(80),
          harness: z.enum(harnesses).optional(),
          command: singleLine.max(8192),
        }),
      )
      .max(50),
  })
  .superRefine(checkProfiles)
export const replySchema = z.object({
  approved: z.boolean(),
  answers: z.record(z.string(), z.string().max(50_000)).optional(),
})
