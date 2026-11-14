import { execFileSync, spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { Pool } from "pg";
import { startFakeDoor } from "./fake-door.mjs";

const origin = "http://127.0.0.1:3510";
const secret = randomBytes(32).toString("hex");
const project = "memberships-walk";
if (!process.env.DATABASE_URL) throw Error("Use a disposable migrated DATABASE_URL");
const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const dir = path.resolve(".scratch/walk-door");
mkdirSync(".evidence", { recursive: true });
const door = await startFakeDoor({ dir, port: 3511 });
const server = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", "3510"],
  {
    stdio: ["ignore", "ignore", "inherit"],
    env: {
      ...process.env,
      SESSION_SECRET: secret,
      PRAMAAN_PROJECT_ID: project,
      APP_ORIGIN: origin,
      APP_COOKIE_SECURE: "false",
      PRAMAAN_MODULES_DIR: dir,
      PRAMAAN_PAYMENTS_TEST_MODE: "true",
    },
  },
);
let peakMiB = 0;
const sampler = setInterval(() => {
  try {
    const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((l) => l.trim().split(/\s+/).map(Number));
    const tree = new Set([server.pid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, ppid] of rows)
        if (tree.has(ppid) && !tree.has(pid)) {
          tree.add(pid);
          changed = true;
        }
    }
    peakMiB = Math.max(
      peakMiB,
      Math.ceil(rows.filter((r) => tree.has(r[0])).reduce((n, r) => n + r[2], 0) / 1024),
    );
  } catch {}
}, 100);
let browser;
let checks = 0;
const verify = async (test) => {
  await test();
  checks++;
};
function pass() {
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(
    JSON.stringify({
      v: 1,
      role: "owner",
      project,
      iat: now,
      exp: now + 60,
      nonce: randomBytes(18).toString("base64url"),
    }),
  ).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(`pramaan-owner-pass.v1.${body}`).digest("base64url")}`;
}
try {
  for (let n = 0; n < 100; n++) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch({ headless: true });
  const owner = await browser.newContext();
  const member = await browser.newContext();
  const staff = await browser.newContext();
  const other = await browser.newContext();
  const visitor = await browser.newContext();
  const o = await owner.newPage();
  const m = await member.newPage();
  const s = await staff.newPage();
  const b = await other.newPage();
  const v = await visitor.newPage();
  const api = async (context, input, route = "/api/memberships") =>
    context.request.post(origin + route, { headers: { origin }, data: input });
  const token = pass();
  await o.goto(`${origin}/api/account/owner-pass?token=${encodeURIComponent(token)}`);
  await verify(() => expect(o.getByRole("heading", { name: "Owner area" })).toBeVisible());
  await verify(async () =>
    expect(
      (
        await visitor.request.get(
          `${origin}/api/account/owner-pass?token=${encodeURIComponent(token)}`,
          { maxRedirects: 0 },
        )
      ).status(),
    ).toBe(401),
  );
  await o.getByLabel("Owner email").fill("owner-walk@example.test");
  await o.getByLabel("Password", { exact: true }).fill("owner-walk-strong-password");
  await o.getByRole("button", { name: /Save sign-in|Change sign-in/ }).click();
  await verify(() => expect(o.getByText("Saved. You can now sign in")).toBeVisible());
  // Each declared shipping checklist's navigation and heading, using its specified session.
  const manifest = JSON.parse(
    await (await import("node:fs/promises")).readFile("pramaan.kit.json", "utf8"),
  );
  for (const journey of manifest.journeys.filter((j) => j.status === "ships-working")) {
    const list = JSON.parse(
      await (await import("node:fs/promises")).readFile(journey.checklist, "utf8"),
    );
    const page = journey.role === "owner" ? o : v;
    for (const item of list.items)
      for (const step of item.steps) {
        if (step.goto) await page.goto(origin + step.goto);
        if (step.expectHeading)
          await verify(() =>
            expect(
              page.getByRole("heading", { name: step.expectHeading, exact: false }),
            ).toBeVisible(),
          );
      }
    console.log(`journey:${journey.id}: passed`);
  }
  await o.goto(origin + "/settings");
  await o.getByLabel("Staff email").fill("desk-walk@example.test");
  await o.getByLabel("Temporary password").fill("front-desk-strong-password");
  await o.getByRole("button", { name: "Add staff", exact: true }).click();
  await verify(() => expect(o.getByText("Front-desk account added.")).toBeVisible());
  await s.goto(origin + "/signin");
  const signin = s
    .locator("section")
    .filter({ has: s.getByRole("heading", { name: "Sign in", exact: true }) });
  await signin.getByLabel("Email", { exact: true }).fill("desk-walk@example.test");
  await signin.getByLabel("Password", { exact: true }).fill("front-desk-strong-password");
  await signin.getByRole("button", { name: "Sign in", exact: true }).click();
  await s.waitForURL("**/membership");
  await m.goto(origin + "/signin");
  const signup = m
    .locator("section")
    .filter({ has: m.getByRole("heading", { name: "Become a member" }) });
  await signup.getByLabel("Phone number").fill("9000000000");
  await signup.getByLabel("Your name").fill("member-walk");
  await signup.getByLabel("Email", { exact: true }).fill("member-walk@example.test");
  await signup.getByLabel("Password", { exact: true }).fill("member-walk-strong-password");
  await signup.getByRole("button", { name: "Create account" }).click();
  await m.waitForURL("**/membership");
  await verify(() => expect(m.getByRole("heading", { name: "My membership" })).toBeVisible());
  await m.goto(origin + "/");
  await m.getByRole("button", { name: "Choose Everyday" }).click();
  await m.waitForURL("http://127.0.0.1:3511/**");
  await verify(() => expect(m.getByRole("heading", { name: "Test payment" })).toBeVisible());
  const mid = (await (await member.request.get(origin + "/api/memberships")).json()).member.id;
  await verify(async () =>
    expect((await api(staff, { action: "check-in", memberId: mid })).status()).toBe(409),
  );
  await m.getByRole("button", { name: "Confirm test payment" }).click();
  await m.waitForURL("**/membership");
  await m.getByRole("button", { name: "Refresh billing" }).click();
  await verify(() => expect(m.getByText("Active · £45.00")).toBeVisible());
  await verify(() =>
    expect(m.getByRole("heading", { name: "Payments", exact: true })).toBeVisible(),
  );
  await s.goto(origin + "/desk");
  await s.getByLabel("Find by name or member code").fill("member-walk");
  await s
    .getByRole("row")
    .filter({ hasText: "member-walk" })
    .getByRole("button", { name: "Check in", exact: true })
    .click();
  await verify(() => expect(s.getByText("Checked in. Enjoy your visit.")).toBeVisible());
  await m.reload();
  await verify(() => expect(m.getByRole("heading", { name: "Visit history" })).toBeVisible());
  const d = await (await member.request.get(origin + "/api/memberships")).json();
  await verify(async () => expect(d.visits).toHaveLength(1));
  await verify(async () => expect(d.payments).toHaveLength(1));
  await b.goto(origin + "/signin");
  const signupB = b
    .locator("section")
    .filter({ has: b.getByRole("heading", { name: "Become a member" }) });
  await signupB.getByLabel("Phone number").fill("9000000001");
  await signupB.getByLabel("Your name").fill("other-walk");
  await signupB.getByLabel("Email", { exact: true }).fill("other-walk@example.test");
  await signupB.getByLabel("Password", { exact: true }).fill("other-walk-strong-password");
  await signupB.getByRole("button", { name: "Create account" }).click();
  await b.waitForURL("**/membership");
  await verify(async () =>
    expect((await other.request.get(`${origin}/api/memberships?id=${mid}`)).status()).toBe(404),
  );
  await verify(async () =>
    expect((await api(other, { action: "cancel", memberId: mid })).status()).toBe(404),
  );
  await verify(async () => expect((await api(staff, { action: "plan" })).status()).toBe(403));
  await verify(async () =>
    expect((await member.request.get(origin + "/api/memberships?view=settings")).status()).toBe(
      403,
    ),
  );
  await verify(async () =>
    expect((await visitor.request.get(origin + "/api/memberships")).status()).toBe(401),
  );
  await m.getByRole("button", { name: "Cancel at period end" }).click();
  await verify(() => expect(m.getByText("Access ends:")).toBeVisible());
  const sub = [...door.subscriptions.values()].find((r) => r.status === "active");
  sub.currentPeriodEnd = new Date(Date.now() - 1000).toISOString();
  await m.getByRole("button", { name: "Refresh billing" }).click();
  await verify(() => expect(m.getByText("Expired · £45.00")).toBeVisible());
  await s.reload();
  await s.getByLabel("Find by name or member code").fill("member-walk");
  await s
    .getByRole("row")
    .filter({ hasText: "member-walk" })
    .getByRole("button", { name: "Check in", exact: true })
    .click();
  await verify(() =>
    expect(s.getByText("Check-in refused: membership is not active.")).toBeVisible(),
  );
  sub.status = "past_due";
  await m.getByRole("button", { name: "Refresh billing" }).click();
  await verify(() => expect(m.getByText("Renewal failed · £45.00")).toBeVisible());
  await o.goto(origin + "/settings");
  await o.getByRole("button", { name: "Send queued notices" }).click();
  await verify(async () => {
    await expect.poll(() => door.mail.length).toBeGreaterThanOrEqual(3);
    await expect.poll(() => door.mail.some((r) => r.subject.includes("Welcome"))).toBe(true);
    await expect.poll(() => door.mail.some((r) => r.subject.includes("cancellation"))).toBe(true);
    await expect.poll(() => door.mail.some((r) => r.subject.includes("renewal failed"))).toBe(true);
  });
  const status = o.getByLabel("Active", { exact: true });
  await status.fill("Current");
  await status.locator("..").locator("..").getByRole("button", { name: "Rename" }).click();
  await verify(() => expect(o.getByLabel("Current", { exact: true })).toBeVisible());
  await o
    .getByLabel("CSV: name,email")
    .fill("name,email\nImported Walker,imported-walk@example.test");
  await o.getByRole("button", { name: "Import members" }).click();
  await verify(() => expect(o.getByText("Members imported.")).toBeVisible());
  await verify(async () =>
    expect(
      await (await owner.request.get(origin + "/api/memberships?view=export")).text(),
    ).toContain("Imported Walker"),
  );
  await verify(async () =>
    expect(
      await (await owner.request.get(origin + "/api/memberships?view=export&kind=visits")).text(),
    ).toContain("member-walk"),
  );
  // One-off checkout is an explicit test payment, not the browser marking itself paid.
  await b.goto(origin + "/");
  await b.getByRole("button", { name: "Choose Day pass" }).click();
  await b.waitForURL("http://127.0.0.1:3511/**");
  await b.getByRole("button", { name: "Confirm test payment" }).click();
  await b.waitForURL("**/membership");
  await b.getByRole("button", { name: "Refresh billing" }).click();
  await verify(() => expect(b.getByText("Current · £12.00")).toBeVisible());
  await verify(async () =>
    expect((await api(member, { action: "check-in", memberId: mid })).status()).toBe(403),
  );
  await v.goto(origin + "/");
  await v.screenshot({ path: ".evidence/plans-desktop.png", fullPage: true });
  await v.setViewportSize({ width: 390, height: 844 });
  await v.screenshot({ path: ".evidence/plans-mobile.png", fullPage: true });
  await verify(async () =>
    expect(await v.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
      true,
    ),
  );
  const screens = ["/", "/signin", "/membership", "/desk", "/settings", "/owner"];
  for (const route of screens) {
    await o.goto(origin + route);
    await verify(() => expect(o.locator("h1")).toBeVisible());
  }
  writeFileSync(
    ".evidence/walk.json",
    JSON.stringify(
      {
        ok: true,
        assertions: checks,
        shippingJourneys: manifest.journeys.filter((j) => j.status === "ships-working").length,
        appPeakMiB: peakMiB,
        fixture: "fake module door; no live calls",
      },
      null,
      2,
    ),
  );
  console.log(`Headless walk passed: ${checks} assertions, app peak ${peakMiB} MiB.`);
} finally {
  clearInterval(sampler);
  await browser?.close();
  server.kill("SIGTERM");
  await new Promise((r) => server.once("exit", r));
  await door.close();
  await db.end();
}
