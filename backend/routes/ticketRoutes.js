
const express = require("express");
const router = express.Router();

const { authenticate } = require("../middleware/auth");
const { roleCheck } = require("../middleware/roleCheck");
const { scopeTicketQuery } = require("../middleware/scopeTickets");

const {
    createTicket,
    getTicketById,
    updateTicket
} = require("../controllers/ticketController");

const Ticket = require("../models/Ticket");

// GET /api/tickets — List tickets
router.get("/", authenticate, scopeTicketQuery, async (req, res) => {
    try {
        const allowedFilters = [
            "status",
            "priority",
            "intent",
            "region",
            "category"
        ];

        const frontendFilters = {};

        for (const key of allowedFilters) {
            if (req.query[key]) {
                frontendFilters[key] = req.query[key];
            }
        }

        const finalQuery = {
            ...frontendFilters,
            ...req.ticketFilter
        };

        const tickets = await Ticket.find(finalQuery)
            .populate("agencyId", "agencyName agencyCode region")
            .populate("assignedAgent", "name email")
            .sort({ createdAt: -1 });

        res.json({
            success: true,
            count: tickets.length,
            tickets
        });

    } catch (err) {
        console.error("Get tickets error:", err.message);

        res.status(500).json({
            error: "Failed to fetch tickets"
        });
    }
});

// POST /api/tickets — Create ticket
router.post(
    "/",
    authenticate,
    roleCheck(["requester", "agent", "lead"]),
    createTicket
);

// GET /api/tickets/:id — Get single ticket
router.get("/:id", authenticate, getTicketById);

// PUT /api/tickets/:id — Update ticket
router.put(
    "/:id",
    authenticate,
    roleCheck(["agent", "lead", "escalation_manager"]),
    updateTicket
);

module.exports = router;
