import { useState } from "react";
import { useAddMessage } from "../api/mutations";
import { useMessages } from "../api/queries";
import type { Ticket, User, Visibility } from "../api/types";
import { dateTime, initials } from "../lib/format";
import { isStaff } from "../lib/rules";
import { ErrorNotice } from "./bits";

// The original request, the replies, and the box to write a new one.
// Internal notes are drawn like a yellow legal pad so nobody mistakes one for
// a reply. Requesters never receive them at all: the database hides them.
export function Conversation({ ticket, user }: { ticket: Ticket; user: User }) {
  const messages = useMessages(ticket.id);
  const staff = isStaff(user.role);

  return (
    <section aria-label="Conversation">
      <article className="original">
        <div className="msg-head">
          <b>Original request</b>
          <span className="muted mono">{dateTime(ticket.created_at)}</span>
        </div>
        <p>{ticket.body}</p>
      </article>

      <ErrorNotice error={messages.error} />

      {messages.data && messages.data.length > 0 ? (
        <ol className="thread" style={{ marginTop: 16 }}>
          {messages.data.map((message) => (
            <li
              key={message.id}
              className="msg"
              data-visibility={message.visibility}
              data-mine={message.author_id === user.id}
            >
              <span className="avatar small" aria-hidden="true">
                {initials(message.author_name)}
              </span>
              <div>
                <div className="msg-head">
                  <b>{message.author_name}</b>
                  {message.visibility === "internal" ? (
                    <span className="internal-flag">INTERNAL NOTE</span>
                  ) : null}
                  <span className="muted mono">{dateTime(message.created_at)}</span>
                </div>
                <div className="msg-card">
                  <p className="msg-body">{message.body}</p>
                </div>
              </div>
            </li>
          ))}
        </ol>
      ) : null}

      {ticket.status === "closed" ? (
        <p className="muted" style={{ marginTop: 20 }}>
          This ticket is closed. Raise a new one if the problem comes back.
        </p>
      ) : (
        <Composer ticketId={ticket.id} staff={staff} />
      )}
    </section>
  );
}

function Composer({ ticketId, staff }: { ticketId: string; staff: boolean }) {
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("public");
  const send = useAddMessage(ticketId);

  const submit = () => {
    if (!body.trim()) return;
    send.mutate({ body: body.trim(), visibility }, { onSuccess: () => setBody("") });
  };

  return (
    <form
      className="composer"
      data-visibility={visibility}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className="visually-hidden" htmlFor="reply">
        {visibility === "internal" ? "Internal note" : "Reply"}
      </label>
      <textarea
        id="reply"
        className="textarea"
        placeholder={
          visibility === "internal"
            ? "Note for the team. The agency will not see this."
            : staff
              ? "Write a reply to the agency"
              : "Write to the support team"
        }
        value={body}
        maxLength={10000}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
        }}
      />
      <div className="composer-foot">
        {staff ? (
          <div className="segmented" role="group" aria-label="Who sees this">
            <button
              type="button"
              aria-pressed={visibility === "public"}
              onClick={() => setVisibility("public")}
            >
              Reply
            </button>
            <button
              type="button"
              aria-pressed={visibility === "internal"}
              onClick={() => setVisibility("internal")}
            >
              Internal note
            </button>
          </div>
        ) : (
          <span className="composer-hint">The support team is notified.</span>
        )}
        <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span className="composer-hint">Ctrl + Enter</span>
          <button className="btn primary" type="submit" disabled={send.isPending || !body.trim()}>
            {send.isPending ? "Sending" : visibility === "internal" ? "Add note" : "Send reply"}
          </button>
        </span>
      </div>
      {send.error ? (
        <div style={{ padding: "0 8px 8px" }}>
          <ErrorNotice error={send.error} />
        </div>
      ) : null}
    </form>
  );
}
