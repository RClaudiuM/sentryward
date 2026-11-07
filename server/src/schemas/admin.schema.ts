import { z } from "zod";
import { pageSchema } from "./pagination.ts";

export const idParamsSchema = z.object({ id: z.uuid() });

const roleSchema = z.enum(["admin", "member"]);

export const listUsersQuerySchema = z.object({
  role: roleSchema.optional(),
  q: z.string().trim().max(200).optional(),
  sort: z.enum(["name", "email", "role", "createdAt"]).default("createdAt"),
  dir: z.enum(["asc", "desc"]).default("asc"),
  page: pageSchema,
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(100).optional(),
    email: z.string().trim().toLowerCase().email("Invalid email address").optional(),
    role: roleSchema.optional(),
  })
  .refine((data) => data.name !== undefined || data.email !== undefined || data.role !== undefined, {
    message: "Nothing to update",
    path: ["name"],
  });

export const createInviteSchema = z.object({
  email: z.string().trim().toLowerCase().email("Invalid email address").optional(),
});
