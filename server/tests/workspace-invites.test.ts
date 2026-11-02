import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.ts";
import { env } from "../src/config/env.ts";
import { mailer } from "../src/lib/mailer.ts";
import { prisma } from "../src/lib/prisma.ts";
import { consumeInvite } from "../src/services/invites.ts";
import { addMember, createTeam, createUser } from "./helpers/users.ts";

type Created = Awaited<ReturnType<typeof createUser>>;
let owner: Created;
let teamId: string;
const originalMode = env.REGISTRATION_MODE;

beforeEach(async () => {
  await prisma.instanceSettings.deleteMany();
  await prisma.invite.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
  owner = await createUser("owner@example.com");
  teamId = (await createTeam(owner.user.id, "Acme")).id;
});

afterEach(() => {
  env.REGISTRATION_MODE = originalMode;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function invite(body: Record<string, unknown> = {}, who: Created = owner) {
  const res = await request(app).post(`/api/workspaces/${teamId}/invites`).set("Cookie", who.cookie).send(body);
  return { res, token: String(res.body.link ?? "").split("/invite/")[1]! };
}

const accept = (token: string, who: Created) =>
  request(app).post(`/api/auth/invites/${token}/accept`).set("Cookie", who.cookie);

describe("adding members with consent required", () => {
  const add = (email: string, role = "member", who: Created = owner, workspace = teamId) =>
    request(app).post(`/api/workspaces/${workspace}/members`).set("Cookie", who.cookie).send({ email, role });

  it.each(["missing", "disabled"])("blocks discovery when settings are %s", async (state) => {
    if (state === "disabled") await prisma.instanceSettings.create({ data: { id: 1 } });
    const res = await request(app).get(`/api/workspaces/${teamId}/member-candidates`).set("Cookie", owner.cookie);
    expect(res.status).toBe(403);
    expect(res.body).not.toHaveProperty("users");
    const members = await request(app).get(`/api/workspaces/${teamId}/members`).set("Cookie", owner.cookie);
    expect(members.body.allowDirectMemberAdd).toBe(false);
  });

  it.each([true, false])("creates the same pending invite whether an account exists: %s", async (registered) => {
    if (registered) await createUser("grace@example.com");
    vi.spyOn(mailer, "configured").mockReturnValue(false);
    const before = await prisma.membership.count();
    const res = await add(" Grace@Example.com ", "admin");
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(["emailed", "invite", "link"]);
    expect(res.body.invite).toMatchObject({ email: "grace@example.com", role: "admin" });
    expect(res.body.emailed).toBe(false);
    expect(await prisma.membership.count()).toBe(before);
    expect(await prisma.invite.findUniqueOrThrow({ where: { id: res.body.invite.id } }))
      .toMatchObject({ workspaceId: teamId, acceptedAt: null });
  });

  it("grants access only after the addressed user accepts, once", async () => {
    const grace = await createUser("grace@example.com");
    const other = await createUser("other@example.com");
    const res = await add("grace@example.com", "admin");
    const token = res.body.link.split("/invite/")[1];
    expect((await accept(token, other)).status).toBe(400);
    expect((await accept(token, grace)).status).toBe(201);
    expect(await prisma.membership.findUnique({ where: { userId_workspaceId: { userId: grace.user.id, workspaceId: teamId } } }))
      .toMatchObject({ role: "admin" });
    expect((await accept(token, grace)).status).toBe(404);
  });

  it("keeps team permissions, email validation and existing-member conflicts", async () => {
    const member = await createUser("member@example.com");
    await addMember(teamId, member.user.id, "member");
    expect((await add("new@example.com", "member", member)).status).toBe(403);
    const outsider = await createUser("outsider@example.com");
    expect((await add("new@example.com", "member", outsider)).status).toBe(404);
    expect((await add("new@example.com", "member", owner, owner.workspace.id)).status).toBe(400);
    expect((await add("owner@example.com")).status).toBe(409);
    expect((await add("partial")).status).toBe(400);
    expect((await add("new@example.com", "owner")).status).toBe(400);
    expect(await prisma.invite.count()).toBe(0);
  });

  it("delivers an email-bound invitation through the existing mailer", async () => {
    vi.spyOn(mailer, "configured").mockReturnValue(true);
    const send = vi.spyOn(mailer, "send").mockResolvedValue();
    const res = await add("grace@example.com");
    expect(res.body.emailed).toBe(true);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: "grace@example.com", subject: "Join Acme on Sentryward" }));
  });
});

