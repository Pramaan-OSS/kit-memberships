import { createHmac, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!url) throw Error("Tests require a disposable migrated TEST_DATABASE_URL.");
const secret = "test-secret-for-membership-sessions-1234567";
const origin = "http://127.0.0.1:3510";
Object.assign(process.env, {
  DATABASE_URL: url,
  SESSION_SECRET: secret,
  APP_ORIGIN: origin,
  PRAMAAN_PAYMENTS_TEST_MODE: "true",
  APP_COOKIE_SECURE: "false",
  PRAMAAN_MODULES_DIR: path.resolve(".scratch/test-door"),
});
const { startFakeDoor } = await import(new URL("../scripts/fake-door.mjs", import.meta.url).href);
const route = await import("../app/api/memberships/route");
const account = await import("../app/api/account/[action]/route");
const runtime = await import("./runtime");
const createdUsers: string[] = [];
const db = new Pool({ connectionString: url, max: 1 });
// biome-ignore lint/suspicious/noExplicitAny: test fixture in JavaScript mirrors the module door.
let door: any;
async function person(role: string) {
  const id = randomUUID();
  createdUsers.push(id);
  await db.query("INSERT INTO app_users(id,email,role) VALUES($1,$2,$3)", [
    id,
    `${id}@example.test`,
    role,
  ]);
  if (role === "member")
    await db.query("INSERT INTO members(user_id,name,email,phone) VALUES($1,$2,$3,'9000000000')", [
      id,
      id,
      `${id}@example.test`,
    ]);
  const token = randomBytes(32).toString("hex");
  await db.query(
    "INSERT INTO app_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [createHmac("sha256", secret).update(token).digest("hex"), id],
  );
  return { id, cookie: `app_session=${token}` };
}
let owner: Awaited<ReturnType<typeof person>>,
  staff: typeof owner,
  alice: typeof owner,
  bob: typeof owner;
