import { Link } from "react-router";
import { OpsBackdrop } from "../components/OpsBackdrop";
import { Film } from "./Film";
import { About, Contact, Footer, Records, RunItFree, Screens } from "./sections";
import { REPO } from "./links";
import "./landing.css";

// The public front page (signed out, at "/"). Every number on it is measured
// (README, docs/load-test.md); nothing is invented.

export function Mark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="6" fill="currentColor" />
      <path
        d="M9 22V10h5.5a4 4 0 0 1 0 8H9"
        fill="none"
        stroke="var(--lp-ground)"
        strokeWidth="2.6"
        strokeLinecap="square"
      />
      <rect x="18.5" y="19.5" width="4.5" height="4.5" fill="var(--signal)" />
    </svg>
  );
}

function Header() {
  return (
    <header>
      <div className="lp-wrap lp-brandrow">
        <div className="lp-brandrow-left">
          <a href={REPO}>Source on GitHub</a>
          <a href={`${REPO}/blob/main/docs/demo.md`}>Demo script</a>
        </div>
        <Link to="/" className="lp-brand" aria-label="OpsDesk, home">
          <Mark />
          OpsDesk
        </Link>
        <div className="lp-brandrow-right">
          <Link to="/login">Sign in</Link>
          <Link to="/signup" className="lp-btn primary small">
            Create an agency account
          </Link>
        </div>
      </div>
      <nav className="lp-wrap" aria-label="Sections">
        <div className="lp-nav">
          <ul>
            <li>
              <a href="#how">How it works</a>
            </li>
            <li>
              <a href="#screens">Screens</a>
            </li>
            <li>
              <a href="#run">Run it free</a>
            </li>
            <li>
              <a href="#contact">Contact</a>
            </li>
          </ul>
        </div>
      </nav>
    </header>
  );
}

function Hero() {
  return (
    <section aria-labelledby="hero-title">
      <div className="lp-wrap lp-hero-copy">
        <p className="lp-kicker">
          <b aria-hidden="true" />
          Operations desk for hotel bookings
        </p>
        <h1 id="hero-title">
          Every hotel ticket, answered <em>before</em> the deadline.
        </h1>
        <p className="lp-lede">
          Travel agencies raise tickets about bookings. OpsDesk groups them by booking, routes each
          one to an agent who can take it, and runs the clock from check-in and the last free
          cancellation date.
        </p>
        <div className="lp-actions">
          <Link to="/login" className="lp-btn primary">
            Try the live demo
          </Link>
          <a href="#how" className="lp-btn">
            See how it works
          </a>
        </div>
      </div>

      <Film />

      <div className="lp-wrap lp-proof">
        <p className="lp-proof-caption">
          Measured with k6 against 200,000 tickets on one laptop, and with 7,821 generated requests
          from Schemathesis. <a href={`${REPO}/blob/main/docs/load-test.md`}>How it was measured</a>
        </p>
        <dl className="lp-numbers">
          <div>
            <dt>reads, p95</dt>
            <dd>10.9 ms</dd>
          </div>
          <div>
            <dt>ticket create, p95</dt>
            <dd>68.9 ms</dd>
          </div>
          <div>
            <dt>API tests passing</dt>
            <dd>819</dd>
          </div>
          <div>
            <dt>server errors found</dt>
            <dd>0</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

export function LandingPage() {
  return (
    <div className="lp">
      <OpsBackdrop />
      <div className="lp-content">
        <a href="#main" className="lp-skip">
          Skip to content
        </a>
        <Header />
        <main id="main">
          <Hero />
          <About />
          <Screens />
          <RunItFree />
          <Records />
          <Contact />
        </main>
        <Footer />
      </div>
    </div>
  );
}
