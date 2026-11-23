"use client";
import { useResource } from "../../lib/pramaan/client";
import { Action, Form, post } from "../parts";

type Value = { id: string; name: string };
export default function Settings() {
  const { data, error, reload } = useResource<{
    statuses: Value[];
    categories: Value[];
    staff: { email: string }[];
  }>("/api/memberships?view=settings");
  const save = async (input: object) => {
    const r = await post(input);
    reload();
    return r;
  };
  return (
    <main className="workspace">
      <p className="eyebrow">MAKE IT YOUR OWN</p>
      <h1>Manage the club</h1>
      {error && <p role="alert">{error.message}</p>}
      {data && (
        <>
          <section>
            <h2>Front-desk staff</h2>
            {data.staff.map((s) => (
              <p key={s.email}>{s.email}</p>
            ))}
            <Form
              label="Add staff"
              submit={(f) =>
                save({ action: "staff", email: f.get("email"), password: f.get("password") })
              }
            >
              <label>
                Staff email
                <input name="email" type="email" required />
              </label>
              <label>
                Temporary password
                <input name="password" type="password" minLength={12} required />
              </label>
            </Form>
          </section>
          {(
            [
              ["status", data.statuses],
              ["category", data.categories],
            ] as const
          ).map(([kind, values]) => (
            <section key={kind}>
              <h2>{kind === "status" ? "Membership statuses" : "Plan categories"}</h2>
              {values.map((v) => (
                <div className="list-row" key={v.id}>
                  <Form
                    label="Rename"
                    submit={(f) =>
                      save({ action: "list-rename", kind, id: v.id, name: f.get("name") })
                    }
                  >
                    <label>
                      {v.name}
                      <input name="name" defaultValue={v.name} required maxLength={120} />
                    </label>
                  </Form>
                  <Action input={{ action: "list-delete", kind, id: v.id }} reload={reload}>
                    Remove
                  </Action>
                </div>
              ))}
              <Form
                label={kind === "status" ? "Add status" : "Add category"}
                submit={(f) =>
                  save({
                    action: "list-add",
                    kind,
                    id: kind === "category" ? "00000000-0000-0000-0000-000000000000" : "new",
                    name: f.get("name"),
                  })
                }
              >
                <label>
                  New name
                  <input name="name" required maxLength={120} />
                </label>
              </Form>
            </section>
          ))}
          <section>
            <h2>Add a plan</h2>
            <Form
              label="Add plan"
              submit={(f) =>
                save({
                  action: "plan",
                  name: f.get("name"),
                  price: Number(f.get("price")),
                  currency: f.get("currency"),
                  period: f.get("period"),
                  categoryId: f.get("category"),
                  perks: f.get("perks"),
                  oneOff: f.get("oneOff") === "yes",
                })
              }
            >
              <label>
                Plan name
                <input name="name" required />
              </label>
              <label>
                Price in pennies
                <input name="price" type="number" min={1} required />
              </label>
              <label>
                Currency
                <select name="currency">
                  {["GBP", "USD", "EUR", "INR"].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label>
                Period
                <select name="period">
                  {["day", "week", "month", "year"].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label>
                Category
                <select name="category">
                  {data.categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Perks
                <textarea name="perks" />
              </label>
              <label>
                Payment type
                <select name="oneOff">
                  <option value="no">Recurring subscription</option>
                  <option value="yes">One-off pass</option>
                </select>
              </label>
            </Form>
          </section>
          <section>
            <h2>Member records</h2>
            <Form
              label="Import members"
              submit={(f) => save({ action: "import", csv: f.get("csv") })}
            >
              <label>
                CSV: name,email
                <textarea name="csv" required placeholder={"name,email\nAlex,alex@yourclub.org"} />
              </label>
            </Form>
            <div className="links">
              <a href="/api/memberships?view=export">Export members</a>
              <a href="/api/memberships?view=export&kind=visits">Export check-ins</a>
            </div>
          </section>
          <section>
            <h2>Email notices</h2>
            <p>Welcome, failed renewal and cancellation notices stay queued when email is off.</p>
            <Action input={{ action: "deliver-email" }}>Send queued notices</Action>
          </section>
        </>
      )}
    </main>
  );
}
