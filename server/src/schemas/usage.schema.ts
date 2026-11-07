import { z } from "zod";
import { pageSchema } from "./pagination.ts";
import { USAGE_PERIODS } from "../services/usage.ts";

export const usageQuerySchema = z.object({
  period: z.enum(USAGE_PERIODS).default("7d"),
  repoId: z.uuid().optional(),
});

// The default matches the dashboard's first page size.
export const recentUsageQuerySchema = usageQuerySchema.extend({
  page: pageSchema,
  limit: z.coerce.number().int().min(1).max(100).default(10),
});
