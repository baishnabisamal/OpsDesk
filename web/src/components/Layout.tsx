import { useMutation, useQueryClient } from "@tanstack/react-query";
import { NavLink, Outlet } from "react-router";
import { api, logout } from "../api/client";
import { keys, useStaff } from "../api/queries";
import type { StaffMember } from "../api/types";
import { useRequiredUser } from "../auth";
import { ROLE_LABEL, initials } from "../lib/format";
import { isStaff } from "../lib/rules";
import { useLiveUpdates } from "../live";

const STAFF_NAV = [
  {
    title: "Work",
    links: [
      { to: "/queues/triage", label: "Triage" },
      { to: "/queues/mine", label: "My queue" },
      { to: "/queues/escalations", label: "Escalations" },
      { to: "/queues/linked", label: "Linked cases" },
      { to: "/queues/region", label: "By region" },
      { to: "/queues/intent", label: "By intent" },
    ],
  },
  { title: "Find", links: [{ to: "/tickets", label: "All tickets" }] },
];

const LEAD_NAV = { title: "Lead", links: [{ to: "/insights", label: "Insights and export" }] };

const REQUESTER_NAV = [
  {
    title: "Your agency",
    links: [
      { to: "/tickets", label: "Our tickets" },
      { to: "/new", label: "Raise a ticket" },
    ],
  },
];

export function Layout() {
  const user = useRequiredUser();
  const staff = isStaff(user.role);
  const live = useLiveUpdates(true);
  const groups = staff
    ? [...STAFF_NAV, ...(user.role === "lead" ? [LEAD_NAV] : [])]
    : REQUESTER_NAV;

  return (
    <div className="shell">
      <aside className="sidebar">
        <NavLink to="/" className="wordmark" aria-label="OpsDesk home">
          <b>OpsDesk</b>
          <i aria-hidden="true" />
        </NavLink>

        {groups.map((group) => (
          <nav className="nav-group" key={group.title} aria-label={group.title}>
            <h2>{group.title}</h2>
            <ul>
              {group.links.map((link) => (
                <li key={link.to}>
                  <NavLink className="nav-link" to={link.to} end={link.to === "/tickets"}>
                    {link.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        ))}

        <div className="sidebar-foot">
          <div className="whoami">
            <span className="avatar" aria-hidden="true">
              {initials(user.full_name)}
            </span>
            <div>
              <div className="who-name">{user.full_name}</div>
              <div className="who-role">{ROLE_LABEL[user.role]}</div>
            </div>
          </div>
          {staff ? <PresenceToggle userId={user.id} /> : null}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span
              className="live"
              data-status={live}
              title="Live updates from the realtime gateway"
            >
              {live === "live" ? "Live" : live === "connecting" ? "Connecting" : "Not live"}
            </span>
            <button className="btn quiet small" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </div>
      </aside>
      <main>
        <Outlet />
      </main>
    </div>
  );
}

// Online means "routing may give me tickets". It does not take away the
// tickets already held.
function PresenceToggle({ userId }: { userId: string }) {
  const client = useQueryClient();
  const { data: staff } = useStaff(true);
  const me = staff?.find((member) => member.id === userId);
  const online = me?.is_online ?? false;

  const toggle = useMutation({
    mutationFn: (next: boolean) =>
      api<{ is_online: boolean; open_count: number; max_open: number }>("/api/v1/me/presence", {
        method: "PUT",
        body: { online: next },
      }),
    onSuccess: (presence) => {
      client.setQueryData<StaffMember[]>(keys.staff, (old) =>
        old?.map((member) => (member.id === userId ? { ...member, ...presence } : member)),
      );
    },
  });

  return (
    <div className="segmented" role="group" aria-label="Availability">
      <button aria-pressed={online} disabled={toggle.isPending} onClick={() => toggle.mutate(true)}>
        Online
      </button>
      <button
        aria-pressed={!online}
        disabled={toggle.isPending}
        onClick={() => toggle.mutate(false)}
      >
        Away
      </button>
      {me && me.max_open ? (
        <span className="mono muted" style={{ alignSelf: "center", padding: "0 10px" }}>
          {me.open_count}/{me.max_open}
        </span>
      ) : null}
    </div>
  );
}
