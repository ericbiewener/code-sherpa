import { z } from 'zod'
import { harnesses } from './types'

const text = z.string().trim().min(1)
export const idSchema = text.max(512)
export const newSessionSchema = z.object({
  profileId: text.max(120),
  harness: z.enum(harnesses).optional(),
  cwd: text.max(4096),
  model: text.max(200).optional(),
  resumeId: text.max(4096).optional(),
})
export const commandSchema = text
  .max(8192)
  .refine((value) => !/[\0\r\n]/.test(value), 'Use a single-line command')
export const commandSettingsSchema = z.object({
  name: z
    .string()
    .trim()
    .max(80, 'Names must be 80 characters or fewer')
    .refine((value) => !/[\0\r\n]/.test(value), 'Use a single-line name'),
  command: commandSchema,
})
export const configSchema = z
  .object({
    version: z.literal(1),
    defaultProfileId: text.max(120).optional(),
    profiles: z
      .array(
        z.object({
          id: text.max(120),
          name: text.max(80),
          harness: z.enum(harnesses).optional(),
          command: commandSchema,
        }),
      )
      .max(50),
  })
  .superRefine((config, context) => {
    if (new Set(config.profiles.map((p) => p.id)).size !== config.profiles.length) {
      context.addIssue({
        code: 'custom',
        message: 'Profile IDs must be unique',
        path: ['profiles'],
      })
    }
    if (config.defaultProfileId && !config.profiles.some((p) => p.id === config.defaultProfileId)) {
      context.addIssue({
        code: 'custom',
        message: 'Choose an existing default profile',
        path: ['defaultProfileId'],
      })
    }
  })
export const promptSchema = text.max(200_000)
export const replySchema = z.object({
  approved: z.boolean(),
  answers: z.record(z.string(), z.string().max(50_000)).optional(),
})
