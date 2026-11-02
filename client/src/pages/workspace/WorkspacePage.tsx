import { useMemo, useState, type ReactNode } from "react"
import { Controller, useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Navigate, useNavigate, useSearchParams } from "react-router"
import { Loader2, LogOut, MailPlus, Settings, Trash2, UserMinus, UserPlus, Users } from "lucide-react"
import { toast } from "sonner"
import { z } from "zod"
import { PageHeader } from "@/components/PageHeader"
import { PageShell } from "@/components/PageShell"
import { SearchableSelect, type SelectOption } from "@/components/SearchableSelect"
import { SortableHead } from "@/components/SortableHead"
import {
  ActiveFilterChips,
  FilterPopover,
  FilterSelect,
  FilterToolbar,
  NoMatchesRow,
  SearchInput,
  type ActiveFilter,
} from "@/components/TableFilters"
import { TablePagination } from "@/components/TablePagination"
import { UserAvatar } from "@/components/UserAvatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { Workspace, WorkspaceRole } from "@/features/auth/auth-context"
import { applyServerErrors } from "@/features/auth/applyServerErrors"
import { TextField } from "@/features/auth/TextField"
import { useAuth } from "@/features/auth/useAuth"
import { CreatedInviteView } from "@/features/invites/CreatedInviteView"
import { InviteActions, ResendInviteDialog, RevokeInviteDialog } from "@/features/invites/InviteRowActions"
import {
  useCreateWorkspaceInvite,
  useDeleteWorkspace,
  useMembers,
  useAddMember,
  useMemberCandidates,
  useRemoveMember,
  useRenameWorkspace,
  useResendWorkspaceInvite,
  useRevokeWorkspaceInvite,
  useUpdateMember,
  useWorkspaceInvites,
  type CreatedWorkspaceInvite,
  type InviteRole,
  type Member,
  type MemberCandidate,
  type WorkspaceInvite,
} from "@/features/workspaces/api"
import { paginate, usePagination } from "@/hooks/use-pagination"
import { useSort } from "@/hooks/use-sort"
import { ALL, matchesQuery, selectedLabel } from "@/lib/filters"
import { timeAgo } from "@/lib/time"

const ROLE_LABELS: Record<WorkspaceRole, string> = { owner: "Owner", admin: "Admin", member: "Member" }

// Each tab needs at least this role, as the server requires for its data.
const TAB_ITEMS = [
  { value: "members", label: "Members", icon: Users, role: "member" },
  { value: "invites", label: "Pending invites", icon: MailPlus, role: "admin" },
  { value: "settings", label: "Settings", icon: Settings, role: "owner" },
] as const satisfies readonly { value: string; label: string; icon: typeof Users; role: WorkspaceRole }[]
type Tab = (typeof TAB_ITEMS)[number]["value"]

const RANK: Record<WorkspaceRole, number> = { member: 0, admin: 1, owner: 2 }

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

// Mirrors the server: admins manage admins and members, while granting,
// revoking or holding ownership is for owners.
function manageable(actor: WorkspaceRole, target: WorkspaceRole) {
  if (actor === "owner") return true
  return actor === "admin" && target !== "owner"
}

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  action,
  pending,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  action: string
  pending: boolean
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button variant="destructive" disabled={pending} onClick={onConfirm}>
            {pending && <Loader2 className="animate-spin" />}
            {action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type MemberSortKey = "name" | "email" | "role" | "joinedAt"

const MEMBER_COLUMNS: { key: MemberSortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "email", label: "Email" },
  { key: "role", label: "Role" },
  { key: "joinedAt", label: "Joined" },
]

const MEMBER_ROLE_OPTIONS = [
  { value: "owner", label: "Owner" },
  { value: "admin", label: "Admin" },
  { value: "member", label: "Member" },
]

