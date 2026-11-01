import { z } from "zod";

// USD per million tokens; generous ceiling so a typo of a few orders of
// magnitude is caught.
const rate = z.number({ error: "Enter a price" }).min(0, "A price cannot be negative").max(10_000, "That price is too high");

const modelId = z
  .string()
  .trim()
  .min(1, "Enter a model")
  .max(200)
  .regex(/^[^\s]+$/, "A model id has no spaces");

export const saveModelPriceSchema = z.object({
  model: modelId,
  input: rate,
  output: rate,
  cached: rate.nullable().optional(),
  cacheWrite: rate.nullable().optional(),
  reasoning: rate.nullable().optional(),
});

export const modelPriceIdParamSchema = z.object({ id: z.uuid() });

export const modelPriceLookupSchema = z.object({ model: modelId });
