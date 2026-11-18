import { Link, useParams } from "react-router";
import { useCase, useStaff } from "../api/queries";
import { useRequiredUser } from "../auth";
import { ErrorNotice } from "../components/bits";
import { TicketTable } from "../components/TicketTable";
import { dateOnly, dateTime, shortId } from "../lib/format";
import { isStaff } from "../lib/rules";

// A case: every ticket about one booking (TBOH), so nobody answers the same
// problem three times.
export function CasePage() {
  const { id } = useParams();
  const user = useRequiredUser();
  const caseView = useCase(id);
  const { data: staff } = useStaff(isStaff(user.role));

  if (caseView.isPending) return <p className="muted">Loading</p>;
  if (caseView.error) return <ErrorNotice error={caseView.error} />;
  const { booking, tickets } = caseView.data;

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to={isStaff(user.role) ? "/queues/linked" : "/tickets"}>Cases</Link>
        <span aria-hidden="true">/</span>
        <span className="mono">{shortId(caseView.data.id)}</span>
      </nav>
      <header className="page-head">
        <div>
          <h1>{booking.hotel_name}</h1>
          <p className="sub">
            Booking <span className="mono">{booking.tboh}</span>, {tickets.length} ticket
            {tickets.length === 1 ? "" : "s"}, case {caseView.data.status}.
          </p>
        </div>
      </header>
      <dl className="case-head">
        <div>
          <dt>Check-in</dt>
          <dd>{dateOnly(booking.check_in_date)}</dd>
        </div>
        <div>
          <dt>Free cancellation until</dt>
          <dd>{dateTime(booking.lcd_at)}</dd>
        </div>
        <div>
          <dt>Case opened</dt>
          <dd>{dateTime(caseView.data.created_at)}</dd>
        </div>
      </dl>
      <TicketTable tickets={tickets} staff={staff} showAssignee={isStaff(user.role)} />
    </>
  );
}
