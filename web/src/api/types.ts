// Shapes the API returns. They mirror the server's types by hand; the
// source of truth is api/src (and GET /openapi.json).

export type Role = "requester" | "agent" | "escalation_manager" | "lead";
export type TicketStatus = "new" | "open" | "pending" | "escalated" | "resolved" | "closed";
export type Priority = "low" | "normal" | "high" | "urgent";
export type Intent =
  "booking_not_found" | "cancellation" | "amendment" | "refund" | "voucher" | "payment" | "other";
export type SlaState = "ok" | "at_risk" | "breached";
export type Visibility = "public" | "internal";

export const STATUSES: TicketStatus[] = [
  "new",
  "open",
  "pending",
  "escalated",
  "resolved",
  "closed",
];
export const PRIORITIES: Priority[] = ["low", "normal", "high", "urgent"];
export const INTENTS: Intent[] = [
  "booking_not_found",
  "cancellation",
  "amendment",
  "refund",
  "voucher",
  "payment",
  "other",
];
export const REGIONS = ["EU", "MEA", "APAC", "AMER"] as const;

export type User = {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  agency_id: string | null;
  team_id: string | null;
};

export type Session = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: User;
};

// Dates arrive as ISO strings in JSON.
export type Ticket = {
  id: string;
  agency_id: string;
  booking_id: string;
  case_id: string;
  requester_id: string;
  subject: string;
  body: string;
  intent: Intent;
  intent_source: string;
  intent_confidence: number | null;
  needs_review: boolean;
  priority: Priority;
  status: TicketStatus;
  assignee_id: string | null;
  team_id: string | null;
  check_in_at: string;
  lcd_at: string;
  region_code: string;
  sla_due_at: string;
  sla_at_risk_at: string;
  sla_state: SlaState;
  sla_paused_at: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  closed_at: string | null;
  version: number;
};

export type Page<T> = { items: T[]; next_cursor: string | null };

export type Message = {
  id: string;
  ticket_id: string;
  author_id: string;
  author_name: string;
  visibility: Visibility;
  body: string;
  created_at: string;
};

export type TimelineEvent = {
  id: string;
  ticket_id: string;
  actor_id: string | null;
  type: string;
  visibility: Visibility;
  data: Record<string, unknown>;
  created_at: string;
};

export type LinkedTicket = {
  ticket_id: string;
  subject: string;
  status: TicketStatus;
  case_id: string;
  reason: "similar_text" | "manual";
  score: number | null;
  linked_at: string;
};

export type CaseView = {
  id: string;
  status: "open" | "closed";
  created_at: string;
  closed_at: string | null;
  booking: {
    id: string;
    tboh: string;
    hotel_name: string;
    check_in_date: string;
    lcd_at: string;
  };
  tickets: Ticket[];
};

export type SideConversation = {
  id: string;
  ticket_id: string;
  subject: string;
  status: string;
  created_by: string;
  created_at: string;
  participants: { email: string; name: string | null }[];
  messages?: SideMessage[];
};

export type SideMessage = {
  id: string;
  side_conversation_id: string;
  direction: "outbound" | "inbound";
  author_id: string | null;
  from_email: string | null;
  body: string;
  created_at: string;
};

export type StaffMember = {
  id: string;
  full_name: string;
  role: Role;
  team_id: string | null;
  team_name: string | null;
  region_code: string | null;
  is_online: boolean;
  open_count: number;
  max_open: number | null;
};

export type WeeklyThemes = {
  week_start: string;
  ticket_count: number;
  intents: { intent: Intent; count: number; sample_ticket_ids: string[] }[];
  clusters: { label: string; terms: string[]; size: number; sample_ticket_ids: string[] }[] | null;
  computed_at: string;
};

// One event pushed by the realtime gateway.
export type LiveEvent = {
  event_id: string;
  type: string;
  ticket_id: string;
  payload: Record<string, unknown>;
  created_at: string;
};
