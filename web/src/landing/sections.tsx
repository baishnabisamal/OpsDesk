import { useId, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { doc, REPO } from "./links";

// The landing page below the film. Nothing here is invented: the screens are
// real screenshots of the running app with its seed data, the quotes are taken
// word for word from docs/adr, and "Run it free" lists real hosting options.

// --- 3. How it works --------------------------------------------------------

export function About() {
  return (
    <section id="how" className="lp-band" aria-labelledby="how-title">
      <div className="lp-wrap">
        <h2 id="how-title" className="lp-label">
          How it works
        </h2>
        <p className="lp-lead">
          A travel agency writes about a hotel booking. OpsDesk works out which booking it is, who
          should answer and how long they have, and keeps that promise when three agencies write
          about the same stay in the same minute.
        </p>
        <div className="lp-columns">
          <p>
            <strong>One booking, one case.</strong> Every ticket names a booking by its TBOH
            reference. Tickets about the same booking join one case, so a cancellation raised by
            three agencies is answered once, by one agent, with the whole history in view. Keyword
            rules read the intent first and a small model second; if the model is slow or down, the
            ticket is still created and marked for a person to check.
          </p>
          <p>
            <strong>A deadline that follows the trip.</strong> The response target starts from the
            priority and the business hours of the booking&rsquo;s region, then moves earlier when
            the free-cancellation date or check-in would come first. Routing only considers agents
            who are online, on shift and under their limit, and stores the reason for each choice.
            Every change is saved with its timeline entry and its event in one transaction, so live
            screens and emails never disagree with the database.
          </p>
        </div>
      </div>
    </section>
  );
}

// --- 4. Screens -------------------------------------------------------------

const SCREENS = [
  { file: "queue", title: "Triage queue", note: "Soonest deadline first, overdue in red" },
  { file: "ticket", title: "A ticket", note: "Conversation, internal notes, SLA, same booking" },
  { file: "case", title: "A case", note: "Every ticket on one booking, together" },
  { file: "insights", title: "Insights", note: "Weekly intent counts and CSV export" },
  { file: "team", title: "Team", note: "People, today’s load and invitations" },
  { file: "agency", title: "An agency’s view", note: "Only its own tickets, by the database" },
];

export function Screens() {
  return (
    <section id="screens" className="lp-band" aria-labelledby="screens-title">
      <div className="lp-wrap">
        <div className="lp-head-row">
          <h2 id="screens-title">The screens</h2>
          <p>Screenshots of the running app with its demo data. Dark mode swaps them.</p>
        </div>
        <ul className="lp-screens">
          {SCREENS.map((s) => (
            <li key={s.file}>
              <figure>
                <picture>
                  <source
                    srcSet={`/landing/${s.file}-dark.jpg`}
                    media="(prefers-color-scheme: dark)"
                  />
                  <img
                    src={`/landing/${s.file}-light.jpg`}
                    width={1040}
                    height={650}
                    loading="lazy"
                    decoding="async"
                    alt={`OpsDesk ${s.title.toLowerCase()} screen: ${s.note.toLowerCase()}.`}
                  />
                </picture>
                <figcaption>
                  <strong>{s.title}</strong>
                  <span>{s.note}</span>
                </figcaption>
              </figure>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// --- 5. Run it free (the "plans") ------------------------------------------

const PLANS = [
  {
    name: "Your laptop",
    sub: "To read the code and try every flow",
    price: "Free",
    points: [
      "Docker Compose for Postgres, Redis, Mailpit",
      "Seed data and demo accounts",
      "Email caught locally",
    ],
    action: "Setup in the README",
    href: doc("README.md"),
  },
  {
    name: "Oracle Cloud Always Free",
    sub: "A public demo that stays up",
    price: "Free",
    points: [
      "4 ARM cores, 24 GB memory",
      "HTTPS by Caddy, on a free sslip.io name",
      "Daily database backups",
    ],
    action: "Follow the deploy guide",
    href: doc("docs/deploy.md"),
    pick: true,
  },
  {
    name: "GitHub Student Pack",
    sub: "Your own domain for a year",
    price: "Free, 1 year",
    points: ["$200 DigitalOcean credit", "A free .me or .tech domain", "Same deploy scripts"],
    action: "Follow the deploy guide",
    href: doc("docs/deploy.md"),
  },
  {
    name: "Your own server",
    sub: "Any 2 vCPU, 4 GB Linux machine",
    price: "About €5 a month",
    points: ["Your domain and mail provider", "Updates with one script", "Same deploy scripts"],
    action: "Follow the deploy guide",
    href: doc("docs/deploy.md"),
  },
];

function Check() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="lp-check">
      <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

export function RunItFree() {
  return (
    <section id="run" className="lp-band" aria-labelledby="run-title">
      <div className="lp-wrap">
        <div className="lp-head-row">
          <h2 id="run-title">Run it free</h2>
          <p>Every option runs the same code with the same scripts. Three of them cost nothing.</p>
        </div>
        <ol className="lp-plans">
          {PLANS.map((plan) => (
            <li key={plan.name} className={plan.pick ? "pick" : undefined}>
              <div className="lp-plan-name">
                <h3>{plan.name}</h3>
                <p>{plan.sub}</p>
                {plan.pick ? <span className="lp-tag">What the demo uses</span> : null}
              </div>
              <p className="lp-plan-price">{plan.price}</p>
              <ul className="lp-plan-points">
                {plan.points.map((point) => (
                  <li key={point}>
                    <Check />
                    {point}
                  </li>
                ))}
              </ul>
              <a
                href={plan.href}
                className={plan.pick ? "lp-btn primary small" : "lp-btn small"}
                aria-label={`${plan.action}: ${plan.name}`}
              >
                {plan.action}
              </a>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// --- 6. From the design records (in place of testimonials) ------------------

const RECORDS = [
  {
    n: "02",
    title: "Row-Level Security isolates agencies",
    quote: (
      <>
        A forgotten <code>WHERE agency_id = ...</code> cannot leak data: the database adds it.
      </>
    ),
    file: "docs/adr/0002-postgres-rls-isolation.md",
  },
  {
    n: "05",
    title: "Optimistic locking with version and If-Match",
    quote: "No locks are held while a person thinks; conflicts are rare and cheap.",
    file: "docs/adr/0005-optimistic-locking.md",
  },
  {
    n: "06",
    title: "ML as a separate service that may fail",
    quote: "Creation never waits long on the model.",
    file: "docs/adr/0006-ml-service-with-fallback.md",
  },
];

export function Records() {
  return (
    <section className="lp-band" aria-labelledby="records-title">
      <div className="lp-wrap">
        <div className="lp-head-row">
          <h2 id="records-title">From the design records</h2>
          <p>
            No customers to quote yet, so these come from the project&rsquo;s own decision records,
            word for word.
          </p>
        </div>
        <ul className="lp-records">
          {RECORDS.map((record) => (
            <li key={record.n}>
              <div className="lp-record-who">
                <span className="lp-record-n" aria-hidden="true">
                  {record.n}
                </span>
                <div>
                  <strong>Decision record {record.n}</strong>
                  <span>{record.title}</span>
                </div>
              </div>
              <figure>
                <blockquote>
                  <p>{record.quote}</p>
                </blockquote>
                <figcaption>
                  <a href={doc(record.file)}>Read record {record.n}</a>
                </figcaption>
              </figure>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// --- 7. Contact ---------------------------------------------------------------

type Errors = Partial<Record<"name" | "email" | "message", string>>;

function validate(form: { name: string; email: string; message: string }): Errors {
  const errors: Errors = {};
  if (!form.name.trim()) errors.name = "Write your name.";
  if (!form.email.trim()) errors.email = "Write your email address.";
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()))
    errors.email = "That email address looks incomplete.";
  if (form.message.trim().length < 10) errors.message = "Write at least a sentence.";
  return errors;
}

// No backend and no cost: "Send" opens a GitHub issue with the message filled
// in. GitHub issues are public, so the email address goes in only if asked.
export function issueUrl(
  form: { name: string; email: string; message: string },
  withEmail: boolean,
) {
  const from = withEmail ? `${form.name.trim()} <${form.email.trim()}>` : form.name.trim();
  const body = `${form.message.trim()}\n\n— ${from}`;
  const title = `Message from ${form.name.trim()}`;
  return `${REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

const CHANNELS = [
  {
    title: "Issues on GitHub",
    note: "Questions, bugs and ideas, in public",
    href: `${REPO}/issues`,
    icon: <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM8 5v3.5M8 10.6v.4" />,
  },
  {
    title: "The demo script",
    note: "Ten minutes, click by click",
    href: doc("docs/demo.md"),
    icon: <path d="M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3M5.5 8h5M5.5 10.5h5" />,
  },
  {
    title: "The live demo",
    note: "Sign in with a demo account",
    href: "/login",
    icon: <path d="M4.5 2.5v11l9-5.5z" />,
  },
];

export function Contact() {
  const id = useId();
  const [form, setForm] = useState({ name: "", email: "", message: "" });
  const [withEmail, setWithEmail] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [sent, setSent] = useState(false);

  const field = (key: "name" | "email" | "message") => ({
    id: `${id}-${key}`,
    value: form[key],
    "aria-invalid": errors[key] ? true : undefined,
    "aria-describedby": errors[key] ? `${id}-${key}-error` : undefined,
    onChange: (event: { target: { value: string } }) => {
      setForm((f) => ({ ...f, [key]: event.target.value }));
      if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
      setSent(false);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const found = validate(form);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      const first = (["name", "email", "message"] as const).find((k) => found[k]);
      document.getElementById(`${id}-${first}`)?.focus();
      return;
    }
    window.open(issueUrl(form, withEmail), "_blank", "noopener");
    setSent(true);
  }

  const error = (key: "name" | "email" | "message") =>
    errors[key] ? (
      <span id={`${id}-${key}-error`} className="lp-field-error">
        {errors[key]}
      </span>
    ) : null;

  return (
    <section id="contact" className="lp-band" aria-labelledby="contact-title">
      <div className="lp-wrap">
        <div className="lp-contact">
          <div className="lp-contact-intro">
            <h2 id="contact-title">Talk about the project</h2>
            <p className="lp-contact-line">Open source, built in the open on GitHub.</p>
            <p>
              Questions about a design decision, a bug you found in the demo, or an idea for the
              next step: write it here and it becomes an issue anyone can follow.
            </p>
          </div>

          <form className="lp-form" onSubmit={submit} noValidate>
            <label className="lp-field" htmlFor={`${id}-name`}>
              <span>Name</span>
              <input {...field("name")} autoComplete="name" placeholder="Your name" />
              {error("name")}
            </label>
            <label className="lp-field" htmlFor={`${id}-email`}>
              <span>Email</span>
              <input
                {...field("email")}
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
              />
              {error("email")}
            </label>
            <label className="lp-field lp-field-wide" htmlFor={`${id}-message`}>
              <span>Message</span>
              <textarea {...field("message")} rows={5} placeholder="What would you like to ask?" />
              {error("message")}
            </label>
            <label className="lp-check-row lp-field-wide">
              <input
                type="checkbox"
                checked={withEmail}
                onChange={(event) => setWithEmail(event.target.checked)}
              />
              <span>Put my email in the issue too (issues are public)</span>
            </label>
            <div className="lp-form-foot lp-field-wide">
              <button type="submit" className="lp-btn primary">
                Send
              </button>
              <p role="status">
                {sent
                  ? "GitHub opened in a new tab with your message. Submit it there."
                  : "Opens a GitHub issue with your message filled in. Nothing is sent before you submit it there."}
              </p>
            </div>
          </form>
        </div>

        <ul className="lp-channels">
          {CHANNELS.map((c) => (
            <li key={c.title}>
              <span className="lp-channel-icon" aria-hidden="true">
                <svg viewBox="0 0 16 16">{c.icon}</svg>
              </span>
              {c.href.startsWith("/") ? (
                <Link to={c.href}>{c.title}</Link>
              ) : (
                <a href={c.href}>{c.title}</a>
              )}
              <span>{c.note}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// --- 8. Footer ----------------------------------------------------------------

const FOOTER = [
  {
    title: "Product",
    links: [
      ["How it works", "#how"],
      ["The screens", "#screens"],
      ["Try the demo", "/login"],
      ["Create an agency account", "/signup"],
    ],
  },
  {
    title: "Engineering",
    links: [
      ["Design document", doc("README.md")],
      ["Decision records", `${REPO}/tree/main/docs/adr`],
      ["Load test results", doc("docs/load-test.md")],
      ["API description", "/openapi.json"],
    ],
  },
  {
    title: "Run it",
    links: [
      ["Run it free", "#run"],
      ["Deploy guide", doc("docs/deploy.md")],
      ["Continuous integration", `${REPO}/actions`],
    ],
  },
];

function FooterLink({ label, href }: { label: string; href: string }) {
  if (href.startsWith("/") && href !== "/openapi.json") return <Link to={href}>{label}</Link>;
  return <a href={href}>{label}</a>;
}

export function Footer() {
  return (
    <footer className="lp-footer">
      <div className="lp-wrap">
        <nav className="lp-footer-cols" aria-label="Footer">
          {FOOTER.map((group) => (
            <div key={group.title}>
              <h2>{group.title}</h2>
              <ul>
                {group.links.map(([label, href]) => (
                  <li key={label}>
                    <FooterLink label={label!} href={href!} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <p className="lp-wordmark" aria-hidden="true">
          OpsDesk
          <i />
        </p>
        <div className="lp-footer-bar">
          <p>© 2026 OpsDesk</p>
          <p>
            A portfolio project. The demo data and the intent model&rsquo;s training data are
            synthetic.
          </p>
          <a href={REPO} className="lp-social" aria-label="OpsDesk on GitHub">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 .2a8 8 0 0 0-2.5 15.6c.4 0 .5-.2.5-.4v-1.5c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.3 1.9.9 2.3.7.1-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.4 7.4 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.4 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.1 0 3.1-1.9 3.8-3.6 4 .3.3.6.8.6 1.5v2.2c0 .2.1.5.6.4A8 8 0 0 0 8 .2z" />
            </svg>
            GitHub
          </a>
        </div>
      </div>
    </footer>
  );
}
