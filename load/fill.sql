-- Fills the load-test database with a realistic volume of tickets, so the
-- load test measures queries over real-sized tables and indexes, not over
-- the 80 tickets of the demo seed. Run by tools/load.sh as the owner role:
--   psql -v rows=200000 -f load/fill.sql
--
-- 95% are history (closed, spread over the past months), 5% are live and
-- waiting in triage, roughly the mix a support desk has.

\set ON_ERROR_STOP on

BEGIN;

-- One closed case per booking holds that booking's history.
INSERT INTO cases (booking_id, agency_id, status, created_at, closed_at)
SELECT id, agency_id, 'closed', now() - interval '400 days', now() - interval '300 days'
  FROM bookings;

-- Every booking gets an open case for its live tickets, if it has none.
INSERT INTO cases (booking_id, agency_id)
SELECT b.id, b.agency_id FROM bookings b
 WHERE NOT EXISTS (SELECT 1 FROM cases c WHERE c.booking_id = b.id AND c.status = 'open');

CREATE TEMP TABLE fill_bookings AS
SELECT row_number() OVER (ORDER BY b.id) - 1 AS k, b.id, b.agency_id, b.region_code,
       (SELECT u.id FROM users u WHERE u.agency_id = b.agency_id ORDER BY u.email LIMIT 1) AS requester,
       (SELECT c.id FROM cases c WHERE c.booking_id = b.id AND c.status = 'closed' LIMIT 1) AS closed_case,
       (SELECT c.id FROM cases c WHERE c.booking_id = b.id AND c.status = 'open' LIMIT 1) AS open_case
  FROM bookings b;

-- History: closed tickets, one every 2 minutes going back in time.
INSERT INTO tickets (agency_id, booking_id, case_id, requester_id, subject, body, intent,
                     intent_source, priority, check_in_at, lcd_at, region_code, sla_due_at,
                     sla_at_risk_at, status, resolved_at, closed_at, created_at)
SELECT b.agency_id, b.id, b.closed_case, b.requester,
       (ARRAY['Refund not received', 'Please cancel this booking', 'Guest name change',
              'Voucher shows wrong dates', 'Hotel cannot find booking'])[1 + n % 5] || ' #' || n,
       'Load test history ticket number ' || n || '. The guest asked about the stay.',
       (ARRAY['refund', 'cancellation', 'amendment', 'voucher', 'booking_not_found',
              'payment', 'other'])[1 + n % 7],
       'manual',
       (ARRAY['low', 'normal', 'normal', 'high'])[1 + n % 4],
       t.created + interval '30 days', t.created + interval '20 days', b.region_code,
       t.created + interval '2 days', t.created + interval '1 day',
       'closed', t.created + interval '1 day', t.created + interval '2 days', t.created
  FROM generate_series(1, (:rows * 95) / 100) AS n
  CROSS JOIN LATERAL (SELECT now() - make_interval(mins => n * 2) AS created) t
  JOIN fill_bookings b ON b.k = n % (SELECT count(*) FROM fill_bookings);

-- Live: new tickets nobody owns yet, deadlines in the coming days.
INSERT INTO tickets (agency_id, booking_id, case_id, requester_id, subject, body, intent,
                     intent_source, priority, check_in_at, lcd_at, region_code, sla_due_at,
                     sla_at_risk_at, status, created_at)
SELECT b.agency_id, b.id, b.open_case, b.requester,
       'Live load test ticket #' || n, 'Waiting in triage. Ticket number ' || n || '.',
       (ARRAY['refund', 'cancellation', 'amendment', 'voucher', 'booking_not_found',
              'payment', 'other'])[1 + n % 7],
       'manual',
       (ARRAY['low', 'normal', 'high', 'urgent'])[1 + n % 4],
       now() + interval '20 days', now() + interval '10 days', b.region_code,
       now() + make_interval(mins => 60 + n % 5000), now() + make_interval(mins => 30 + n % 5000),
       'new', now() - make_interval(secs => n)
  FROM generate_series(1, (:rows * 5) / 100) AS n
  JOIN fill_bookings b ON b.k = n % (SELECT count(*) FROM fill_bookings);

COMMIT;

-- Fresh statistics, so the planner knows the tables are big now.
ANALYZE tickets;
ANALYZE cases;

SELECT status, count(*) FROM tickets GROUP BY status ORDER BY status;
