function scopeTicketQuery(req, res, next) {
    const { role, agencyId } = req.user;
    const validRoles = ["requester", "agent", "escalation_manager", "lead"];

    if (!validRoles.includes(role)) {
        return res.status(403).json({ error: "Access denied" });
    }

    req.ticketFilter = {};

    if (role === "requester") {
        if (!agencyId) {
            return res.status(403).json({ error: "Requester is not associated with an agency" });
        }
        req.ticketFilter.agencyId = agencyId;
    }

    if (role === "escalation_manager") {
        req.ticketFilter.status = "escalated";
    }

    // agent and lead → no filter, see everything

    next();
}

module.exports = { scopeTicketQuery };