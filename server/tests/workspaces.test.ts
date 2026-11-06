import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.ts";
import { encrypt } from "../src/lib/crypto.ts";
import { prisma } from "../src/lib/prisma.ts";
import { fetchStub } from "./helpers/fetchStub.ts";
import { addMember, createTeam, createUser, inWorkspace } from "./helpers/users.ts";

type Created = Awaited<ReturnType<typeof createUser>>;
let owner: Created;
let member: Created;
let outsider: Created;
let teamId: string;
let repoId: string;
let findingId: string;

// A team with one owner and one member, holding a connection, an enabled
// repository and an open finding.
beforeEach(async () => {
  await prisma.instanceSettings.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
  owner = await createUser("owner@example.com");
  member = await createUser("member@example.com");
  outsider = await createUser("outsider@example.com");
  const team = await createTeam(owner.user.id, "Acme");
  teamId = team.id;
  await addMember(teamId, member.user.id, "member");

  const connection = await prisma.forgeConnection.create({
    data: { workspaceId: teamId, createdById: owner.user.id, provider: "gitlab", host: "gitlab.com", kind: "token", accountLogin: "acme" },
  });
  const repo = await prisma.repository.create({
    data: { connectionId: connection.id, provider: "gitlab", host: "gitlab.com", fullPath: "acme/web", externalId: "1", defaultBranch: "main", enabled: true },
  });
  repoId = repo.id;
  const finding = await prisma.finding.create({
    data: {
      repositoryId: repo.id,
      number: 1,
      fingerprint: "f1",
      title: "Bug",
      file: "a.ts",
      startLine: 1,
      severity: "major",
      category: "bug",
      kind: "issue",
      changeTitle: "Change",
    },
  });
  findingId = finding.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const get = (who: Created, path: string, workspace = teamId) =>
  request(app).get(path).set("Cookie", who.cookie).set(...inWorkspace(workspace));

describe("acting inside a workspace", () => {
  it("shows the team's data to its members", async () => {
    const repos = await get(member, "/api/repos");
    expect(repos.status).toBe(200);
    expect(repos.body.repos.map((r: { id: string }) => r.id)).toEqual([repoId]);

    const connections = await get(member, "/api/connections");
    expect(connections.body.connections[0]).toMatchObject({ accountLogin: "acme", createdBy: { email: "owner@example.com" } });
  });

  it("uses the personal workspace without the header, which keeps team data out", async () => {
    const res = await request(app).get("/api/repos").set("Cookie", member.cookie);

    expect(res.status).toBe(200);
    expect(res.body.repos).toEqual([]);
  });

  it.each([
    "/api/repos",
    "/api/connections",
    "/api/reviews",
    "/api/findings",
    "/api/config/global",
    "/api/settings/api-keys",
  ])("hides %s of a workspace the caller is not in", async (path) => {
    const res = await get(outsider, path);
    expect(res.status).toBe(404);
    expect(res.body.message).toBe("Workspace not found");
  });

  it("answers a malformed workspace id like an unknown one", async () => {
    expect((await get(owner, "/api/repos", "not-a-uuid")).status).toBe(404);
  });

  it("stops serving a member as soon as they are removed", async () => {
    await prisma.membership.deleteMany({ where: { workspaceId: teamId, userId: member.user.id } });
    expect((await get(member, "/api/repos")).status).toBe(404);
  });
});

describe("roles inside a workspace", () => {
  it("lets members triage findings", async () => {
    const res = await request(app)
      .patch(`/api/findings/${findingId}`)
      .set("Cookie", member.cookie)
      .set(...inWorkspace(teamId))
      .send({ state: "ignored", reason: "false_positive" });

    expect(res.status).toBe(200);
  });

  it.each([
    ["post", "/api/connections/gitlab", { token: "glpat-x" }],
    ["patch", () => `/api/repos/${repoId}`, { enabled: false }],
    ["delete", () => `/api/repos/${repoId}`, undefined],
    ["put", "/api/config/global", { settings: {} }],
    ["put", "/api/settings/api-keys/openai", { apiKey: "sk-test-12345678" }],
    ["delete", "/api/settings/api-keys/openai", undefined],
  ] as const)("refuses a member %s %s", async (method, path, body) => {
    const url = typeof path === "function" ? path() : path;
    const res = await request(app)[method](url).set("Cookie", member.cookie).set(...inWorkspace(teamId)).send(body);

    expect(res.status).toBe(403);
  });

  it("lets an admin change repository settings", async () => {
    await prisma.membership.updateMany({ where: { userId: member.user.id, workspaceId: teamId }, data: { role: "admin" } });

    const res = await request(app)
      .patch(`/api/repos/${repoId}`)
      .set("Cookie", member.cookie)
      .set(...inWorkspace(teamId))
      .send({ followGlobal: true });

    expect(res.status).toBe(200);
  });

  it("refuses the GitHub install for a member before leaving for GitHub", async () => {
    const res = await request(app).get(`/api/connections/github/install?workspace=${teamId}`).set("Cookie", member.cookie);

    expect(res.status).toBe(403);
  });
});

describe("/api/workspaces", () => {
  it("lists the caller's workspaces, personal first, with their role", async () => {
    const res = await request(app).get("/api/workspaces").set("Cookie", member.cookie);

    expect(res.body.workspaces).toEqual([
      { id: member.workspace.id, name: "Dev", personal: true, role: "owner" },
      { id: teamId, name: "Acme", personal: false, role: "member" },
    ]);
  });

  it("lets anyone create a team, as its owner", async () => {
    const res = await request(app).post("/api/workspaces").set("Cookie", outsider.cookie).send({ name: "Side project" });

    expect(res.status).toBe(201);
    expect(res.body.workspace).toMatchObject({ name: "Side project", personal: false, role: "owner" });
  });

  it("lets only owners rename or delete a team", async () => {
    const memberRename = await request(app).patch(`/api/workspaces/${teamId}`).set("Cookie", member.cookie).send({ name: "X" });
    expect(memberRename.status).toBe(403);

    const rename = await request(app).patch(`/api/workspaces/${teamId}`).set("Cookie", owner.cookie).send({ name: "Acme Inc" });
    expect(rename.body.workspace.name).toBe("Acme Inc");

    const removed = await request(app).delete(`/api/workspaces/${teamId}`).set("Cookie", owner.cookie);
    expect(removed.status).toBe(204);
    expect(await prisma.repository.count({ where: { id: repoId } })).toBe(0);
    expect(await prisma.finding.count({ where: { id: findingId } })).toBe(0);
  });

  it("keeps personal workspaces whole", async () => {
    const personal = owner.workspace.id;
    const del = await request(app).delete(`/api/workspaces/${personal}`).set("Cookie", owner.cookie);
    const leave = await request(app).delete(`/api/workspaces/${personal}/members/${owner.user.id}`).set("Cookie", owner.cookie);
    const invite = await request(app).post(`/api/workspaces/${personal}/invites`).set("Cookie", owner.cookie).send({});

    expect([del.status, leave.status, invite.status]).toEqual([400, 400, 400]);
  });

  it("does not reveal another user's workspace", async () => {
    const res = await request(app).get(`/api/workspaces/${teamId}/members`).set("Cookie", outsider.cookie);
    expect(res.status).toBe(404);
  });
});

describe("members", () => {
  it("lists members with their role", async () => {
    const res = await request(app).get(`/api/workspaces/${teamId}/members`).set("Cookie", member.cookie);

    expect(res.body.members).toEqual([
      expect.objectContaining({ id: owner.user.id, email: "owner@example.com", role: "owner" }),
      expect.objectContaining({ id: member.user.id, email: "member@example.com", role: "member" }),
    ]);
  });

  describe("adding an existing user", () => {
    beforeEach(async () => {
      await prisma.instanceSettings.create({ data: { id: 1, allowDirectMemberAdd: true } });
    });
    const add = (who: Created, body: Record<string, unknown>, workspace = teamId) =>
      request(app).post(`/api/workspaces/${workspace}/members`).set("Cookie", who.cookie).send(body);

    it("adds them straight away with the given role", async () => {
      const res = await add(owner, { email: "Outsider@Example.com", role: "admin" });

      expect(res.status).toBe(201);
      expect(res.body.member).toMatchObject({ id: outsider.user.id, email: "outsider@example.com", role: "admin" });
      const theirs = await request(app).get("/api/workspaces").set("Cookie", outsider.cookie);
      expect(theirs.body.workspaces).toContainEqual({ id: teamId, name: "Acme", personal: false, role: "admin" });
    });

    it("defaults to member and cannot hand out ownership", async () => {
      expect((await add(owner, { email: "outsider@example.com", role: "owner" })).status).toBe(400);
      const res = await add(owner, { email: "outsider@example.com" });
      expect(res.body.member.role).toBe("member");
    });

    it("says when there is no such account or they are already in", async () => {
      const unknown = await add(owner, { email: "nobody@example.com" });
      expect(unknown.status).toBe(400);
      expect(unknown.body.errors.email[0]).toMatch(/invite them instead/);

      const existing = await add(owner, { email: "member@example.com" });
      expect(existing.status).toBe(409);
      expect(existing.body.errors.email).toEqual(["This person is already a member"]);
    });

    it("lists the accounts that can still be added", async () => {
      const candidates = (who: Created = owner, workspace = teamId) =>
        request(app).get(`/api/workspaces/${workspace}/member-candidates`).set("Cookie", who.cookie);

      const before = await candidates();
      expect(before.status).toBe(200);
      expect(before.body.users).toEqual([
        { id: outsider.user.id, name: "Dev", email: "outsider@example.com", avatarUpdatedAt: null },
      ]);

      await add(owner, { email: "outsider@example.com" });
      expect((await candidates()).body.users).toEqual([]);

      expect((await candidates(member)).status).toBe(403);
      const stranger = await createUser("stranger@example.com");
      expect((await candidates(stranger)).status).toBe(404);
      expect((await candidates(owner, owner.workspace.id)).status).toBe(400);
    });

    it("is for team admins and owners only", async () => {
      expect((await add(member, { email: "outsider@example.com" })).status).toBe(403);
      expect((await add(outsider, { email: "member@example.com" })).status).toBe(404);
      expect((await add(owner, { email: "outsider@example.com" }, owner.workspace.id)).status).toBe(400);
      expect(await prisma.membership.count({ where: { userId: outsider.user.id, workspaceId: teamId } })).toBe(0);
    });
  });

  it("lets admins manage members but keeps the owner role to owners", async () => {
    const third = await createUser("third@example.com");
    await addMember(teamId, third.user.id, "member");
    await prisma.membership.updateMany({ where: { userId: member.user.id, workspaceId: teamId }, data: { role: "admin" } });
    const as = (who: Created) => (method: "patch" | "delete", userId: string) =>
      request(app)[method](`/api/workspaces/${teamId}/members/${userId}`).set("Cookie", who.cookie);

    expect((await as(member)("patch", third.user.id).send({ role: "admin" })).status).toBe(200);
    expect((await as(member)("patch", third.user.id).send({ role: "owner" })).status).toBe(403);
    expect((await as(member)("patch", owner.user.id).send({ role: "member" })).status).toBe(403);
    expect((await as(member)("delete", owner.user.id)).status).toBe(403);
    expect((await as(member)("delete", third.user.id)).status).toBe(204);
  });

  it("refuses a member managing others", async () => {
    const res = await request(app)
      .patch(`/api/workspaces/${teamId}/members/${owner.user.id}`)
      .set("Cookie", member.cookie)
      .send({ role: "member" });

    expect(res.status).toBe(403);
  });

  it("never leaves a team without an owner", async () => {
    const demote = await request(app)
      .patch(`/api/workspaces/${teamId}/members/${owner.user.id}`)
      .set("Cookie", owner.cookie)
      .send({ role: "admin" });
    const leave = await request(app).delete(`/api/workspaces/${teamId}/members/${owner.user.id}`).set("Cookie", owner.cookie);

    expect([demote.status, leave.status]).toEqual([409, 409]);
  });

  it("lets an owner hand over ownership and leave", async () => {
    await request(app)
      .patch(`/api/workspaces/${teamId}/members/${member.user.id}`)
      .set("Cookie", owner.cookie)
      .send({ role: "owner" });
    const leave = await request(app).delete(`/api/workspaces/${teamId}/members/${owner.user.id}`).set("Cookie", owner.cookie);

    expect(leave.status).toBe(204);
    expect((await get(owner, "/api/repos")).status).toBe(404);
  });

  it("lets a member leave", async () => {
    const res = await request(app).delete(`/api/workspaces/${teamId}/members/${member.user.id}`).set("Cookie", member.cookie);
    expect(res.status).toBe(204);
  });
});

describe("deleting accounts", () => {
  it("refuses to delete the only owner of a team that has other members", async () => {
    const { hashPassword } = await import("../src/lib/password.ts");
    await prisma.user.update({ where: { id: owner.user.id }, data: { passwordHash: await hashPassword("pw") } });

    const res = await request(app).delete("/api/settings/account").set("Cookie", owner.cookie).send({ password: "pw" });

    expect(res.status).toBe(409);
    expect(await prisma.workspace.count({ where: { id: teamId } })).toBe(1);
  });

  it("deletes a team along with its only member", async () => {
    await prisma.membership.deleteMany({ where: { userId: member.user.id, workspaceId: teamId } });
    const { hashPassword } = await import("../src/lib/password.ts");
    await prisma.user.update({ where: { id: owner.user.id }, data: { passwordHash: await hashPassword("pw") } });

    const res = await request(app).delete("/api/settings/account").set("Cookie", owner.cookie).send({ password: "pw" });

    expect(res.status).toBe(204);
    expect(await prisma.workspace.count({ where: { id: teamId } })).toBe(0);
  });

  it("promotes a remaining member when an instance admin removes the owner", async () => {
    const admin = await createUser("admin@example.com", "admin");

    const res = await request(app).delete(`/api/admin/users/${owner.user.id}`).set("Cookie", admin.cookie);

    expect(res.status).toBe(204);
    const promoted = await prisma.membership.findFirstOrThrow({ where: { workspaceId: teamId, userId: member.user.id } });
    expect(promoted.role).toBe("owner");
  });

  it("keeps an owner when two owners delete their accounts at once", async () => {
    const second = await createUser("second@example.com");
    await addMember(teamId, second.user.id, "owner");
    const { hashPassword } = await import("../src/lib/password.ts");
    const passwordHash = await hashPassword("pw");
    await prisma.user.updateMany({ where: { id: { in: [owner.user.id, second.user.id] } }, data: { passwordHash } });

    const statuses = (
      await Promise.all(
        [owner, second].map((who) =>
          request(app).delete("/api/settings/account").set("Cookie", who.cookie).send({ password: "pw" }),
        ),
      )
    ).map((res) => res.status);

    expect(statuses.sort()).toEqual([204, 409]);
    expect(await prisma.membership.count({ where: { workspaceId: teamId, role: "owner" } })).toBe(1);
  });

  it("promotes a successor when an instance admin removes both owners at once", async () => {
    const admin = await createUser("admin@example.com", "admin");
    const second = await createUser("second@example.com");
    await addMember(teamId, second.user.id, "owner");

    const statuses = (
      await Promise.all(
        [owner, second].map((who) => request(app).delete(`/api/admin/users/${who.user.id}`).set("Cookie", admin.cookie)),
      )
    ).map((res) => res.status);

    expect(statuses).toEqual([204, 204]);
    const promoted = await prisma.membership.findFirstOrThrow({ where: { workspaceId: teamId, userId: member.user.id } });
    expect(promoted.role).toBe("owner");
  });

  it("removes the forge hook on the personal workspace's repos when the account is deleted", async () => {
    await prisma.membership.deleteMany({ where: { userId: member.user.id, workspaceId: teamId } });
    const connection = await prisma.forgeConnection.create({
      data: {
        workspaceId: owner.workspace.id,
        createdById: owner.user.id,
        provider: "gitlab",
        host: "gitlab.com",
        kind: "token",
        accountLogin: "owner",
        encryptedToken: encrypt("glpat"),
      },
    });
    await prisma.repository.create({
      data: {
        connectionId: connection.id,
        provider: "gitlab",
        host: "gitlab.com",
        fullPath: "owner/solo",
        externalId: "9",
        defaultBranch: "main",
        enabled: true,
        webhookId: "500",
        encryptedWebhookSecret: encrypt("secret"),
      },
    });
    const stub = fetchStub([{ method: "DELETE", url: /\/api\/v4\/projects\/9\/hooks\/500$/, status: 204, body: "" }]);
    vi.stubGlobal("fetch", stub.fetch);
    const { hashPassword } = await import("../src/lib/password.ts");
    await prisma.user.update({ where: { id: owner.user.id }, data: { passwordHash: await hashPassword("pw") } });

    const res = await request(app).delete("/api/settings/account").set("Cookie", owner.cookie).send({ password: "pw" });

    expect(res.status).toBe(204);
    expect(stub.calls.map((call) => call.method)).toEqual(["DELETE"]);
  });

  it("removes the forge hook on a team deleted along with its only member", async () => {
    await prisma.membership.deleteMany({ where: { userId: member.user.id, workspaceId: teamId } });
    const connection = await prisma.forgeConnection.create({
      data: {
        workspaceId: teamId,
        createdById: owner.user.id,
        provider: "gitlab",
        host: "gitlab.com",
        kind: "token",
        accountLogin: "acme",
        encryptedToken: encrypt("glpat"),
      },
    });
    await prisma.repository.create({
      data: {
        connectionId: connection.id,
        provider: "gitlab",
        host: "gitlab.com",
        fullPath: "acme/hooked",
        externalId: "7",
        defaultBranch: "main",
        enabled: true,
        webhookId: "700",
        encryptedWebhookSecret: encrypt("secret"),
      },
    });
    const stub = fetchStub([{ method: "DELETE", url: /\/api\/v4\/projects\/7\/hooks\/700$/, status: 204, body: "" }]);
    vi.stubGlobal("fetch", stub.fetch);

    const res = await request(app).delete(`/api/admin/users/${owner.user.id}`).set("Cookie", (await createUser("admin2@example.com", "admin")).cookie);

    expect(res.status).toBe(204);
    expect(await prisma.workspace.count({ where: { id: teamId } })).toBe(0);
    expect(stub.calls.map((call) => call.method)).toEqual(["DELETE"]);
  });
});
