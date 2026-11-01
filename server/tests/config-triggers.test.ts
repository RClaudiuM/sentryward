import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.ts";
import { prisma } from "../src/lib/prisma.ts";
import { DEFAULT_CONFIG, type ConfigOverride } from "../src/review/config/schema.ts";
import { createUser } from "./helpers/users.ts";

const change = (extra: Record<string, unknown> = {}) => ({
  title: "Add login",
  author: "dev",
  labels: [],
  headRef: "feature/login",
  baseRef: "main",
  isDraft: false,
  ...extra,
});

describe("POST /api/config/triggers/check", () => {
  let cookie: string;

  beforeEach(async () => {
    await prisma.workspace.deleteMany();
    await prisma.user.deleteMany();
    ({ cookie } = await createUser());
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const check = (body: { settings?: ConfigOverride; event?: string; change?: Record<string, unknown>; actor?: string }) =>
    request(app)
      .post("/api/config/triggers/check")
      .set("Cookie", cookie)
      .send({ base: DEFAULT_CONFIG, settings: {}, event: "opened", change: change(), ...body });

  it("requires a session", async () => {
    const res = await request(app)
      .post("/api/config/triggers/check")
      .send({ base: {}, settings: {}, event: "opened", change: change() });
    expect(res.status).toBe(401);
  });

  it("rejects a malformed body", async () => {
    const res = await check({ event: "merged" });
    expect(res.status).toBe(400);
    expect(res.body.errors).toHaveProperty("event");
  });

  it("reviews an opened change under the defaults, with the summary", async () => {
    const res = await check({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reason: null, fullReview: true, walkthrough: true });
  });

  it("gives the worker's reason for each trigger setting", async () => {
    const triggers = (value: Record<string, unknown>) => ({ triggers: value }) as ConfigOverride;

    expect((await check({ change: change({ isDraft: true }) })).body.reason).toMatch(/Draft/);
    expect((await check({ settings: triggers({ review: "all" }), change: change({ isDraft: true }) })).body.reason).toBeNull();
    expect((await check({ settings: triggers({ review: "manual" }) })).body.reason).toMatch(/turned off/);
    expect((await check({ settings: triggers({ reviewOnPush: false }), event: "push" })).body.reason).toMatch(/New commits/);
    expect((await check({ settings: triggers({ command: false }), event: "command" })).body.reason).toMatch(/commands/);
    // A command is not held to automatic-review settings.
    expect((await check({ settings: triggers({ review: "manual" }), event: "command" })).body.reason).toBeNull();
  });

  it("applies the skip rules to the sample change", async () => {
    const triggers = (value: Record<string, unknown>) => ({ triggers: value }) as ConfigOverride;

    const title = await check({ settings: triggers({ ignoreTitles: ["wip"] }), change: change({ title: "WIP: login" }) });
    expect(title.body.reason).toBe('The title contains "wip"');
    const label = await check({ settings: triggers({ skipLabels: ["no-review"] }), change: change({ labels: ["no-review"] }) });
    expect(label.body.reason).toBe('The change has the label "no-review"');
    const branch = await check({ settings: triggers({ skipTargetBranches: ["legacy"] }), change: change({ baseRef: "legacy/v1" }) });
    expect(branch.body.reason).toMatch(/target branch legacy\/v1/);
    const actor = await check({ settings: triggers({ skipAuthors: ["renovate[bot]"] }), actor: "renovate[bot]" });
    expect(actor.body.reason).toMatch(/renovate\[bot\]/);
    expect(actor.body).toMatchObject({ fullReview: false, walkthrough: false });
  });

  it("says whether a push reviews every file and whether the summary runs", async () => {
    const push = await check({ settings: { triggers: { reviewOnPush: true } } as ConfigOverride, event: "push" });
    expect(push.body).toEqual({ reason: null, fullReview: false, walkthrough: true });

    const full = await check({
      settings: { triggers: { reviewOnPush: true, fullReviewOnPush: true }, output: { walkthrough: false } } as ConfigOverride,
      event: "push",
    });
    expect(full.body).toEqual({ reason: null, fullReview: true, walkthrough: false });
  });
});