// Ascending role order is owners first, matching the API's default.
function compareMembers(a: Member, b: Member, key: MemberSortKey) {
  switch (key) {
    case "name":
      return a.name.localeCompare(b.name)
    case "email":
      return a.email.localeCompare(b.email)
    case "role":
      return RANK[b.role] - RANK[a.role]
    case "joinedAt":
      return Date.parse(a.joinedAt) - Date.parse(b.joinedAt)
  }
}

function MembersTable({
  workspace,
  members,
  emptyMessage,
  onLeft,
}: {
  workspace: Workspace
  members: Member[]
  emptyMessage: string
  onLeft: () => void
}) {
  const { user } = useAuth()
  const update = useUpdateMember(workspace.id)
  const remove = useRemoveMember(workspace.id)
  const [removing, setRemoving] = useState<Member | null>(null)
  // Unsorted keeps the API order (owners first, then by join date).
  const { sort, onSort } = useSort<MemberSortKey>()
  const pagination = usePagination()

  const sorted = useMemo(() => {
    if (!sort) return members
    const direction = sort.dir === "asc" ? 1 : -1
    return [...members].sort(
      (a, b) => direction * compareMembers(a, b, sort.key) || Date.parse(a.joinedAt) - Date.parse(b.joinedAt),
    )
  }, [members, sort])
  const page = paginate(sorted, pagination.page, pagination.size)

  async function changeRole(member: Member, role: WorkspaceRole) {
    try {
      await update.mutateAsync({ userId: member.id, role })
      toast.success(`${member.name} is now ${ROLE_LABELS[role].toLowerCase()}`)
    } catch (error) {
      toast.error(errorMessage(error, "Could not change the role"))
    }
  }

  async function confirmRemove() {
    if (!removing) return
    const self = removing.id === user?.id
    try {
      await remove.mutateAsync(removing.id)
      setRemoving(null)
      if (self) {
        toast.success(`You left ${workspace.name}`)
        onLeft()
      } else {
        toast.success(`${removing.name} was removed`)
      }
    } catch (error) {
      toast.error(errorMessage(error, "Could not remove the member"))
    }
  }

  // Only owners can hand out ownership, so admins never see the option.
  const roleOptions: WorkspaceRole[] = workspace.role === "owner" ? ["owner", "admin", "member"] : ["admin", "member"]
  const removingSelf = removing?.id === user?.id

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            {MEMBER_COLUMNS.map((column) => (
              <SortableHead
                key={column.key}
                label={column.label}
                sortKey={column.key}
                sort={sort}
                onSort={(key) => {
                  onSort(key)
                  pagination.setPage(1)
                }}
              />
            ))}
            <TableHead className="w-0">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {!sorted.length && <NoMatchesRow colSpan={5}>{emptyMessage}</NoMatchesRow>}
          {page.rows.map((member) => {
            const self = member.id === user?.id
            const canManage = !self && manageable(workspace.role, member.role)
            return (
              <TableRow key={member.id}>
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2">
                    <UserAvatar user={member} size="sm" />
                    {member.name}
                    {self && <Badge variant="secondary">You</Badge>}
                  </div>
                </TableCell>
                <TableCell>{member.email}</TableCell>
                <TableCell>
                  {canManage ? (
                    <Select
                      value={member.role}
                      onValueChange={(role) => changeRole(member, role as WorkspaceRole)}
                      disabled={update.isPending}
                    >
                      <SelectTrigger size="sm" className="w-32" aria-label={`Role for ${member.name}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {roleOptions.map((role) => (
                          <SelectItem key={role} value={role}>
                            {ROLE_LABELS[role]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Badge variant="outline">{ROLE_LABELS[member.role]}</Badge>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground" title={new Date(member.joinedAt).toLocaleString()}>
                  {timeAgo(member.joinedAt)}
                </TableCell>
                <TableCell className="text-right">
                  {self ? (
                    <Button variant="ghost" size="sm" onClick={() => setRemoving(member)}>
                      <LogOut />
                      Leave
                    </Button>
                  ) : (
                    canManage && (
                      <Button variant="ghost" size="sm" onClick={() => setRemoving(member)} aria-label={`Remove ${member.name}`}>
                        <UserMinus />
                        Remove
                      </Button>
                    )
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      {page.total > 0 && (
        <TablePagination
          page={page.page}
          size={pagination.size}
          total={page.total}
          onPageChange={pagination.setPage}
          onSizeChange={pagination.setSize}
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={removingSelf ? `Leave ${workspace.name}?` : `Remove ${removing?.name ?? ""}?`}
        description={
          removingSelf
            ? "You lose access to this team's repositories and reviews until someone invites you again."
            : "They lose access to this team's repositories and reviews. Their account is not deleted."
        }
        action={removingSelf ? "Leave team" : "Remove member"}
        pending={remove.isPending}
        onConfirm={confirmRemove}
      />
    </>
  )
}

// Both the picker and exact-email field submit a normalized address.
const addMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  role: z.enum(["admin", "member"]),
})
type AddMemberInput = z.infer<typeof addMemberSchema>

// SearchableSelect takes an icon component per option; this one draws the
// person's avatar.
function avatarIcon(candidate: MemberCandidate) {
  return function CandidateAvatar() {
    return <UserAvatar user={candidate} size="sm" className="size-5" />
  }
}

function AddMemberDialog({ workspace, direct }: { workspace: Workspace; direct: boolean }) {
  const [open, setOpen] = useState(false)
  const [created, setCreated] = useState<CreatedWorkspaceInvite | null>(null)
  const add = useAddMember(workspace.id)
  const candidates = useMemberCandidates(workspace.id, open && direct)
  const options = useMemo<SelectOption[]>(
    () =>
      (candidates.data ?? []).map((candidate) => ({
        value: candidate.email,
        label: candidate.name,
        description: candidate.email,
        keywords: [candidate.email],
        icon: avatarIcon(candidate),
      })),
    [candidates.data],
  )
  const form = useForm<AddMemberInput>({
    resolver: zodResolver(addMemberSchema),
    defaultValues: { email: "", role: "member" },
  })

  async function onSubmit(input: AddMemberInput) {
    try {
      const result = await add.mutateAsync(input)
      if ("invite" in result) {
        setCreated(result)
      } else {
        handleOpenChange(false)
        toast.success(`${result.member.name} was added`)
      }
    } catch (error) {
      applyServerErrors(error, form.setError)
    }
  }

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      form.reset()
      setCreated(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <UserPlus />
          Add member
        </Button>
      </DialogTrigger>
      <DialogContent>
        {created ? (
          <CreatedInviteView created={created} />
        ) : (
          <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Add a member to {workspace.name}</DialogTitle>
              <DialogDescription>
                {direct
                  ? "Adds someone who already has a Sentryward account. They get access right away."
                  : "Enter their exact email address. They get access only after accepting the invitation."}
              </DialogDescription>
            </DialogHeader>
            {direct ? (
              <Controller
                control={form.control}
                name="email"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="add-member-user">User</FieldLabel>
                    <SearchableSelect
                      id="add-member-user"
                      value={field.value || undefined}
                      onValueChange={field.onChange}
                      options={options}
                      placeholder={candidates.isPending ? "Loading people..." : "Select a user"}
                      searchPlaceholder="Search people..."
                      emptyText="No one else to add. Invite new people from Pending invites."
                      searchable
                      disabled={candidates.isPending}
                      aria-invalid={fieldState.invalid}
                    />
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
            ) : (
              <TextField control={form.control} name="email" label="Email" type="email" autoComplete="off" />
            )}
            <Controller
              control={form.control}
              name="role"
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="add-member-role">Role</FieldLabel>
                  <Select value={field.value} onValueChange={(role) => field.onChange(role as InviteRole)}>
                    <SelectTrigger id="add-member-role">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="member">Member</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              )}
            />
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
                {direct ? "Add member" : "Create invite"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

// The search and filter sit above the card, so their state lives here and
// the table only sorts and pages what it is given.
function MembersTab({ workspace, onLeft }: { workspace: Workspace; onLeft: () => void }) {
  const { data, isPending, isError } = useMembers(workspace.id)
  const members = data?.members
  const { setPage } = usePagination()
  const [query, setQuery] = useState("")
  const [role, setRole] = useState(ALL)

  // A new filter or search starts over at the first page.
  function filterBy<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value)
      setPage(1)
    }
  }

  const filtered = useMemo(
    () =>
      (members ?? []).filter(
        (member) => matchesQuery(query, member.name, member.email) && (role === ALL || member.role === role),
      ),
    [members, query, role],
  )

  // Narrowed means the search or a filter hid rows; otherwise there are none.
  const narrowed = role !== ALL || query.trim() !== ""
  const emptyMessage = narrowed ? "No members match your filters." : "This team has no members yet."

  const activeFilters = [
    { label: "Role", value: selectedLabel(role, MEMBER_ROLE_OPTIONS), onRemove: () => filterBy(setRole)(ALL) },
  ].filter((filter): filter is ActiveFilter => filter.value !== null)

  return (
    <div className="flex flex-col gap-4">
      <FilterToolbar>
        <ActiveFilterChips filters={activeFilters} />
        {/* Plain members cannot add anyone; the server refuses them too. */}
        {workspace.role !== "member" && <AddMemberDialog workspace={workspace} direct={data?.allowDirectMemberAdd ?? false} />}
        <FilterPopover active={role !== ALL} onClear={() => filterBy(setRole)(ALL)}>
          <FilterSelect
            id="member-role"
            label="Role"
            allLabel="All roles"
            value={role}
            onValueChange={filterBy(setRole)}
            options={MEMBER_ROLE_OPTIONS}
          />
        </FilterPopover>
        <SearchInput label="Search members" value={query} onChange={filterBy(setQuery)} />
      </FilterToolbar>
      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>Everyone here shares this team's connections, repositories, reviews and keys.</CardDescription>
        </CardHeader>
        <CardContent>
          {isPending ? (
            <Loader2 className="animate-spin text-muted-foreground" />
          ) : isError ? (
            <p className="text-sm text-destructive">Could not load the members.</p>
          ) : (
            <MembersTable workspace={workspace} members={filtered} emptyMessage={emptyMessage} onLeft={onLeft} />
          )}
        </CardContent>
      </Card>
    </div>
  )
}

const inviteSchema = z.object({
  email: z.union([z.literal(""), z.email("Enter a valid email address")]),
  role: z.enum(["admin", "member"]),
})
type InviteInput = z.infer<typeof inviteSchema>

function InviteDialog({ workspace }: { workspace: Workspace }) {
  const [open, setOpen] = useState(false)
  const [created, setCreated] = useState<CreatedWorkspaceInvite | null>(null)
  const createInvite = useCreateWorkspaceInvite(workspace.id)
  const form = useForm<InviteInput>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: "", role: "member" },
  })

  async function onSubmit({ email, role }: InviteInput) {
    try {
      setCreated(await createInvite.mutateAsync({ email: email || undefined, role }))
    } catch (error) {
      applyServerErrors(error, form.setError)
    }
  }

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      form.reset()
      setCreated(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <UserPlus />
          Invite
        </Button>
      </DialogTrigger>
      <DialogContent>
        {created ? (
          <CreatedInviteView created={created} />
        ) : (
          <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Invite to {workspace.name}</DialogTitle>
              <DialogDescription>
                Creates a one-time link. People without an account can sign up with it; existing users join from it.
                Add an email to restrict the link to that address and, if mail is set up, send it.
              </DialogDescription>
            </DialogHeader>
            <TextField
              control={form.control}
              name="email"
              label="Email (optional)"
              type="email"
              autoComplete="off"
              placeholder="teammate@example.com"
            />
            <Controller
              control={form.control}
              name="role"
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="invite-role">Role</FieldLabel>
                  <Select value={field.value} onValueChange={(role) => field.onChange(role as InviteRole)}>
                    <SelectTrigger id="invite-role">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="member">Member</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              )}
            />
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
                Create invite
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

type InviteSortKey = "email" | "role" | "invitedBy" | "createdAt" | "expiresAt"

const INVITE_COLUMNS: { key: InviteSortKey; label: string }[] = [
  { key: "email", label: "For" },
  { key: "role", label: "Role" },
  { key: "invitedBy", label: "Invited by" },
  { key: "createdAt", label: "Created" },
  { key: "expiresAt", label: "Expires" },
]

const INVITE_ROLE_OPTIONS = [
  { value: "admin", label: "Admin" },
  { value: "member", label: "Member" },
]

const INVITE_TYPE_OPTIONS = [
  { value: "email", label: "Specific email" },
  { value: "link", label: "Anyone with the link" },
]

// Open links have no email; they sort after every addressed invite.
function compareInvites(a: WorkspaceInvite, b: WorkspaceInvite, key: InviteSortKey) {
  switch (key) {
    case "email":
      return (a.email ?? "￿").localeCompare(b.email ?? "￿")
    case "role":
      return RANK[b.role] - RANK[a.role]
    case "invitedBy":
      return (a.invitedBy?.name ?? "").localeCompare(b.invitedBy?.name ?? "")
    case "createdAt":
      return Date.parse(a.createdAt) - Date.parse(b.createdAt)
    case "expiresAt":
      return Date.parse(a.expiresAt) - Date.parse(b.expiresAt)
  }
}

function InvitesTable({
  workspace,
  invites,
  emptyMessage,
}: {
  workspace: Workspace
  invites: WorkspaceInvite[]
  emptyMessage: string
}) {
  const resend = useResendWorkspaceInvite(workspace.id)
  const revoke = useRevokeWorkspaceInvite(workspace.id)
  const [resending, setResending] = useState<WorkspaceInvite | null>(null)
  const [revoking, setRevoking] = useState<WorkspaceInvite | null>(null)
  // Unsorted keeps the API order (newest first).
  const { sort, onSort } = useSort<InviteSortKey>()
  const pagination = usePagination()

  const sorted = useMemo(() => {
    if (!sort) return invites
    const direction = sort.dir === "asc" ? 1 : -1
    return [...invites].sort(
      (a, b) => direction * compareInvites(a, b, sort.key) || Date.parse(b.createdAt) - Date.parse(a.createdAt),
    )
  }, [invites, sort])
  const page = paginate(sorted, pagination.page, pagination.size)

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            {INVITE_COLUMNS.map((column) => (
              <SortableHead
                key={column.key}
                label={column.label}
                sortKey={column.key}
                sort={sort}
                onSort={(key) => {
                  onSort(key)
                  pagination.setPage(1)
                }}
              />
            ))}
            <TableHead className="w-0">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {!sorted.length && <NoMatchesRow colSpan={6}>{emptyMessage}</NoMatchesRow>}
          {page.rows.map((invite) => (
            <TableRow key={invite.id}>
              <TableCell>{invite.email ?? <span className="text-muted-foreground">Anyone with the link</span>}</TableCell>
              <TableCell>
                <Badge variant="outline">{ROLE_LABELS[invite.role]}</Badge>
              </TableCell>
              <TableCell>{invite.invitedBy?.name ?? "Removed user"}</TableCell>
              <TableCell className="text-muted-foreground">{timeAgo(invite.createdAt)}</TableCell>
              <TableCell className="text-muted-foreground" title={new Date(invite.expiresAt).toLocaleString()}>
                {timeAgo(invite.expiresAt)}
              </TableCell>
              <TableCell className="text-right">
                <InviteActions
                  invite={invite}
                  onResend={() => setResending(invite)}
                  onRevoke={() => setRevoking(invite)}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {page.total > 0 && (
        <TablePagination
          page={page.page}
          size={pagination.size}
          total={page.total}
          onPageChange={pagination.setPage}
          onSizeChange={pagination.setSize}
        />
      )}
      <ResendInviteDialog
        invite={resending}
        onOpenChange={(open) => !open && setResending(null)}
        resend={resend}
        linkLabel={`link to join ${workspace.name}`}
      />
      <RevokeInviteDialog invite={revoking} onOpenChange={(open) => !open && setRevoking(null)} revoke={revoke} />
    </>
  )
}

// The search and filters sit above the card, so their state lives here and
// the table only sorts and pages what it is given.
function InvitesTab({ workspace }: { workspace: Workspace }) {
  const { data: invites, isPending, isError } = useWorkspaceInvites(workspace.id, true)
  const { setPage } = usePagination()
  const [query, setQuery] = useState("")
  const [role, setRole] = useState(ALL)
  const [type, setType] = useState(ALL)

  // A new filter or search starts over at the first page.
  function filterBy<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value)
      setPage(1)
    }
  }

  const filtered = useMemo(
    () =>
      (invites ?? []).filter(
        (invite) =>
          matchesQuery(query, invite.email ?? "", invite.invitedBy?.name ?? "") &&
          (role === ALL || invite.role === role) &&
          (type === ALL || (type === "email") === (invite.email !== null)),
      ),
    [invites, query, role, type],
  )

  // Narrowed means the search or a filter hid rows; otherwise there are none.
  const narrowed = role !== ALL || type !== ALL || query.trim() !== ""
  const emptyMessage = narrowed
    ? "No invites match your filters."
    : "No pending invites yet. Invite someone to give them a one-time link to join this team."

  const activeFilters = [
    { label: "Role", value: selectedLabel(role, INVITE_ROLE_OPTIONS), onRemove: () => filterBy(setRole)(ALL) },
    { label: "Type", value: selectedLabel(type, INVITE_TYPE_OPTIONS), onRemove: () => filterBy(setType)(ALL) },
  ].filter((filter): filter is ActiveFilter => filter.value !== null)

  function clearFilters() {
    setRole(ALL)
    setType(ALL)
    setPage(1)
  }

  return (
    <div className="flex flex-col gap-4">
      <FilterToolbar>
        <ActiveFilterChips filters={activeFilters} />
        <InviteDialog workspace={workspace} />
        <FilterPopover active={role !== ALL || type !== ALL} onClear={clearFilters}>
          <FilterSelect
            id="invite-role-filter"
            label="Role"
            allLabel="All roles"
            value={role}
            onValueChange={filterBy(setRole)}
            options={INVITE_ROLE_OPTIONS}
          />
          <FilterSelect
            id="invite-type"
            label="Type"
            allLabel="All invites"
            value={type}
            onValueChange={filterBy(setType)}
            options={INVITE_TYPE_OPTIONS}
          />
        </FilterPopover>
        <SearchInput label="Search invites" value={query} onChange={filterBy(setQuery)} />
      </FilterToolbar>
      <Card>
        <CardHeader>
          <CardTitle>Pending invites</CardTitle>
          <CardDescription>Links that have not been used yet. Each works once and expires after 7 days.</CardDescription>
        </CardHeader>
        <CardContent>
          {isPending ? (
            <Loader2 className="animate-spin text-muted-foreground" />
          ) : isError ? (
            <p className="text-sm text-destructive">Could not load the invites.</p>
          ) : (
            <InvitesTable workspace={workspace} invites={filtered} emptyMessage={emptyMessage} />
          )}
        </CardContent>
      </Card>
    </div>
  )
}

const nameSchema = z.object({ name: z.string().trim().min(1, "Name is required").max(100) })
type NameInput = z.infer<typeof nameSchema>

function SettingsCard({ workspace, onDeleted }: { workspace: Workspace; onDeleted: () => void }) {
  const rename = useRenameWorkspace(workspace.id)
  const remove = useDeleteWorkspace(workspace.id)
  const [deleting, setDeleting] = useState(false)
  const form = useForm<NameInput>({ resolver: zodResolver(nameSchema), defaultValues: { name: workspace.name } })

  async function onSubmit({ name }: NameInput) {
    try {
      await rename.mutateAsync(name)
      form.reset({ name })
      toast.success("Team renamed")
    } catch (error) {
      applyServerErrors(error, form.setError)
    }
  }

  async function confirmDelete() {
    try {
      await remove.mutateAsync()
      setDeleting(false)
      toast.success(`${workspace.name} was deleted`)
      onDeleted()
    } catch (error) {
      toast.error(errorMessage(error, "Could not delete the team"))
    }
  }

  return (
    <Section title="Team settings" description="Only owners can rename or delete the team.">
      <div className="flex flex-col gap-6">
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex items-end gap-2">
          <div className="flex-1">
            <TextField control={form.control} name="name" label="Name" autoComplete="off" />
          </div>
          <Button type="submit" disabled={form.formState.isSubmitting || !form.formState.isDirty}>
            {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
            Save
          </Button>
        </form>
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-destructive/40 p-4">
          <p className="text-sm text-muted-foreground">
            Deleting the team removes its connections, repositories, review history and keys for everyone.
          </p>
          <Button variant="destructive" onClick={() => setDeleting(true)}>
            <Trash2 />
            Delete team
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${workspace.name}?`}
        description="Everything in this team is deleted for all of its members. It cannot be undone."
        action="Delete team"
        pending={remove.isPending}
        onConfirm={confirmDelete}
      />
    </Section>
  )
}

export function WorkspacePage() {
  const { workspace, workspaces, switchWorkspace } = useAuth()
  const navigate = useNavigate()
  // ?tab= keeps the open tab linkable, e.g. /workspace?tab=invites.
  const [params, setParams] = useSearchParams()

  // A personal workspace has no members to manage.
  if (!workspace || workspace.personal) return <Navigate to="/home" replace />

  // Leaving or deleting ends access here. The refreshed list would fall back to
  // the personal workspace anyway; switching also remembers that choice.
  function backToPersonal() {
    const personal = workspaces.find((w) => w.personal)
    if (personal) switchWorkspace(personal.id)
    navigate("/home", { replace: true })
  }

  const tabs = TAB_ITEMS.filter((item) => RANK[workspace.role] >= RANK[item.role])
  const requested = params.get("tab")
  // A tab your role cannot open falls back to Members, like an unknown one.
  const tab: Tab = tabs.find((item) => item.value === requested)?.value ?? "members"
  const allowed = (value: Tab) => tabs.some((item) => item.value === value)

  return (
    <PageShell>
      <PageHeader
        title={workspace.name}
        description={`You are ${workspace.role === "admin" ? "an" : "a"} ${ROLE_LABELS[workspace.role].toLowerCase()} of this team.`}
      />
      <Tabs className="flex-1" value={tab} onValueChange={(value) => setParams({ tab: value }, { replace: true })}>
        <TabsList>
          {tabs.map((item) => (
            <TabsTrigger key={item.value} value={item.value}>
              <item.icon />
              <span>{item.label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="members">
          <MembersTab workspace={workspace} onLeft={backToPersonal} />
        </TabsContent>
        {allowed("invites") && (
          <TabsContent value="invites">
            <InvitesTab workspace={workspace} />
          </TabsContent>
        )}
        {allowed("settings") && (
          <TabsContent value="settings" className="max-w-3xl">
            <SettingsCard key={workspace.name} workspace={workspace} onDeleted={backToPersonal} />
          </TabsContent>
        )}
      </Tabs>
    </PageShell>
  )
}