describe("creating team invites", () => {
  it("is for admins and owners only", async () => {
    const member = await createUser("member@example.com");
    await addMember(teamId, member.user.id, "member");

    expect((await invite({}, member)).res.status).toBe(403);
    expect((await invite({ role: "admin" })).res.status).toBe(201);
  });

  it("cannot hand out ownership", async () => {
    expect((await invite({ role: "owner" })).res.status).toBe(400);
  });

  it("emails a workspace-specific message when SMTP is configured", async () => {
    vi.spyOn(mailer, "configured").mockReturnValue(true);
    const send = vi.spyOn(mailer, "send").mockResolvedValue();

    const { res } = await invite({ email: "grace@example.com" });

    expect(res.body.emailed).toBe(true);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: "grace@example.com", subject: "Join Acme on Sentryward" }));
  });

  it("refuses to invite someone who is already a member", async () => {
    const { res } = await invite({ email: "owner@example.com" });
    expect(res.status).toBe(409);
  });

  it("lists and revokes the team's pending invites, separately from instance invites", async () => {
    await invite({ email: "grace@example.com" });
    const list = await request(app).get(`/api/workspaces/${teamId}/invites`).set("Cookie", owner.cookie);
    expect(list.body.invites).toEqual([expect.objectContaining({ email: "grace@example.com", role: "member" })]);

    const admin = await createUser("admin@example.com", "admin");
    const instance = await request(app).get("/api/admin/invites").set("Cookie", admin.cookie);
    expect(instance.body.invites).toEqual([]);

    const revoked = await request(app)
      .delete(`/api/workspaces/${teamId}/invites/${list.body.invites[0].id}`)
      .set("Cookie", owner.cookie);
    expect(revoked.status).toBe(204);
  });
});

describe("resending team invites", () => {
  // An email invite created with SMTP on, returning its id, token and the
  // cleared send spy.
  async function emailInvite() {
    vi.spyOn(mailer, "configured").mockReturnValue(true);
    const send = vi.spyOn(mailer, "send").mockResolvedValue();
    const { res, token } = await invite({ email: "grace@example.com" });
    send.mockClear();
    return { id: res.body.invite.id as string, token, send };
  }

  const resend = (inviteId: string, who: Created = owner, workspace = teamId) =>
    request(app).post(`/api/workspaces/${workspace}/invites/${inviteId}/resend`).set("Cookie", who.cookie);
  const show = (token: string) => request(app).get(`/api/auth/invites/${token}`);

  it("emails a new team link, retires the old one and renews the expiry", async () => {
    const { id, token, send } = await emailInvite();
    await prisma.invite.update({ where: { id }, data: { expiresAt: new Date(Date.now() + 60_000) } });

    const res = await resend(id);

    expect(res.status).toBe(200);
    expect(res.body.invite).toMatchObject({ id, email: "grace@example.com", role: "member" });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: "grace@example.com", subject: "Join Acme on Sentryward" }));
    const newToken = /\/invite\/([\w-]+)/.exec(send.mock.calls[0]![0].text)![1]!;
    expect((await show(token)).status).toBe(404);
    expect((await show(newToken)).body.invite).toMatchObject({ workspace: { name: "Acme" } });
    const after = await prisma.invite.findUniqueOrThrow({ where: { id } });
    expect(after.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
  });

  it("refuses an open link, and refuses when email is not set up", async () => {
    const open = await invite();
    vi.spyOn(mailer, "configured").mockReturnValue(true);
    expect((await resend(open.res.body.invite.id)).status).toBe(400);

    const { id, token } = await emailInvite();
    vi.spyOn(mailer, "configured").mockReturnValue(false);
    expect((await resend(id)).status).toBe(409);
    expect((await show(token)).status).toBe(200);
  });

  it("is for admins and owners only", async () => {
    const { id } = await emailInvite();
    const member = await createUser("member@example.com");
    await addMember(teamId, member.user.id, "member");

    expect((await resend(id, member)).status).toBe(403);
  });

  it("cannot reach another team's invite or an instance invite", async () => {
    const { id } = await emailInvite();
    const other = await createTeam(owner.user.id, "Other");
    const admin = await createUser("admin@example.com", "admin");
    const instance = await request(app)
      .post("/api/admin/invites")
      .set("Cookie", admin.cookie)
      .send({ email: "new@example.com" });

    expect((await resend(id, owner, other.id)).status).toBe(404);
    expect((await resend(instance.body.invite.id)).status).toBe(404);
  });
});

