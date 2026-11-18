import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../api/client";
import { keys } from "../api/queries";
import { PRIORITIES, type Priority, type Ticket } from "../api/types";
import { ErrorNotice } from "../components/bits";
import { PRIORITY_LABEL } from "../lib/format";

// Raising a ticket, for agency users.
//
// The Idempotency-Key is made once per filled-in form and reused if the
// request is sent again (double click, flaky Wi-Fi, a retry after a timeout).
// The server then returns the ticket it already created instead of a second
// one. A new key is made only after a success, or when the form changes.
export function NewTicketPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [tboh, setTboh] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState<Priority>("normal");
  const key = useRef(crypto.randomUUID());

  // Different content needs a different key (the server rejects a reused key
  // with a different body as a client bug, 422).
  const edit =
    <T,>(setter: (value: T) => void) =>
    (value: T) => {
      key.current = crypto.randomUUID();
      setter(value);
    };

  const create = useMutation({
    mutationFn: () =>
      api<Ticket>("/api/v1/tickets", {
        method: "POST",
        headers: { "Idempotency-Key": key.current },
        body: { subject, body, priority, ...(tboh.trim() ? { tboh: tboh.trim() } : {}) },
      }),
    onSuccess: (ticket) => {
      client.setQueryData(keys.ticket(ticket.id), ticket);
      void client.invalidateQueries({ queryKey: ["tickets"] });
      key.current = crypto.randomUUID();
      navigate(`/tickets/${ticket.id}`);
    },
  });

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Raise a ticket</h1>
          <p className="sub">
            Tell us what went wrong with the booking. We read the text to sort it, so plain words
            are best. Urgent means a guest is affected today.
          </p>
        </div>
      </header>

      <form
        className="form-page"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <div className="form-row">
          <label className="field">
            <span>Subject</span>
            <input
              className="input"
              required
              maxLength={200}
              value={subject}
              onChange={(event) => edit(setSubject)(event.target.value)}
              placeholder="Guest arrived, hotel has no booking"
            />
          </label>
          <label className="field">
            <span>Booking reference (TBOH)</span>
            <input
              className="input mono"
              maxLength={50}
              value={tboh}
              onChange={(event) => edit(setTboh)(event.target.value)}
              placeholder="TBOH-…"
            />
          </label>
        </div>
        <label className="field">
          <span>What happened</span>
          <textarea
            className="textarea"
            required
            maxLength={10000}
            rows={8}
            value={body}
            onChange={(event) => edit(setBody)(event.target.value)}
            placeholder="If the reference is in the text, you can leave the field above empty."
          />
        </label>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend
            className="field"
            style={{ fontSize: 12, fontWeight: 500, color: "var(--ink-2)", marginBottom: 6 }}
          >
            Priority
          </legend>
          <div className="segmented" role="group" aria-label="Priority">
            {PRIORITIES.map((p) => (
              <button
                type="button"
                key={p}
                aria-pressed={priority === p}
                onClick={() => edit(setPriority)(p)}
              >
                {PRIORITY_LABEL[p]}
              </button>
            ))}
          </div>
        </fieldset>
        <div>
          <button className="btn primary" type="submit" disabled={create.isPending}>
            {create.isPending ? "Sending" : "Send to support"}
          </button>
        </div>
        <ErrorNotice error={create.error} />
      </form>
    </>
  );
}
