
const express = require("express");
const router = express.Router();

const { authenticate } = require("../middleware/auth");
const { scopeTicketQuery } = require("../middleware/scopeTickets");
const Ticket = require("../models/Ticket");

// GET /api/tickets
router.get("/", authenticate, scopeTicketQuery, async (req, res) => {
    try {
        // Accept only approved filters from the frontend
        const allowedFilters = [
            "status",
            "priority",
            "intent",
            "region"
        ];

        const frontendFilters = {};

        for (const key of allowedFilters) {
            if (req.query[key]) {
                frontendFilters[key] = req.query[key];
            }
        }

        // Server-side restrictions take priority
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

module.exports = router;
