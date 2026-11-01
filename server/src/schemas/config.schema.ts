import { z } from "zod";
import { MAX_RULE_PATTERN_CHARS, MAX_RULES, dashboardOverrideSchema } from "../review/config/schema.ts";
import { forgeProviderSchema } from "../review/core/models.ts";

// Replaces the global config as a whole; an empty object resets it to the
// profile and the defaults.
export const updateGlobalConfigSchema = z.object({
  settings: dashboardOverrideSchema,
});

// The display preview: `base` is what the form inherits (the profile and
// defaults, or the global config for a repository) and `settings` what the
// form sets on top, so the preview follows unsaved edits. `base` is a resolved
// config sent back as is, which dashboard settings accept.
export const configPreviewSchema = z.object({
  provider: forgeProviderSchema,
  base: dashboardOverrideSchema,
  settings: dashboardOverrideSchema,
});

// The rule editor checks patterns as they are typed, against the same RE2 the
// worker compiles them with: the browser's own regex engine accepts
// lookarounds and backreferences that RE2 rejects.
export const checkRulePatternsSchema = z.object({
  patterns: z.array(z.string().max(MAX_RULE_PATTERN_CHARS)).max(MAX_RULES),
});

// The Triggers tab's "will this be reviewed?" check: the same base and
// settings as the preview, plus a sample change and what happened to it.
// Bounds are generous for a hand-typed sample but keep the body small.
export const triggerCheckSchema = z.object({
  base: dashboardOverrideSchema,
  settings: dashboardOverrideSchema,
  event: z.enum(["opened", "push", "command"]),
  change: z.object({
    title: z.string().max(500),
    author: z.string().max(100),
    labels: z.array(z.string().max(100)).max(50),
    headRef: z.string().max(255),
    baseRef: z.string().max(255),
    isDraft: z.boolean(),
  }),
  // Whoever opened or pushed, when it is not the author.
  actor: z.string().max(100).optional(),
});
