import { randomUUID } from "node:crypto";
import { csv, parseCsv } from "../../../lib/csv";
import * as kit from "../../../lib/memberships";
import { handle, readBody, reply } from "../../../lib/roles/http";
import { accountRuntime, database } from "../../../lib/runtime";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return handle(async () => {
    const q = new URL(request.url).searchParams;
    if (q.get("view") === "plans") return reply({ plans: await kit.plans() });
    const u = await accountRuntime().requireUser(request);
    if (q.get("view") === "settings") {
      kit.owner(u);
      return reply({
        statuses: (
          await database().query("SELECT * FROM membership_statuses ORDER BY position,name")
        ).rows,
        categories: (await database().query("SELECT * FROM plan_categories ORDER BY name")).rows,
        staff: (
          await database().query("SELECT email FROM app_users WHERE role='staff' ORDER BY email")
        ).rows,
      });
    }
    if (q.get("view") === "export") {
      kit.owner(u);
      const visits = q.get("kind") === "visits";
      const r = await database().query(
        visits
          ? "SELECT m.name,m.code,c.visited_at FROM check_ins c JOIN members m ON m.id=c.member_id ORDER BY c.visited_at"
          : "SELECT name,email,code FROM members ORDER BY name",
      );
      return new Response(
        csv([
          visits ? ["name", "code", "visited_at"] : ["name", "email", "code"],
          ...r.rows.map((r) => Object.values(r)),
        ]),
        {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="${visits ? "check-ins" : "members"}.csv"`,
            "cache-control": "no-store",
          },
        },
      );
    }
    if (q.has("id")) return reply(await kit.details(u, q.get("id")));
    if (u.role === "member") {
      const m = await kit.memberFor(u);
      return reply(await kit.details(u, m.id));
    }
    return reply({ members: await kit.lookup(u, q.get("q") ?? "") });
  });
}
export async function POST(request: Request) {
  return handle(async () => {
    const u = await accountRuntime().requireUser(request);
    const b = await readBody(request);
    switch (b.action) {
      case "profile": {
        const m = await kit.memberFor(u);
        const phone = kit.text(b.phone, 12);
        if (!/^[0-9]{10,12}$/.test(phone))
          kit.fail(400, "Enter a phone number with 10 to 12 digits.");
        await database().query("UPDATE members SET name=$2,phone=$4 WHERE id=$1 AND user_id=$3", [
          m.id,
          kit.text(b.name),
          u.id,
          phone,
        ]);
        return reply({ message: "Name saved." });
      }
      case "join":
        return reply(await kit.join(u, b.planId));
      case "refresh":
      case "start":
      case "pause":
      case "cancel":
        return reply(await kit.billing(u, b.memberId, String(b.action)));
      case "check-in":
        return reply(await kit.checkIn(u, b.memberId));
      case "staff":
        return reply(await kit.addStaff(u, b));
      case "deliver-email":
        kit.owner(u);
        return reply(await kit.deliverEmails());
      case "note": {
        kit.owner(u);
        const m = await kit.member(u, b.memberId);
        await database().query(
          "INSERT INTO member_notes(member_id,author_id,body) VALUES($1,$2,$3)",
          [m.id, u.id, kit.text(b.body, 2000)],
        );
        return reply({ message: "Note saved." });
      }
      case "import": {
        kit.owner(u);
        const rows = parseCsv(kit.text(b.csv, 14000));
        if (rows.shift()?.join(",").toLowerCase() !== "name,email")
          kit.fail(400, "CSV must start with name,email.");
        await kit.transaction(async (c) => {
          for (const row of rows) {
            if (row.length !== 2) kit.fail(400, "Each row needs a name and email.");
            const name = kit.text(row[0]);
            const email = kit.text(row[1], 254).toLowerCase();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
              kit.fail(400, "Check the email addresses.");
            await c.query(
              "INSERT INTO members(name,email) VALUES($1,$2) ON CONFLICT(email) DO NOTHING",
              [name, email],
            );
          }
        });
        return reply({
          message:
            "Members imported. They can sign up with their own email; imported rows never grant access.",
        });
      }
      case "plan": {
        kit.owner(u);
        const price = Number(b.price);
        if (!Number.isSafeInteger(price) || price < 1 || price > 10000000)
          kit.fail(400, "Enter a price in whole pennies, from 1 to 10000000.");
        if (!["day", "week", "month", "year"].includes(String(b.period)))
          kit.fail(400, "Choose a billing period.");
        if (!["GBP", "USD", "EUR", "INR"].includes(String(b.currency)))
          kit.fail(400, "Choose a currency.");
        await database().query(
          "INSERT INTO plans(name,price,currency,period,one_off,perks,category_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            kit.text(b.name),
            price,
            b.currency,
            b.period,
            b.oneOff === true,
            typeof b.perks === "string" ? b.perks.slice(0, 1000) : "",
            kit.uuid(b.categoryId),
          ],
        );
        return reply({ message: "Plan added." });
      }
      case "list-add":
      case "list-rename":
      case "list-delete": {
        kit.owner(u);
        const category = b.kind === "category";
        if (!category && b.kind !== "status") kit.fail(400, "Choose a list.");
        const table = category ? "plan_categories" : "membership_statuses";
        const id = category ? kit.uuid(b.id) : kit.text(b.id, 60);
        if (b.action === "list-add") {
          await database().query(`INSERT INTO ${table}(id,name) VALUES($1,$2)`, [
            category ? randomUUID() : `custom-${randomUUID()}`,
            kit.text(b.name),
          ]);
        } else if (b.action === "list-rename")
          await database().query(`UPDATE ${table} SET name=$2 WHERE id=$1`, [id, kit.text(b.name)]);
        else {
          if (
            !category &&
            ["active", "pending", "paused", "past_due", "canceled", "expired", "unknown"].includes(
              id,
            )
          )
            kit.fail(409, "This status is required by billing; rename it instead.");
          try {
            await database().query(`DELETE FROM ${table} WHERE id=$1`, [id]);
          } catch {
            kit.fail(409, "This value is in use and cannot be removed.");
          }
        }
        return reply({ message: "List updated." });
      }
      default:
        return kit.fail(400, "Choose an action.");
    }
  });
}
