import { z } from "zod";
import { HttpError } from "../lib/httpError.ts";
import { atLeast } from "../lib/workspaceRoles.ts";
import { prisma } from "../lib/prisma.ts";
import type { Prisma, WorkspaceRole } from "../generated/prisma/client.ts";
import { removeWebhook } from "./webhooks.ts";

export const WORKSPACE_HEADER = "x-sentryward-workspace";

const uuid = z.uuid();

export interface WorkspaceAccess {
  workspaceId: string;
  role: WorkspaceRole;
  personal: boolean;
}

// The one access check for workspace data. An unknown workspace and one the
// user is not in get the same 404, so ids cannot be probed. `id` undefined
// means the user's personal workspace.
export async function loadMembership(userId: string, id?: string): Promise<WorkspaceAccess> {
  if (id !== undefined && !uuid.safeParse(id).success) {
    throw new HttpError(404, "Workspace not found");
  }
  const membership = await prisma.membership.findFirst({
    where: id === undefined ? { userId, workspace: { personalOwnerId: userId } } : { userId, workspaceId: id },
    select: { workspaceId: true, role: true, workspace: { select: { personalOwnerId: true } } },
  });
  if (!membership) {
    throw new HttpError(404, "Workspace not found");
  }
  return {
    workspaceId: membership.workspaceId,
    role: membership.role,
    personal: membership.workspace.personalOwnerId !== null,
  };
}

export function requireRole(role: WorkspaceRole, required: WorkspaceRole): void {
  if (!atLeast(role, required)) {
    throw new HttpError(403, `Only workspace ${required === "owner" ? "owners" : "admins"} can do this`);
  }
}

// Every user has one, created with the account.
export async function createPersonalWorkspace(tx: Prisma.TransactionClient, user: { id: string; name: string }) {
  return tx.workspace.create({
    data: {
      name: user.name,
      personalOwnerId: user.id,
      memberships: { create: { userId: user.id, role: "owner" } },
    },
  });
}

// What the client needs to list and switch workspaces.
export async function workspacesFor(userId: string) {
  const memberships = await prisma.membership.findMany({
    where: { userId },
    select: { role: true, workspace: { select: { id: true, name: true, personalOwnerId: true } } },
    orderBy: { createdAt: "asc" },
  });
  return memberships
    .map(({ role, workspace }) => ({
      id: workspace.id,
      name: workspace.name,
      personal: workspace.personalOwnerId !== null,
      role,
    }))
    .sort((a, b) => Number(b.personal) - Number(a.personal));
}

// Call inside the transaction that demotes or removes `userId` from the
// workspace. Locking the owner rows serializes two owners demoting each other.
export async function assertAnotherOwnerRemains(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const owners = await tx.$queryRaw<{ user_id: string }[]>`
    SELECT user_id FROM memberships
    WHERE workspace_id = ${workspaceId}::uuid AND role = 'owner'
    ORDER BY id FOR UPDATE
  `;
  if (owners.some((owner) => owner.user_id === userId) && owners.length === 1) {
    throw new HttpError(409, "A workspace needs at least one owner; make someone else an owner first");
  }
}

// Call inside the transaction that deletes `userId`. Their personal workspace
// cascades with them, and so does any team where they are the only member. A
// team that keeps members must keep an owner: a user deleting themselves has to
// hand ownership over first, while an instance admin removing someone cannot
// act inside the team, so its longest-standing remaining member (admins first)
// is promoted instead.
//
// Each team's memberships are locked before they are read: otherwise two
// owners deleting their accounts at once each see the other and both go,
// leaving the team ownerless. Teams are visited in id order so two deletions
// sharing teams take the locks in the same order and cannot deadlock.
export async function releaseWorkspaces(
  tx: Prisma.TransactionClient,
  userId: string,
  { promoteSuccessor }: { promoteSuccessor: boolean },
): Promise<void> {
  const teams = await tx.membership.findMany({
    where: { userId, workspace: { personalOwnerId: null } },
    select: { workspaceId: true, role: true, workspace: { select: { name: true } } },
    orderBy: { workspaceId: "asc" },
  });
  for (const team of teams) {
    await tx.$queryRaw`
      SELECT id FROM memberships
      WHERE workspace_id = ${team.workspaceId}::uuid
      ORDER BY id FOR UPDATE
    `;
    const others = await tx.membership.findMany({
      where: { workspaceId: team.workspaceId, userId: { not: userId } },
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
      select: { id: true, role: true },
    });
    if (others.length === 0) {
      await tx.workspace.delete({ where: { id: team.workspaceId } });
      continue;
    }
    if (team.role !== "owner" || others.some((other) => other.role === "owner")) continue;
    if (!promoteSuccessor) {
      throw new HttpError(409, `Make someone else an owner of ${team.workspace.name} before deleting your account`);
    }
    await tx.membership.update({ where: { id: others[0]!.id }, data: { role: "owner" } });
  }
}

// Call before the transaction that deletes `userId`, while connection
// credentials are still live. Their personal workspace, and any team where
// they are the only member, are about to cascade-delete (see
// `releaseWorkspaces`); this takes Sentryward's hooks off those repos first,
// best effort, the same way `deleteWorkspace` does for a single workspace.
// Best effort because the transaction re-checks membership under lock and may
// decide differently; removing a hook that turns out not to cascade is
// harmless, unlike leaving one behind that does.
export async function removeCascadingWebhooks(userId: string): Promise<void> {
  const personal = await prisma.workspace.findUnique({
    where: { personalOwnerId: userId },
    select: { id: true },
  });
  const teams = await prisma.membership.findMany({
    where: { userId, workspace: { personalOwnerId: null } },
    select: { workspaceId: true },
  });
  const soleTeamIds: string[] = [];
  for (const team of teams) {
    const others = await prisma.membership.count({
      where: { workspaceId: team.workspaceId, userId: { not: userId } },
    });
    if (others === 0) soleTeamIds.push(team.workspaceId);
  }
  const workspaceIds = personal ? [personal.id, ...soleTeamIds] : soleTeamIds;
  if (workspaceIds.length === 0) return;

  const connections = await prisma.forgeConnection.findMany({
    where: { workspaceId: { in: workspaceIds } },
    include: { repositories: true },
  });
  for (const connection of connections) {
    for (const repo of connection.repositories) {
      await removeWebhook(repo, connection).catch(() => undefined);
    }
  }
}
