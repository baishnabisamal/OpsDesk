import { Link, Navigate, Route, Routes } from "react-router";
import { useUser } from "./auth";
import { Empty } from "./components/bits";
import { Layout } from "./components/Layout";
import { isStaff } from "./lib/rules";
import { CasePage } from "./pages/CasePage";
import { InsightsPage } from "./pages/InsightsPage";
import { LoginPage } from "./pages/LoginPage";
import { NewTicketPage } from "./pages/NewTicketPage";
import { QueuePage } from "./pages/QueuePage";
import { TicketPage } from "./pages/TicketPage";
import { TicketsPage } from "./pages/TicketsPage";

// Which screens exist for whom. Hiding a route is for convenience only:
// the API refuses anything the role may not do (403) or see (404).
export function App() {
  const user = useUser();
  if (!user) return <LoginPage />;

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
