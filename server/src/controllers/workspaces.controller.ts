import type { Request, Response } from "express";
import { HttpError } from "../lib/httpError.ts";
import { prisma } from "../lib/prisma.ts";
import { createInvite, publicInvite, resendInvite } from "../services/invites.ts";
import { isUniqueViolation } from "../services/users.ts";
import { removeWebhook } from "../services/webhooks.ts";
import {
  assertAnotherOwnerRemains,
  loadMembership,
  requireRole,
  workspacesFor,
  type WorkspaceAccess,
} from "../services/workspaces.ts";
import {
  addMemberSchema,
  createWorkspaceInviteSchema,
  inviteParamsSchema,
  memberParamsSchema,
  updateMemberSchema,
  workspaceNameSchema,
  workspaceParamsSchema,
} from "../schemas/workspaces.schema.ts";

// Personal workspaces stay private to their owner: no members, no invites.
function requireTeam(access: WorkspaceAccess, message: string) {
  if (access.personal) {
    throw new HttpError(400, message);
  }
}

export async function listWorkspaces(req: Request, res: Response) {
  res.json({ workspaces: await workspacesFor(req.userId!) });
}

export async function createWorkspace(req: Request, res: Response) {
  const { name } = workspaceNameSchema.parse(req.body);
  const workspace = await prisma.workspace.create({
    data: { name, memberships: { create: { userId: req.userId!, role: "owner" } } },
    select: { id: true, name: true },
  });
  res.status(201).json({ workspace: { ...workspace, personal: false, role: "owner" } });
}

export async function renameWorkspace(req: Request, res: Response) {
  const { id } = workspaceParamsSchema.parse(req.params);
  const { name } = workspaceNameSchema.parse(req.body);
  const access = await loadMembership(req.userId!, id);
  requireRole(access.role, "owner");
  requireTeam(access, "Your personal workspace cannot be renamed");
  const workspace = await prisma.workspace.update({ where: { id: access.workspaceId }, data: { name }, select: { id: true, name: true } });
  res.json({ workspace: { ...workspace, personal: false, role: access.role } });
}

// Everything in the workspace cascades from its row; Sentryward's hooks are taken
// off the forge first, while the credentials still work.
export async function deleteWorkspace(req: Request, res: Response) {
  const { id } = workspaceParamsSchema.parse(req.params);
  const access = await loadMembership(req.userId!, id);
  requireRole(access.role, "owner");
  requireTeam(access, "Your personal workspace is deleted with your account");

  const connections = await prisma.forgeConnection.findMany({
    where: { workspaceId: access.workspaceId },
    include: { repositories: true },
  });
  for (const connection of connections) {
    for (const repo of connection.repositories) {
      await removeWebhook(repo, connection).catch(() => undefined);
    }
  }
  await prisma.workspace.delete({ where: { id: access.workspaceId } });
  res.status(204).end();
}

export async function listMembers(req: Request, res: Response) {
  const { id } = workspaceParamsSchema.parse(req.params);
  const access = await loadMembership(req.userId!, id);
  const memberships = await prisma.membership.findMany({
    where: { workspaceId: access.workspaceId },
    select: { role: true, createdAt: true, user: { select: { id: true, name: true, email: true, avatarUpdatedAt: true } } },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
  });
  res.json({
    allowDirectMemberAdd: await allowDirectMemberAdd(),
    members: memberships.map(({ user, role, createdAt }) => ({ ...user, role, joinedAt: createdAt })),
  });
}

// Account discovery and immediate membership require an explicit instance opt-in.
async function allowDirectMemberAdd(): Promise<boolean> {
  const settings = await prisma.instanceSettings.findUnique({ where: { id: 1 }, select: { allowDirectMemberAdd: true } });
  return settings?.allowDirectMemberAdd ?? false;
}

export async function listMemberCandidates(req: Request, res: Response) {
  const { id } = workspaceParamsSchema.parse(req.params);
  const access = await loadMembership(req.userId!, id);
  requireRole(access.role, "admin");
  requireTeam(access, "Create a team workspace to add people");
  if (!(await allowDirectMemberAdd())) {
    throw new HttpError(403, "Account discovery is disabled on this instance");
  }
  const users = await prisma.user.findMany({
    where: { memberships: { none: { workspaceId: access.workspaceId } } },
    select: { id: true, name: true, email: true, avatarUpdatedAt: true },
    orderBy: { name: "asc" },
  });
  res.json({ users });
}

export async function addMember(req: Request, res: Response) {
  const { id } = workspaceParamsSchema.parse(req.params);
  const { email, role } = addMemberSchema.parse(req.body);
  const access = await loadMembership(req.userId!, id);
  requireRole(access.role, "admin");
  requireTeam(access, "Create a team workspace to add people");

  if (!(await allowDirectMemberAdd())) {
    await sendWorkspaceInvite(req, res, access.workspaceId, email, role);
    return;
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, name: true, email: true, avatarUpdatedAt: true },
  });
  if (!user) {
    throw new HttpError(400, "Validation failed", { email: ["No Sentryward account uses this email; invite them instead"] });
  }
  // The unique (user, workspace) key catches an existing member and a
  // concurrent add alike.
  const membership = await prisma.membership
    .create({ data: { userId: user.id, workspaceId: access.workspaceId, role }, select: { role: true, createdAt: true } })
    .catch((err: unknown) => {
      if (isUniqueViolation(err)) {
        throw new HttpError(409, "Validation failed", { email: ["This person is already a member"] });
      }
      throw err;
    });
  res.status(201).json({ member: { ...user, role: membership.role, joinedAt: membership.createdAt } });
}