describe("accepting team invites", () => {
  it("shows the workspace on the invite page", async () => {
    const { token } = await invite();
    const res = await request(app).get(`/api/auth/invites/${token}`);

    expect(res.body.invite).toMatchObject({ role: "member", workspace: { name: "Acme" }, invitedBy: { name: "Dev" } });
  });

  it("adds a signed-in user with the invited role, once", async () => {
    env.REGISTRATION_MODE = "invite";
    const grace = await createUser("grace@example.com");
    const { token } = await invite({ role: "admin" });

    const res = await accept(token, grace);
    expect(res.status).toBe(201);
    expect(res.body.workspace).toEqual({ id: teamId, name: "Acme", personal: false, role: "admin" });

    const again = await accept(token, await createUser("other@example.com"));
    expect(again.status).toBe(404);
  });

  it("rejects an invite meant for another email", async () => {
    const grace = await createUser("grace@example.com");
    const { token } = await invite({ email: "someone@example.com" });

    expect((await accept(token, grace)).status).toBe(400);
  });

  it("rejects a user who is already a member, without spending the invite", async () => {
    const { token } = await invite();

    expect((await accept(token, owner)).status).toBe(409);
    expect(await prisma.invite.count({ where: { acceptedAt: null } })).toBe(1);
  });

  it("refuses instance invites on the accept route", async () => {
    const admin = await createUser("admin@example.com", "admin");
    const created = await request(app).post("/api/admin/invites").set("Cookie", admin.cookie).send({});
    const token = created.body.link.split("/invite/")[1];

    expect((await accept(token, owner)).status).toBe(400);
  });
});

