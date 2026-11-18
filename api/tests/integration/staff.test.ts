import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import {
  bearer,
  closeTestPools,
  createAgencyWithRequester,
  createRoutableAgent,
  createTeam,
  createUser,
  ownerPool,
} from "./helpers.js";

const app = createApp();

afterAll(closeTestPools);

describe("GET /staff", () => {
  it("lists staff with their team, region and load, and no requesters", async () => {
    // EU: never online in tests, so this agent cannot take other files' tickets.
    const teamId = await createTeam("EU");
    const agent = await createRoutableAgent(teamId, { online: false, maxOpen: 7 });
    const lead = await createUser("lead", { teamId });
    const { requester } = await createAgencyWithRequester();

    const res = await request(app).get("/api/v1/staff").set(bearer(lead));
    expect(res.status).toBe(200);

    const ids = res.body.items.map((member: { id: string }) => member.id);
    expect(ids).toContain(agent.id);
    expect(ids).toContain(lead.id);
    expect(ids).not.toContain(requester.id);

    const row = res.body.items.find((member: { id: string }) => member.id === agent.id);
    expect(row).toMatchObject({
      role: "agent",
      team_id: teamId,
      region_code: "EU",
      is_online: false,
      open_count: 0,
      max_open: 7,
      invite_pending: false,
    });
    // A lead with no presence row still appears, as offline.
    const leadRow = res.body.items.find((member: { id: string }) => member.id === lead.id);
    expect(leadRow).toMatchObject({ is_online: false, open_count: 0, max_open: null });
  });

  it("leaves out deactivated staff", async () => {
    const lead = await createUser("lead");
    const gone = await createUser("agent");
    await ownerPool.query("UPDATE users SET is_active = false WHERE id = $1", [gone.id]);

    const res = await request(app).get("/api/v1/staff").set(bearer(lead));
    expect(res.body.items.map((member: { id: string }) => member.id)).not.toContain(gone.id);
  });

  it("is staff only: a requester gets 403", async () => {
    const { requester } = await createAgencyWithRequester();
    const res = await request(app).get("/api/v1/staff").set(bearer(requester));
    expect(res.status).toBe(403);
  });

  it("needs a login", async () => {
    const res = await request(app).get("/api/v1/staff");
    expect(res.status).toBe(401);
  });
});
