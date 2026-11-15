# OpsDesk

A travel-aware operations ticketing system. Travel agencies raise tickets about hotel bookings, and support staff resolve them. Every ticket knows which booking it belongs to, so related contacts are grouped into one case, work is routed to the right agent, and deadlines follow the traveller's check-in date instead of a generic clock.

**Stack:** PostgreSQL, Express, React, Node (PERN), with Redis for queues and a small Python service for machine learning.

**Status:** Phase 0, design. This document is the plan; no application code exists yet. Every number below is a target or an estimate until a later phase replaces it with a measurement.

## Contents

1. [What OpsDesk is](#1-what-opsdesk-is)
2. [Goals and non-goals](#2-goals-and-non-goals)
3. [Requirements](#3-requirements)
4. [Capacity estimate](#4-capacity-estimate)
5. [Architecture](#5-architecture)
6. [Tech stack](#6-tech-stack)
7. [Data model](#7-data-model)
8. [Data integrity rules](#8-data-integrity-rules)
9. [Concurrency hazards](#9-concurrency-hazards)
10. [Key flows](#10-key-flows)
11. [Ticket state machine](#11-ticket-state-machine)
12. [Tenant isolation and security](#12-tenant-isolation-and-security)
13. [API design](#13-api-design)
14. [ML service boundary](#14-ml-service-boundary)
15. [Background work](#15-background-work)
16. [Observability](#16-observability)
17. [Testing strategy](#17-testing-strategy)
18. [Roadmap](#18-roadmap)
19. [Repository layout](#19-repository-layout)
20. [Trade-offs and scaling](#20-trade-offs-and-scaling)

---

## 1. What OpsDesk is

### The problem

A B2B travel platform sells hotel rooms to travel agencies. When something goes wrong (a booking is missing at the hotel, a refund has not arrived, a voucher shows the wrong dates) the agency contacts support. A generic helpdesk handles this badly in four ways:

- **Contacts are scattered.** The same agency emails three times about one booking and three different agents pick the tickets up, each without the others' context.
- **Urgency is wrong.** A ticket about a guest arriving tonight waits behind one about a stay three months away, because both are "normal priority".
- **Routing is manual.** A lead reads each ticket and assigns it by hand, with no record of why.
- **Supplier conversations break.** An agent emails the hotel, the ticket is moved to another team, and the hotel's reply goes nowhere.

### What "travel-aware" means

Each ticket is tied to a booking, identified by its booking reference (**TBOH**). Two dates on that booking drive everything:

| Term | Meaning | Why it matters |
|---|---|---|
| **Check-in** | The day the guest arrives at the hotel | After this, most problems can no longer be fixed |
| **LCD** (Last Cancellation Date) | The last moment the booking can be cancelled without a fee | After this, a mistake costs real money |

OpsDesk uses these to compute deadlines: a ticket must be answered before the booking's own deadline, not just within a fixed number of hours.

### Who uses it

| Role | Who | Can do |
|---|---|---|
| **Requester** | A user at a travel agency | Raise tickets, reply, see only their own agency's tickets and public replies |
| **Agent** | Support staff | Work tickets, write internal notes, talk to suppliers |
| **Escalation manager** | Senior support | Own escalated tickets, de-escalate |
| **Lead** | Team lead | Everything an agent can, plus reassignment, exports and insights |

---

## 2. Goals and non-goals

### Goals

- Treat a ticket as part of a **case**: every related contact on the same booking is visible together.
- **Route** tickets by region, shift, priority and agent load, and record the reason for each decision.
- Compute **SLA deadlines** from real travel urgency, and make escalation an explicit state change.
- Keep **side conversations** with suppliers correct when tickets move between teams.
- Serve **large exports** and near-real-time updates with no row caps.
- Enforce strict **tenant isolation**: an agency never sees another agency's data.
- Keep data **correct under concurrency**: no duplicate tickets, no lost edits, no agent over their limit.

### Non-goals

- Phone, WhatsApp or social intake. Email and a web form are enough.
- Production single sign-on, billing, or serving many separate companies.
- A large language model layer. Machine learning is limited to intent and theme classification.

### Assumptions

- One organisation runs OpsDesk; its customers are many agencies.
- Agent shifts and regional holiday calendars are seeded, not pulled from an HR system.
- OpsDesk issues its own login tokens. A real identity provider would replace this.
- Email is sent to a local mail catcher (Mailpit), so no real message leaves the machine.

---

## 3. Requirements

### Functional

| # | Requirement | Phase |
|---|---|---|
| F1 | Tickets carry agency, TBOH, intent, priority, check-in, LCD and region | 1 |
| F2 | New tickets link automatically to open or recent tickets on the same TBOH, or the same agency and intent | 2 |
| F3 | Intent is suggested on create; agents can override it, and overrides are logged | 2 |
| F4 | Status machine New, Open, Pending, Escalated, Resolved, Closed with guarded transitions | 1 |
| F5 | Every change appends to the ticket's timeline | 1 |
| F6 | Routing by region, shift window, priority and agent load, with a stored reason | 3 |
| F7 | Queue views: triage, my queue, by region, by intent, linked cases, escalations | 3 |
| F8 | Side conversations with explicit recipients that survive a transfer | 4 |
| F9 | Internal notes are never sent or shown to agencies | 1 |
| F10 | SLA deadline from priority, check-in and LCD proximity, and regional holidays | 3 |
| F11 | At-risk and breached flags on queues; automatic escalation on breach | 3 |
| F12 | Escalating to an escalation manager changes owner and queue | 3 |
| F13 | Weekly themes with counts and sample tickets | 5 |
| F14 | Streaming CSV export with no row cap, plus a cursor-paginated API | 5 |
| F15 | Archival of closed tickets after a retention window | 5 |
| F16 | Roles: requester, agent, escalation manager, lead | 1 |

### Non-functional targets

| Property | Target |
|---|---|
| Read latency | p95 under 150 ms at 50 requests per second on a laptop |
| Ticket create (classify, link, route included) | p95 under 300 ms |
| Export | 100,000 rows streamed in under 30 s with flat memory |
| Realtime | A state change reaches connected clients within 2 s |
| Correctness | No duplicate ticket from a retry; no lost update; no agent above their cap; no cross-agency read |
| Durability | A committed change is never lost, and its event is never silently dropped |
| Availability of create | Ticket create keeps working when the ML service, Redis or email is down |

---

## 4. Capacity estimate

Estimating first tells us which problems are real. The design load is **50,000 tickets per day**.

| Quantity | Working | Result |
|---|---|---|
| Average ticket writes | 50,000 / 86,400 s | about 0.6 per second |
| Peak ticket writes | 10 times average | about 6 per second |
| Timeline events | about 8 per ticket | 400,000 per day, about 146 million per year |
| Messages | about 4 per ticket | 200,000 per day, about 73 million per year |
| Tickets | 50,000 per day | about 18 million per year |
| Storage | tickets about 2 KB, messages about 1.5 KB, events about 0.4 KB, indexes included | roughly 200 GB per year before archival |
| Reads | 500 staff with open queues | tens of requests per second |

What this tells us:

- **Throughput is not the hard part.** A single PostgreSQL server handles thousands of simple writes per second. Six per second needs no sharding, no message broker cluster and no microservices.
- **Correctness is the hard part.** With hundreds of people and several background jobs touching the same tickets, the risk is two valid requests arriving at the wrong moment. Most of this design is about that.
- **Growth is in two tables.** Events and messages grow by over 200 million rows a year, so those two are partitioned by month and archived. Tickets stay small enough to index normally.
- **Reads dominate.** Queue views are read far more often than tickets are written, so indexes are designed around the queue queries, and paging never uses `OFFSET`.