// Admins manage members and admins; only owners grant, revoke or hold the
// owner role.
export async function updateMember(req: Request, res: Response) {
  const { id, userId } = memberParamsSchema.parse(req.params);
  const { role } = updateMemberSchema.parse(req.body);
  const access = await loadMembership(req.userId!, id);
  requireRole(access.role, "admin");
  requireTeam(access, "Your personal workspace has no other members");

  const member = await prisma.$transaction(async (tx) => {
    const target = await tx.membership.findUnique({
      where: { userId_workspaceId: { userId, workspaceId: access.workspaceId } },
    });
    if (!target) {
      throw new HttpError(404, "Member not found");
    }
    if (role === "owner" || target.role === "owner") {
      requireRole(access.role, "owner");
    }
    if (target.role === "owner" && role !== "owner") {
      await assertAnotherOwnerRemains(tx, access.workspaceId, userId);
    }
    return tx.membership.update({ where: { id: target.id }, data: { role }, select: { role: true } });
  });
  res.json({ member: { id: userId, role: member.role } });
}

// Removing yourself is leaving, which any member may do.
export async function removeMember(req: Request, res: Response) {
  const { id, userId } = memberParamsSchema.parse(req.params);
  const access = await loadMembership(req.userId!, id);
  requireTeam(access, "You cannot leave your personal workspace");
  const self = userId === req.userId;
  if (!self) requireRole(access.role, "admin");

  await prisma.$transaction(async (tx) => {
    const target = await tx.membership.findUnique({
      where: { userId_workspaceId: { userId, workspaceId: access.workspaceId } },
    });
    if (!target) {
      throw new HttpError(404, "Member not found");
    }
    if (target.role === "owner") {
      if (!self) requireRole(access.role, "owner");
      await assertAnotherOwnerRemains(tx, access.workspaceId, userId);
    }
    await tx.membership.delete({ where: { id: target.id } });
  });
  res.status(204).end();
}

export async function listWorkspaceInvites(req: Request, res: Response) {
  const { id } = workspaceParamsSchema.parse(req.params);
  const access = await loadMembership(req.userId!, id);
  requireRole(access.role, "admin");
  const invites = await prisma.invite.findMany({
    where: { workspaceId: access.workspaceId, acceptedAt: null, expiresAt: { gt: new Date() } },
    select: publicInvite,
    orderBy: { createdAt: "desc" },
  });
  res.json({ invites });
}

export async function createWorkspaceInvite(req: Request, res: Response) {
  const { id } = workspaceParamsSchema.parse(req.params);
  const { email, role } = createWorkspaceInviteSchema.parse(req.body);
  const access = await loadMembership(req.userId!, id);
  requireRole(access.role, "admin");
  requireTeam(access, "Create a team workspace to invite people");

  await sendWorkspaceInvite(req, res, access.workspaceId, email, role);
}

// Both entry points share email binding, membership checks and delivery without
// looking up whether an invited address has an account.
async function sendWorkspaceInvite(
  req: Request,
  res: Response,
  workspaceId: string,
  email: string | undefined,
  role: "admin" | "member",
) {
  if (email) {
    const member = await prisma.membership.findFirst({
      where: { workspaceId, user: { email } },
      select: { id: true },
    });
    if (member) {
      throw new HttpError(409, "Validation failed", { email: ["This person is already a member"] });
    }
  }
  const [inviter, workspace] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: req.userId }, select: { name: true } }),
    prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { id: true, name: true } }),
  ]);
  const result = await createInvite({
    email,
    invitedById: req.userId!,
    inviterName: inviter.name,
    workspace: { ...workspace, role },
  });
  res.status(201).json(result);
}

export async function revokeWorkspaceInvite(req: Request, res: Response) {
  const { id, inviteId } = inviteParamsSchema.parse(req.params);
  const access = await loadMembership(req.userId!, id);
  requireRole(access.role, "admin");
  const { count } = await prisma.invite.deleteMany({
    where: { id: inviteId, workspaceId: access.workspaceId, acceptedAt: null },
  });
  if (count === 0) {
    throw new HttpError(404, "Invite not found");
  }
  res.status(204).end();
}

// A new link for an email invite; the one sent before stops working.
export async function resendWorkspaceInvite(req: Request, res: Response) {
  const { id, inviteId } = inviteParamsSchema.parse(req.params);
  const access = await loadMembership(req.userId!, id);
  requireRole(access.role, "admin");
  const [inviter, workspace] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: req.userId }, select: { name: true } }),
    prisma.workspace.findUniqueOrThrow({ where: { id: access.workspaceId }, select: { id: true, name: true } }),
  ]);
  const invite = await resendInvite(inviteId, inviter.name, workspace);
  res.json({ invite });
}
