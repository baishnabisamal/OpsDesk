import { Link, Navigate, Route, Routes } from "react-router";
import { useUser } from "./auth";
import { Empty } from "./components/bits";
import { Layout } from "./components/Layout";
import { FilmCapture } from "./landing/Film";
import { LandingPage } from "./landing/LandingPage";
import { isStaff } from "./lib/rules";
import {
  AcceptInvitePage,
  ForgotPasswordPage,
  ResetPasswordPage,
  SignupPage,
  VerifyEmailPage,
} from "./pages/AccountPages";
import { CasePage } from "./pages/CasePage";
import { InsightsPage } from "./pages/InsightsPage";
import { LoginPage } from "./pages/LoginPage";
import { NewTicketPage } from "./pages/NewTicketPage";
import { QueuePage } from "./pages/QueuePage";
import { TeamPage } from "./pages/TeamPage";
import { TicketPage } from "./pages/TicketPage";
import { TicketsPage } from "./pages/TicketsPage";

// Which screens exist for whom. Hiding a route is for convenience only:
// the API refuses anything the role may not do (403) or see (404).
export function App() {
  const user = useUser();
  if (!user) {
    // Signed out: the landing page at "/", the account pages, and the login
    // page for any other address (so an old link still lands somewhere useful).
    return (
      <Routes>
        <Route index element={<LandingPage />} />
        <Route path="login" element={<LoginPage />} />
        <Route path="film" element={<FilmCapture />} />
        <Route path="signup" element={<SignupPage />} />
        <Route path="forgot-password" element={<ForgotPasswordPage />} />
        <Route path="verify-email" element={<VerifyEmailPage />} />
        <Route path="reset-password" element={<ResetPasswordPage />} />
        <Route path="accept-invite" element={<AcceptInvitePage />} />
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  const staff = isStaff(user.role);
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to={staff ? "/queues/mine" : "/tickets"} replace />} />
        <Route path="tickets" element={<TicketsPage />} />
        <Route path="tickets/:id" element={<TicketPage />} />
        <Route path="cases/:id" element={<CasePage />} />
        {staff ? <Route path="queues/:name" element={<QueuePage />} /> : null}
        {!staff ? <Route path="new" element={<NewTicketPage />} /> : null}
        {user.role === "lead" ? <Route path="insights" element={<InsightsPage />} /> : null}
        {user.role === "lead" ? <Route path="team" element={<TeamPage />} /> : null}
        <Route
          path="*"
          element={
            <Empty title="Nothing at this address">
              <Link to="/">Go to the start</Link>
            </Empty>
          }
        />
      </Route>
    </Routes>
  );
}