// The lookup and the consume are separate statements, so the invite can
// change in between; consuming re-checks what the lookup saw.
describe("consuming an invite that changed since it was looked up", () => {
  it("fails once a resend has rotated the token", async () => {
    await invite();
    const looked = await prisma.invite.findFirstOrThrow();
    await prisma.invite.update({ where: { id: looked.id }, data: { tokenHash: "rotated" } });

    await expect(prisma.$transaction((tx) => consumeInvite(tx, looked))).rejects.toMatchObject({ status: 400 });
    expect(await prisma.invite.count({ where: { acceptedAt: null } })).toBe(1);
  });

  it("fails once the invite has expired", async () => {
    await invite();
    const looked = await prisma.invite.findFirstOrThrow();
    await prisma.invite.update({ where: { id: looked.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    await expect(prisma.$transaction((tx) => consumeInvite(tx, looked))).rejects.toMatchObject({ status: 400 });
  });
});

describe("registering from a team invite", () => {
  const newUser = {
    name: "Grace",
    email: "grace@example.com",
    password: "supersecret123",
    confirmPassword: "supersecret123",
  };

  it.each([{}, { email: "grace@example.com" }])("rejects a non-admin's team invite in invite mode: %j", async (body) => {
    env.REGISTRATION_MODE = "invite";
    const team = await request(app).post("/api/workspaces").set("Cookie", owner.cookie).send({ name: "New team" });
    expect(team.status).toBe(201);
    teamId = team.body.workspace.id;
    const { res: created, token } = await invite(body);
    expect(created.status).toBe(201);
    const before = {
      users: await prisma.user.count(),
      workspaces: await prisma.workspace.count(),
      memberships: await prisma.membership.count(),
    };

    const res = await request(app).post("/api/auth/register").send({ ...newUser, inviteToken: token });

    expect(res.status).toBe(403);
    expect(res.body.message).toBe("This team invite cannot create an account. Ask an instance admin for an invite.");
    expect(await prisma.user.count()).toBe(before.users);
    expect(await prisma.workspace.count()).toBe(before.workspaces);
    expect(await prisma.membership.count()).toBe(before.memberships);
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: created.body.invite.id } })).acceptedAt).toBeNull();
  });

  it.each(["member", "admin"])("accepts an instance admin's team invite with workspace role %s", async (role) => {
    env.REGISTRATION_MODE = "invite";
    await prisma.user.update({ where: { id: owner.user.id }, data: { role: "admin" } });
    const { res: created, token } = await invite({ email: "grace@example.com", role });

    const res = await request(app).post("/api/auth/register").send({ ...newUser, inviteToken: token });

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe("member");
    expect(res.body.workspaces).toEqual([
      expect.objectContaining({ personal: true, role: "owner" }),
      { id: teamId, name: "Acme", personal: false, role },
    ]);
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: created.body.invite.id } })).acceptedAt).not.toBeNull();
  });

  it.each(["demoted", "deleted"])("rejects a team invite whose creator was %s", async (change) => {
    env.REGISTRATION_MODE = "invite";
    const admin = await createUser("admin@example.com", "admin");
    await addMember(teamId, admin.user.id, "admin");
    const { res: created, token } = await invite({}, admin);
    if (change === "demoted") {
      await prisma.user.update({ where: { id: admin.user.id }, data: { role: "member" } });
    } else {
      await prisma.user.delete({ where: { id: admin.user.id } });
    }

    const res = await request(app).post("/api/auth/register").send({ ...newUser, inviteToken: token });

    expect(res.status).toBe(403);
    expect(await prisma.user.count({ where: { email: newUser.email } })).toBe(0);
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: created.body.invite.id } })).acceptedAt).toBeNull();
  });

  it("does not authorize a non-admin's invite when an instance admin resends it", async () => {
    env.REGISTRATION_MODE = "invite";
    vi.spyOn(mailer, "configured").mockReturnValue(true);
    const send = vi.spyOn(mailer, "send").mockResolvedValue();
    const { res: created } = await invite({ email: newUser.email });
    const admin = await createUser("admin@example.com", "admin");
    await addMember(teamId, admin.user.id, "admin");
    send.mockClear();

    const resent = await request(app)
      .post(`/api/workspaces/${teamId}/invites/${created.body.invite.id}/resend`)
      .set("Cookie", admin.cookie);
    expect(resent.status).toBe(200);
    const token = /\/invite\/([\w-]+)/.exec(send.mock.calls[0]![0].text)![1]!;
    const res = await request(app).post("/api/auth/register").send({ ...newUser, inviteToken: token });

    expect(res.status).toBe(403);
    const stored = await prisma.invite.findUniqueOrThrow({ where: { id: created.body.invite.id } });
    expect(stored.invitedById).toBe(owner.user.id);
    expect(stored.acceptedAt).toBeNull();
  });

  it("rejects even an instance admin's team invite in closed mode", async () => {
    env.REGISTRATION_MODE = "closed";
    await prisma.user.update({ where: { id: owner.user.id }, data: { role: "admin" } });
    const { token } = await invite();

    const res = await request(app).post("/api/auth/register").send({ ...newUser, inviteToken: token });

    expect(res.status).toBe(403);
    expect(await prisma.user.count({ where: { email: newUser.email } })).toBe(0);
  });

  it("joins the team in open mode too", async () => {
    env.REGISTRATION_MODE = "open";
    const { token } = await invite();

    const res = await request(app).post("/api/auth/register").send({ ...newUser, inviteToken: token });

    expect(res.status).toBe(201);
    expect(res.body.workspaces).toEqual([
      expect.objectContaining({ personal: true, role: "owner" }),
      { id: teamId, name: "Acme", personal: false, role: "member" },
    ]);
  });
});
