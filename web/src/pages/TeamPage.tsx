import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client";
import { keys, useStaff } from "../api/queries";
import { ErrorNotice } from "../components/bits";
import { ROLE_LABEL, initials } from "../lib/format";

type Invitation = { email: string; full_name: string; email_sent: boolean };

// Leads: who is on the team, how busy they are, and inviting someone new.
// Staff never sign up on their own; an invitation is the only way in.
export function TeamPage() {
  const client = useQueryClient();
  const staff = useStaff(true);
  const teams = new Map(
    (staff.data ?? [])
      .filter((member) => member.team_id)
      .map((member) => [member.team_id!, `${member.team_name} (${member.region_code})`]),
  );

  const [form, setForm] = useState({ email: "", full_name: "", role: "agent", team_id: "" });
  const [last, setLast] = useState<Invitation | null>(null);

  const invite = useMutation({
    mutationFn: () =>
      api<Invitation>("/api/v1/staff/invites", {
        method: "POST",
        body: { ...form, team_id: form.team_id || [...teams.keys()][0] },
      }),
    onSuccess: (invitation) => {
      setLast(invitation);
      setForm({ ...form, email: "", full_name: "" });
      void client.invalidateQueries({ queryKey: keys.staff });
    },
  });

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Team</h1>
          <p className="sub">
            Everyone on the support side, with today&apos;s load. New people join by invitation.
          </p>
        </div>
      </header>

      <div className="team-grid">
        <section>
          <h2 className="section-title">People</h2>
          <ErrorNotice error={staff.error} />
          <ul className="people">
            {staff.data?.map((member) => (
              <li key={member.id}>
                <span className="avatar small" aria-hidden="true">
                  {initials(member.full_name)}
                </span>
                <span>
                  <b>{member.full_name}</b>
                  <span className="muted">
                    {" "}
                    · {ROLE_LABEL[member.role]} · {member.team_name ?? "no team"}
                  </span>
                </span>
                <span className="mono muted">
                  {member.max_open ? `${member.open_count}/${member.max_open}` : ""}
                </span>
                {member.invite_pending ? (
                  <span className="presence">
                    <span className="tag">Invited</span>
                  </span>
                ) : (
                  <span className={member.is_online ? "presence on" : "presence"}>
                    {member.is_online ? "Online" : "Away"}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className="section-title">Invite someone</h2>
          <form
            className="invite-form"
            onSubmit={(event) => {
              event.preventDefault();
              invite.mutate();
            }}
          >
            <label className="field">
              <span>Name</span>
              <input
                className="input"
                required
                value={form.full_name}
                onChange={(e) => setForm({ ...form, full_name: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Email</span>
              <input
                className="input"
                type="email"
                required
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Role</span>
              <select
                className="select"
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
              >
                <option value="agent">Agent</option>
                <option value="escalation_manager">Escalation manager</option>
              </select>
            </label>
            <label className="field">
              <span>Team</span>
              <select
                className="select"
                value={form.team_id}
                onChange={(e) => setForm({ ...form, team_id: e.target.value })}
              >
                {[...teams].map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <button className="btn primary" disabled={invite.isPending || teams.size === 0}>
                {invite.isPending ? "Sending" : "Send invitation"}
              </button>
            </div>
            <ErrorNotice error={invite.error} />
            {last ? (
              <div className="notice" role="status">
                <p>
                  {last.email_sent
                    ? `Invitation sent to ${last.email}. The link works for 7 days.`
                    : `${last.full_name} was added, but the email could not be sent. Check the mail server, then invite again later.`}
                </p>
              </div>
            ) : null}
            <p className="muted" style={{ fontSize: 13 }}>
              New agents receive tickets from routing once they have shifts and go online.
            </p>
          </form>
        </section>
      </div>
    </>
  );
}
