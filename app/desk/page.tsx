"use client";
import { useState } from "react";
import { useResource } from "../../lib/pramaan/client";
import type { Detail } from "../membership/page";
import { Action, Form, post } from "../parts";
export default function Desk() {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const { data, error, reload } = useResource<{
    members: { id: string; name: string; code: string; status: string }[];
  }>(`/api/memberships?q=${encodeURIComponent(query)}`);
  const detail = useResource<Detail>(
    `/api/memberships?id=${selected || "00000000-0000-0000-0000-000000000000"}`,
  );
  return (
    <main className="workspace">
      <p className="eyebrow">A WARM WELCOME STARTS HERE</p>
      <h1>Front desk</h1>
      <label>
        Find by name or member code
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Start typing a name or code"
        />
      </label>
      {error && <p role="alert">{error.message}</p>}
      <table>
        <thead>
          <tr>
            <th>Member</th>
            <th>Code</th>
            <th>Membership</th>
            <th>Visit</th>
          </tr>
        </thead>
        <tbody>
          {data?.members?.map((m) => (
            <tr key={m.id}>
              <td>
                <button type="button" onClick={() => setSelected(m.id)}>
                  {m.name}
                </button>
              </td>
              <td>{m.code}</td>
              <td>{m.status ?? "No membership"}</td>
              <td>
                <Action input={{ action: "check-in", memberId: m.id }} reload={reload}>
                  Check in
                </Action>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {selected && detail.data?.member && (
        <section>
          <h2>{detail.data.member.name} — visit history</h2>
          {detail.data.visits.map((v) => (
            <p key={v.id}>{new Date(v.visited_at).toLocaleString("en-GB")}</p>
          ))}
          {detail.data.notes && (
            <>
              <h3>Private member notes</h3>
              {detail.data.notes.map((n) => (
                <p key={n.id}>{n.body}</p>
              ))}
              <Form
                label="Save note"
                submit={async (f) => {
                  const r = await post({ action: "note", memberId: selected, body: f.get("body") });
                  detail.reload();
                  return r;
                }}
              >
                <label>
                  Note
                  <textarea name="body" required maxLength={2000} />
                </label>
              </Form>
            </>
          )}
        </section>
      )}
    </main>
  );
}
