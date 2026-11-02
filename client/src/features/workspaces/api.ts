import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import type { Workspace, WorkspaceRole } from "@/features/auth/auth-context"

// The session's list; AuthProvider owns the query, these mutations refresh it.
const WORKSPACES_KEY = ["auth", "workspaces"]
const membersKey = (id: string) => ["workspaces", id, "members"]
const invitesKey = (id: string) => ["workspaces", id, "invites"]
const candidatesKey = (id: string) => ["workspaces", id, "candidates"]

export interface Member {
  id: string
  name: string
  email: string
  role: WorkspaceRole
  joinedAt: string
}

// An account that is not in the team yet, offered by the add-member picker.
export interface MemberCandidate {
  id: string
  name: string
  email: string
  avatarUpdatedAt: string | null
}

export type InviteRole = Exclude<WorkspaceRole, "owner">

export interface WorkspaceInvite {
  id: string
  email: string | null
  role: InviteRole
  expiresAt: string
  createdAt: string
  invitedBy: { name: string } | null
}

export interface CreatedWorkspaceInvite {
  invite: WorkspaceInvite
  // Shown once: the server keeps only a hash of the token.
  link: string
  emailed: boolean
}

export function useCreateWorkspace() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (name: string) =>
      api<{ workspace: Workspace }>("/workspaces", { method: "POST", body: JSON.stringify({ name }) }).then(
        (body) => body.workspace,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: WORKSPACES_KEY }),
  })
}

export function useRenameWorkspace(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (name: string) =>
      api<{ workspace: Workspace }>(`/workspaces/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: WORKSPACES_KEY }),
  })
}

// Refreshing the list drops the workspace, which sends you back to your
// personal one.
export function useDeleteWorkspace(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api<void>(`/workspaces/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: WORKSPACES_KEY }),
  })
}

export function useMembers(id: string) {
  return useQuery({
    queryKey: membersKey(id),
    queryFn: () => api<{ members: Member[]; allowDirectMemberAdd: boolean }>(`/workspaces/${id}/members`),
  })
}

export function useMemberCandidates(id: string, enabled: boolean) {
  return useQuery({
    queryKey: candidatesKey(id),
    queryFn: () => api<{ users: MemberCandidate[] }>(`/workspaces/${id}/member-candidates`).then((body) => body.users),
    enabled,
  })
}

// The server returns an invitation unless the instance opts into direct additions.
export function useAddMember(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { email: string; role: InviteRole }) =>
      api<{ member: Member } | CreatedWorkspaceInvite>(`/workspaces/${id}/members`, { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: invitesKey(id) })
      queryClient.invalidateQueries({ queryKey: membersKey(id) })
      queryClient.invalidateQueries({ queryKey: candidatesKey(id) })
    },
  })
}

// Your own role may be the one changing, so the session list refreshes too.
export function useUpdateMember(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: WorkspaceRole }) =>
      api<{ member: { id: string; role: WorkspaceRole } }>(`/workspaces/${id}/members/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: membersKey(id) })
      queryClient.invalidateQueries({ queryKey: WORKSPACES_KEY })
    },
  })
}

// Removing yourself is leaving the workspace.
export function useRemoveMember(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) => api<void>(`/workspaces/${id}/members/${userId}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: membersKey(id) })
      queryClient.invalidateQueries({ queryKey: WORKSPACES_KEY })
    },
  })
}

export function useWorkspaceInvites(id: string, enabled: boolean) {
  return useQuery({
    queryKey: invitesKey(id),
    queryFn: () => api<{ invites: WorkspaceInvite[] }>(`/workspaces/${id}/invites`).then((body) => body.invites),
    enabled,
  })
}

export function useCreateWorkspaceInvite(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { email?: string; role: InviteRole }) =>
      api<CreatedWorkspaceInvite>(`/workspaces/${id}/invites`, { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: invitesKey(id) }),
  })
}

// Issues a fresh link (the old one stops working) and renews the expiry, so
// the list refreshes too.
export function useResendWorkspaceInvite(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (inviteId: string) =>
      api<{ invite: WorkspaceInvite }>(`/workspaces/${id}/invites/${inviteId}/resend`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: invitesKey(id) }),
  })
}

export function useRevokeWorkspaceInvite(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (inviteId: string) => api<void>(`/workspaces/${id}/invites/${inviteId}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: invitesKey(id) }),
  })
}