const req = (cookie: string, body?: unknown, query = "") =>
  new Request(`${origin}/api/memberships${query}`, {
    method: body ? "POST" : "GET",
    headers: { cookie, origin, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const post = (cookie: string, body: unknown) => route.POST(req(cookie, body));
const get = (cookie: string, query = "") => route.GET(req(cookie, undefined, query));
beforeAll(async () => {
  door = await startFakeDoor({ dir: process.env.PRAMAAN_MODULES_DIR, port: 3512 });
  door.emailOn = false;
  owner = await person("owner");
  staff = await person("staff");
  alice = await person("member");
  bob = await person("member");
});
afterAll(async () => {
  await door.close();
  for (const table of ["membership_emails", "payments"])
    await db.query(
      `DELETE FROM ${table} WHERE membership_id IN (SELECT id FROM memberships WHERE member_id IN (SELECT id FROM members WHERE user_id=ANY($1::uuid[])))`,
      [createdUsers],
    );
  for (const table of ["check_ins", "member_notes", "memberships"])
    await db.query(
      `DELETE FROM ${table} WHERE member_id IN (SELECT id FROM members WHERE user_id=ANY($1::uuid[]))`,
      [createdUsers],
    );
  await db.query(
    "DELETE FROM members WHERE user_id=ANY($1::uuid[]) OR email IN ('jo@example.test','alex@example.test')",
    [createdUsers],
  );
  await db.query("DELETE FROM app_users WHERE id=ANY($1::uuid[])", [createdUsers]);
  await db.query("UPDATE membership_statuses SET name='Active' WHERE id='active'");
  await runtime.database().end();
  await db.end();
});
describe("Membership access and money", () => {
  let memberId: string;
  let subscriptionId: string;
  let planId: string;
  it("sign-in is required for all private records", async () => {
    expect((await get("")).status).toBe(401);
    expect((await get("", "?view=plans")).status).toBe(200);
  });
  it("owner-only mutations reject staff and members on the server", async () => {
    for (const actor of [staff, alice])
      for (const action of ["staff", "import", "plan", "list-add", "deliver-email", "note"])
        expect((await post(actor.cookie, { action })).status).toBe(403);
  });
  it("a join creates pending access only and duplicate joins reuse the billing operation", async () => {
    const plans = await (await get("", "?view=plans")).json();
    planId = plans.plans.find((p: { one_off: boolean }) => !p.one_off).id;
    expect(
      (await post(alice.cookie, { action: "join", planId, status: "active", price: 1 })).status,
    ).toBe(200);
    const detail = await (await get(alice.cookie)).json();
    memberId = detail.member.id;
    expect(detail.membership.status_id).toBe("pending");
    expect((await post(staff.cookie, { action: "check-in", memberId })).status).toBe(409);
    await Promise.all([
      post(alice.cookie, { action: "join", planId }),
      post(alice.cookie, { action: "join", planId }),
    ]);
    expect(door.subscriptions.size).toBe(1);
    const create = door.calls.find((c: { id: string }) => c.id === "billing.subscription.create");
    expect(create.input.planId).toBeTruthy();
    expect(create.input.customerPhone).toBe("9000000000");
    expect(create.input.customerId).toBeUndefined();
    subscriptionId = [...door.subscriptions.keys()][0] as string;
  });
  it("another member cannot read, change or check in this member", async () => {
    expect((await get(bob.cookie, `?id=${memberId}`)).status).toBe(404);
    for (const action of ["refresh", "pause", "cancel"])
      expect((await post(bob.cookie, { action, memberId })).status).toBe(404);
    expect((await post(bob.cookie, { action: "check-in", memberId })).status).toBe(403);
  });
  it("only a matching billing read-back grants access and records a confirmed payment", async () => {
    const s = door.subscriptions.get(subscriptionId);
    s.status = "active";
    s.paid = true;
    s.recurringAmount.amount = 1;
    expect((await post(alice.cookie, { action: "refresh", memberId })).status).toBe(502);
    s.recurringAmount.amount = 4500;
    expect((await post(alice.cookie, { action: "refresh", memberId })).status).toBe(200);
    const d = await (await get(alice.cookie)).json();
    expect(d.membership.status_id).toBe("active");
    expect(d.payments).toHaveLength(1);
    expect(d.payments[0].amount).toBe(4500);
  });
  it("front desk can check in once, with parallel duplicate requests refused", async () => {
    const answers = await Promise.all([
      post(staff.cookie, { action: "check-in", memberId }),
      post(staff.cookie, { action: "check-in", memberId }),
    ]);
    expect(answers.map((r) => r.status).sort()).toEqual([200, 409]);
    const d = await (await get(staff.cookie, `?id=${memberId}`)).json();
    expect(d.visits).toHaveLength(1);
    expect(d.payments).toBeUndefined();
    expect(d.notes).toBeUndefined();
  });
  it("cancellation waits for period end, then check-in refuses without trusting cached active state", async () => {
    expect((await post(alice.cookie, { action: "cancel", memberId })).status).toBe(200);
    let d = await (await get(alice.cookie)).json();
    expect(d.membership.cancel_at_end).toBe(true);
    expect(d.membership.status_id).toBe("active");
    await db.query(
      "UPDATE memberships SET renews_at=now()-interval '1 second' WHERE member_id=$1",
      [memberId],
    );
    expect((await post(staff.cookie, { action: "check-in", memberId })).status).toBe(409);
    door.subscriptions.get(subscriptionId).currentPeriodEnd = new Date(
      Date.now() - 1000,
    ).toISOString();
    await post(alice.cookie, { action: "refresh", memberId });
    d = await (await get(alice.cookie)).json();
    expect(d.membership.status_id).toBe("expired");
  });
  it("a billing outage cannot grant access; turning off email leaves notices queued", async () => {
    door.on = false;
    const before = await (await get(alice.cookie)).json();
    expect((await post(alice.cookie, { action: "refresh", memberId })).status).toBe(503);
    expect((await (await get(alice.cookie)).json()).membership.status_id).toBe(
      before.membership.status_id,
    );
    door.on = true;
    door.emailOn = false;
    await post(owner.cookie, { action: "deliver-email" });
    expect(door.mail).toHaveLength(0);
    door.emailOn = true;
    await post(owner.cookie, { action: "deliver-email" });
    expect(door.mail.length).toBeGreaterThan(0);
    const n = door.mail.length;
    await post(owner.cookie, { action: "deliver-email" });
    expect(door.mail).toHaveLength(n);
  });
  it("pause is confirmed on the server and renewal failure queues email", async () => {
    const s = door.subscriptions.get(subscriptionId);
    s.currentPeriodEnd = new Date(Date.now() + 86400000).toISOString();
    s.status = "past_due";
    await post(alice.cookie, { action: "refresh", memberId });
    await post(owner.cookie, { action: "deliver-email" });
    expect(door.mail.some((m: { subject: string }) => m.subject.includes("renewal failed"))).toBe(
      true,
    );
    expect((await post(alice.cookie, { action: "pause", memberId })).status).toBe(200);
    expect((await (await get(alice.cookie)).json()).membership.status_id).toBe("paused");
    expect((await post(staff.cookie, { action: "check-in", memberId })).status).toBe(409);
  });
  it("one-off passes need captured full payment; refresh does not extend or duplicate access", async () => {
    const ps = await (await get("", "?view=plans")).json();
    const p = ps.plans.find((x: { one_off: boolean }) => x.one_off);
    await post(bob.cookie, { action: "join", planId: p.id });
    const d = await (await get(bob.cookie)).json();
    const ref = [...door.checkouts.keys()][0];
    const c = door.checkouts.get(ref);
    c.status = "paid";
    c.payments = [
      {
        ref: "capture_test",
        status: "authorised",
        amount: { amount: p.price, currency: p.currency },
      },
    ];
    await post(bob.cookie, { action: "refresh", memberId: d.member.id });
    expect((await (await get(bob.cookie)).json()).membership.status_id).toBe("pending");
    c.payments[0].status = "captured";
    c.payments[0].amount.currency = "USD";
    await post(bob.cookie, { action: "refresh", memberId: d.member.id });
    expect((await (await get(bob.cookie)).json()).membership.status_id).toBe("pending");
    c.payments[0].amount.currency = p.currency;
    await post(bob.cookie, { action: "refresh", memberId: d.member.id });
    const first = await (await get(bob.cookie)).json();
    expect(first.membership.status_id).toBe("active");
    await post(bob.cookie, { action: "refresh", memberId: d.member.id });
    const next = await (await get(bob.cookie)).json();
    expect(next.membership.renews_at).toBe(first.membership.renews_at);
    expect(next.payments).toHaveLength(1);
  });
  async function payLatestPass(
    actor: Awaited<ReturnType<typeof person>>,
    plan: { price: number; currency: string },
    currency = plan.currency,
  ) {
    const c = [...door.checkouts.values()].at(-1);
    c.status = "paid";
    c.payments = [
      {
        ref: `capture_${randomUUID()}`,
        status: "captured",
        amount: { amount: plan.price, currency },
      },
    ];
    const d = await (await get(actor.cookie)).json();
    await post(actor.cookie, { action: "refresh", memberId: d.member.id });
    return (await (await get(actor.cookie)).json()).membership;
  }
  it("accepts a captured pass payment whatever the currency's letter case", async () => {
    const actor = await person("member");
    const plan = (await (await get("", "?view=plans")).json()).plans.find(
      (p: { one_off: boolean }) => p.one_off,
    );
    await post(actor.cookie, { action: "join", planId: plan.id });
    expect((await payLatestPass(actor, plan, plan.currency.toLowerCase())).status_id).toBe(
      "active",
    );
  });
  it("a member whose day pass ran out can buy another", async () => {
    const actor = await person("member");
    const plan = (await (await get("", "?view=plans")).json()).plans.find(
      (p: { one_off: boolean }) => p.one_off,
    );
    await post(actor.cookie, { action: "join", planId: plan.id });
    expect((await payLatestPass(actor, plan)).status_id).toBe("active");
    const d = await (await get(actor.cookie)).json();
    await db.query(
      "UPDATE memberships SET renews_at=now()-interval '1 minute' WHERE member_id=$1",
      [d.member.id],
    );
    expect((await post(staff.cookie, { action: "check-in", memberId: d.member.id })).status).toBe(
      409,
    );
    const again = await (await post(actor.cookie, { action: "join", planId: plan.id })).json();
    expect(again.url).toBeTruthy();
    expect((await (await get(actor.cookie)).json()).membership.status_id).toBe("pending");
    const renewed = await payLatestPass(actor, plan);
    expect(renewed.status_id).toBe("active");
    expect(new Date(renewed.renews_at).getTime()).toBeGreaterThan(Date.now());
    expect((await (await get(actor.cookie)).json()).payments).toHaveLength(2);
    expect((await post(staff.cookie, { action: "check-in", memberId: d.member.id })).status).toBe(
      200,
    );
  });
  it("CSV imports atomically and protects exports", async () => {
    expect(
      (
        await post(owner.cookie, {
          action: "import",
          csv: 'name,email\n"Taylor, Jo",jo@example.test\nAlex,alex@example.test',
        })
      ).status,
    ).toBe(200);
    expect(
      (await post(owner.cookie, { action: "import", csv: "name,email\nBad,not-email" })).status,
    ).toBe(400);
    for (const u of [staff, alice]) expect((await get(u.cookie, "?view=export")).status).toBe(403);
    expect(await (await get(owner.cookie, "?view=export")).text()).toContain('"Taylor, Jo"');
  });
  it("an imported member row links only to an account that confirmed that email", async () => {
    const id = randomUUID(),
      token = randomBytes(32).toString("hex");
    createdUsers.push(id);
    await db.query("INSERT INTO app_users(id,email,role) VALUES($1,'jo@example.test','member')", [
      id,
    ]);
    await db.query(
      "INSERT INTO app_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [createHmac("sha256", secret).update(token).digest("hex"), id],
    );
    const cookie = `app_session=${token}`;
    expect((await get(cookie)).status).toBe(403);
    await db.query("UPDATE app_users SET email_verified_at=now() WHERE id=$1", [id]);
    const r = await get(cookie);
    expect(r.status).toBe(200);
    expect((await r.json()).member.name).toBe("Taylor, Jo");
  });
  it("seed values rename but in-use categories and billing statuses cannot be removed", async () => {
    const data = await (await get(owner.cookie, "?view=settings")).json();
    expect(
      (
        await post(owner.cookie, {
          action: "list-rename",
          kind: "status",
          id: "active",
          name: "Current",
        })
      ).status,
    ).toBe(200);
    expect(
      (await post(owner.cookie, { action: "list-delete", kind: "status", id: "active" })).status,
    ).toBe(409);
    const studio = data.categories.find((c: { name: string }) => c.name === "Studio");
    expect(
      (await post(owner.cookie, { action: "list-delete", kind: "category", id: studio.id })).status,
    ).toBe(409);
  });
  it("a different origin cannot write and supplied roles do not become owner", async () => {
    expect(
      (
        await route.POST(
          new Request(`${origin}/api/memberships`, {
            method: "POST",
            headers: {
              cookie: owner.cookie,
              origin: "https://elsewhere.test",
              "content-type": "application/json",
            },
            body: JSON.stringify({ action: "staff" }),
          }),
        )
      ).status,
    ).toBe(403);
    const email = `signup-${randomUUID()}@example.test`;
    const r = await account.POST(
      new Request(`${origin}/api/account/signup`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ email, password: "long-enough-test-password", role: "owner" }),
      }),
      { params: Promise.resolve({ action: "signup" }) },
    );
    expect(r.status).toBe(200);
    const signed = await r.json();
    createdUsers.push(signed.user.id);
    expect(signed.user.role).toBe("member");
  });
  it("refuses a captured payment already assigned to another member", async () => {
    const actor = await person("member");
    const ps = await (await get("", "?view=plans")).json();
    const plan = ps.plans.find((p: { one_off: boolean }) => p.one_off);
    await post(actor.cookie, { action: "join", planId: plan.id });
    const d = await (await get(actor.cookie)).json();
    const c = [...door.checkouts.values()].at(-1);
    c.status = "paid";
    c.payments = [
      {
        ref: "capture_test",
        status: "captured",
        amount: { amount: plan.price, currency: plan.currency },
      },
    ];
    expect((await post(actor.cookie, { action: "refresh", memberId: d.member.id })).status).toBe(
      502,
    );
    expect((await (await get(actor.cookie)).json()).membership.status_id).toBe("pending");
  });
  it("will not retry a create outside the platform's duplicate-protection window", async () => {
    const actor = await person("member");
    door.on = false;
    await post(actor.cookie, { action: "join", planId });
    door.on = true;
    const d = await (await get(actor.cookie)).json();
    await db.query(
      "UPDATE memberships SET operation_started_at=now()-interval '24 hours' WHERE member_id=$1",
      [d.member.id],
    );
    const count = door.subscriptions.size;
    expect((await post(actor.cookie, { action: "join", planId })).status).toBe(409);
    expect(door.subscriptions.size).toBe(count);
  });
});
