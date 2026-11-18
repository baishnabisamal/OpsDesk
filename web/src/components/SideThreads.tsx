import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client";
import { keys, useSideConversation, useSideConversations } from "../api/queries";
import type { SideConversation } from "../api/types";
import { dateTime } from "../lib/format";
import { ErrorNotice } from "./bits";

// Supplier threads: emails with the hotel or supplier, kept beside the
// ticket. The recipients are stored on the thread itself, so they stay the
// same when the ticket moves to another agent. Staff only.
export function SideThreads({ ticketId }: { ticketId: string }) {
  const list = useSideConversations(ticketId, true);
  const [open, setOpen] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  return (
    <section aria-label="Supplier threads">
      <ErrorNotice error={list.error} />
      {list.data?.map((conversation) => (
        <ThreadCard
          key={conversation.id}
          conversation={conversation}
          expanded={open === conversation.id}
          onToggle={() => setOpen(open === conversation.id ? null : conversation.id)}
        />
      ))}
      {list.data && list.data.length === 0 && !starting ? (
        <p className="muted">No supplier thread yet.</p>
      ) : null}
      {starting ? (
        <NewThread ticketId={ticketId} onDone={() => setStarting(false)} />
      ) : (
        <button className="btn" onClick={() => setStarting(true)}>
          Write to a supplier
        </button>
      )}
    </section>
  );
}

function ThreadCard(props: {
  conversation: SideConversation;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { conversation } = props;
  const detail = useSideConversation(props.expanded ? conversation.id : null);
  const client = useQueryClient();
  const [body, setBody] = useState("");
  const send = useMutation({
    mutationFn: () =>
      api(`/api/v1/side-conversations/${conversation.id}/messages`, {
        method: "POST",
        body: { body },
      }),
    onSuccess: () => {
      setBody("");
      void client.invalidateQueries({ queryKey: keys.side(conversation.id) });
    },
  });

  return (
    <article className="side-thread">
      <header>
        <div>
          <b>{conversation.subject}</b>
          <div className="muted" style={{ fontSize: 13 }}>
            To {conversation.participants.map((p) => p.name ?? p.email).join(", ")}
          </div>
        </div>
        <button className="btn small" onClick={props.onToggle} aria-expanded={props.expanded}>
          {props.expanded ? "Hide" : "Open"}
        </button>
      </header>
      {props.expanded ? (
        <div>
          <ol className="thread">
            {detail.data?.messages?.map((message) => (
              <li key={message.id}>
                <div className="msg-head">
                  <b>
                    {message.direction === "inbound" ? (message.from_email ?? "Supplier") : "Us"}
                  </b>
                  <span className="muted mono">{dateTime(message.created_at)}</span>
                </div>
                <div className="msg-card">
                  <p className="msg-body">{message.body}</p>
                </div>
              </li>
            ))}
          </ol>
          <form
            style={{ display: "grid", gap: 8, padding: "0 14px 14px" }}
            onSubmit={(event) => {
              event.preventDefault();
              if (body.trim()) send.mutate();
            }}
          >
            <textarea
              className="textarea"
              placeholder="Write to the supplier. Sent by email."
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
            <div>
              <button className="btn primary" disabled={send.isPending || !body.trim()}>
                {send.isPending ? "Sending" : "Send"}
              </button>
            </div>
            <ErrorNotice error={send.error} />
          </form>
        </div>
      ) : null}
    </article>
  );
}

function NewThread({ ticketId, onDone }: { ticketId: string; onDone: () => void }) {
  const client = useQueryClient();
  const [subject, setSubject] = useState("");
  const [to, setTo] = useState("");
  const [body, setBody] = useState("");

  const start = useMutation({
    mutationFn: () =>
      api(`/api/v1/tickets/${ticketId}/side-conversations`, {
        method: "POST",
        body: {
          subject,
          body,
          participants: to
            .split(/[,\s]+/)
            .filter(Boolean)
            .map((email) => ({ email, name: null })),
        },
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.sides(ticketId) });
      onDone();
    },
  });

  return (
    <form
      className="side-new"
      onSubmit={(event) => {
        event.preventDefault();
        start.mutate();
      }}
    >
      <label className="field">
        <span>To (email addresses, comma separated)</span>
        <input className="input" required value={to} onChange={(e) => setTo(e.target.value)} />
      </label>
      <label className="field">
        <span>Subject</span>
        <input
          className="input"
          required
          maxLength={200}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
      </label>
      <label className="field">
        <span>Message</span>
        <textarea
          className="textarea"
          required
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn primary" disabled={start.isPending}>
          {start.isPending ? "Sending" : "Send to supplier"}
        </button>
        <button type="button" className="btn quiet" onClick={onDone}>
          Cancel
        </button>
      </div>
      <ErrorNotice error={start.error} />
    </form>
  );
}
