
const { escalationManagerMongoFilter } = require("../utils/accessRules");

function scopeTicketQuery(req, res, next) {
    const { role, agencyId, id: userId } = req.user;

    const validRoles = [
        "requester",
        "agent",
        "escalation_manager",
        "lead"
    ];

    if (!validRoles.includes(role)) {
        return res.status(403).json({ error: "Access denied" });
    }

    req.ticketFilter = {};

    if (role === "requester") {
        if (!agencyId) {
            return res.status(403).json({
                error: "Requester is not associated with an agency"
            });
        }

        req.ticketFilter.agencyId = agencyId;
    }

    if (role === "escalation_manager") {
        Object.assign(
            req.ticketFilter,
            escalationManagerMongoFilter(userId)
        );
    }

    // Agents and leads can see all tickets.

    next();
}

module.exports = { scopeTicketQuery };
