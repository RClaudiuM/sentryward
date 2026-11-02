import { z } from "zod";

export const workspaceNameSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
});

export const workspaceParamsSchema = z.object({ id: z.string() });

export const memberParamsSchema = z.object({ id: z.string(), userId: z.uuid() });

export const inviteParamsSchema = z.object({ id: z.string(), inviteId: z.uuid() });

export const updateMemberSchema = z.object({
  role: z.enum(["owner", "admin", "member"]),
});

// Owners are made by promotion, so an invite cannot hand out ownership.
export const createWorkspaceInviteSchema = z.object({
  email: z.string().trim().toLowerCase().email("Invalid email address").optional(),
  role: z.enum(["admin", "member"]).default("member"),
});

// Exact email for an invitation, or a direct addition when the instance allows it.
export const addMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email("Invalid email address"),
  role: z.enum(["admin", "member"]).default("member"),
});
