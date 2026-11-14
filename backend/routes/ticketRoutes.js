
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

const {
    assignTicket,
    unassignTicket,
    autoAssignTicket,
    escalateTicket
} = require("../controllers/routingController");

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
            .sort({ createdAt: -1 })
            .populate("escalationManager", "name email");

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


// GET /api/tickets/queue/unassigned
router.get(
    "/queue/unassigned",
    authenticate,
    roleCheck(["agent", "lead"]),
    async (req, res) => {
        try {
            const tickets = await Ticket.find({
                assignedAgent: null,
                status: { $in: ["new", "open", "pending"] }
            })
                .populate("agencyId", "agencyName agencyCode region")
                .populate("createdBy", "name email")
                .sort({ createdAt: 1 });

            res.json({
                success: true,
                count: tickets.length,
                tickets
            });

        } catch (err) {
            console.error("Unassigned queue error:", err.message);

            res.status(500).json({
                error: "Failed to fetch unassigned tickets"
            });
        }
    }
);


// GET /api/tickets/queue/my-tickets
router.get(
    "/queue/my-tickets",
    authenticate,
    roleCheck(["agent", "lead", "escalation_manager"]),
    async (req, res) => {
        try {
            const tickets = await Ticket.find({
                assignedAgent: req.user.id
            })
                .populate("agencyId", "agencyName agencyCode region")
                .populate("assignedAgent", "name email")
                .populate("escalationManager", "name email")
                .sort({ createdAt: -1 });

            res.json({
                success: true,
                count: tickets.length,
                tickets
            });

        } catch (err) {
            console.error("My tickets queue error:", err.message);

            res.status(500).json({
                error: "Failed to fetch assigned tickets"
            });
        }
    }
);


// GET /api/tickets/queue/escalated
router.get(
    "/queue/escalated",
    authenticate,
    roleCheck(["escalation_manager"]),
    async (req, res) => {
        try {
            const tickets = await Ticket.find({
                escalationManager: req.user.id,
                status: "escalated"
            })
                .populate("agencyId", "agencyName agencyCode region")
                .populate("assignedAgent", "name email")
                .populate("escalationManager", "name email")
                .sort({ createdAt: -1 });

            res.json({
                success: true,
                count: tickets.length,
                tickets
            });

        } catch (err) {
            console.error("Escalated queue error:", err.message);

            res.status(500).json({
                error: "Failed to fetch escalated tickets"
            });
        }
    }
);


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

// POST /api/tickets/:id/assign
router.post(
    "/:id/assign",
    authenticate,
    roleCheck(["agent", "lead"]),
    assignTicket
);

// POST /api/tickets/:id/unassign
router.post(
    "/:id/unassign",
    authenticate,
    roleCheck(["agent", "lead"]),
    unassignTicket
);

// POST /api/tickets/:id/auto-assign
router.post(
    "/:id/auto-assign",
    authenticate,
    roleCheck(["agent", "lead"]),
    autoAssignTicket
);

// POST /api/tickets/:id/escalate
router.post(
    "/:id/escalate",
    authenticate,
    roleCheck(["agent", "lead"]),
    escalateTicket
);
module.exports = router;
