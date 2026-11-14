
const { canEscalationManagerAccess } = require("../utils/accessRules");
const Ticket = require("../models/Ticket");
const Activity = require("../models/Activity");
const Agency = require("../models/Agency");
const mongoose = require("mongoose");
const { syncAgentWorkload } = require("../utils/workload");
// Validate MongoDB ObjectId
function isValidObjectId(id) {
    return mongoose.Types.ObjectId.isValid(id);
}


// ============================================
// HELPER: CALCULATE SLA
// ============================================

function calculateSLA(ticket) {
    const now = new Date();
    const createdAt = ticket.createdAt || now;

    const baseSLAHours = {
        low: 24,
        medium: 4,
        high: 1,
        urgent: 0.5
    };

    let slaHours = baseSLAHours[ticket.priority] || 4;

    const hoursUntilLCD = ticket.LCD
        ? (new Date(ticket.LCD) - now) / (1000 * 60 * 60)
        : Infinity;

    const hoursUntilCheckIn = ticket.checkInDate
        ? (new Date(ticket.checkInDate) - now) / (1000 * 60 * 60)
        : Infinity;

    // Consider only upcoming travel deadlines
    const upcomingDeadlines = [
        hoursUntilLCD,
        hoursUntilCheckIn
    ].filter(hours => hours >= 0);

    const nearestDeadline = upcomingDeadlines.length
        ? Math.min(...upcomingDeadlines)
        : Infinity;

    if (nearestDeadline <= 6) {
        slaHours = Math.min(slaHours, 0.5);
    } else if (nearestDeadline <= 24) {
        slaHours = Math.min(slaHours, 2);
    }

    const slaDueAt = new Date(
        createdAt.getTime() + slaHours * 60 * 60 * 1000
    );

    const isUnresolved = !["resolved", "closed"].includes(ticket.status);

    let status = "on_track";

    if (!isUnresolved) {
        status = "on_track";
    } else if (
        ticket.LCD &&
        now > new Date(ticket.LCD)
    ) {
        status = "breached";
    } else if (now > slaDueAt) {
        status = "breached";
    } else if (
        now > new Date(
            slaDueAt.getTime() - slaHours * 0.2 * 60 * 60 * 1000
        )
    ) {
        status = "at_risk";
    }

    return { slaDueAt, status };
}


// ============================================
// HELPER: FIND AND LINK RELATED TICKETS
// ============================================

async function findAndLinkTickets(newTicket) {
    const linksToAdd = [];

    // Tier 1: Same TBOH
    if (newTicket.TBOH) {
        const sameTBOH = await Ticket.find({
            TBOH: newTicket.TBOH,
            _id: { $ne: newTicket._id }
        });

        for (const ticket of sameTBOH) {
            linksToAdd.push({
                ticketId: ticket._id,
                linkReason: "same_TBOH"
            });
        }
    }

    // Tier 2: Same agency and same intent
    const alreadyLinkedIds = linksToAdd.map(
        link => link.ticketId
    );

    const sameAgencyIntent = await Ticket.find({
        agencyId: newTicket.agencyId,
        intent: newTicket.intent,
        _id: {
            $ne: newTicket._id,
            $nin: alreadyLinkedIds
        }
    });

    for (const ticket of sameAgencyIntent) {
        linksToAdd.push({
            ticketId: ticket._id,
            linkReason: "same_agency_intent"
        });
    }

    if (linksToAdd.length === 0) {
        return [];
    }

    // Save links on the new ticket
    newTicket.linkedTickets = linksToAdd;
    await newTicket.save();

    // Save reverse links on existing tickets
    for (const link of linksToAdd) {
        await Ticket.findByIdAndUpdate(
            link.ticketId,
            {
                $push: {
                    linkedTickets: {
                        ticketId: newTicket._id,
                        linkReason: link.linkReason
                    }
                }
            }
        );
    }

    return linksToAdd;
}


// ============================================
// CREATE TICKET
// POST /api/tickets
// ============================================

async function createTicket(req, res) {
    try {
        const {
            title,
            description,
            agencyId,
            TBOH,
            priority,
            intent,
            category,
            checkInDate,
            LCD,
            region
        } = req.body;

        // Required field validation
        if (
            typeof title !== "string" ||
            !title.trim() ||
            typeof description !== "string" ||
            !description.trim() ||
            typeof region !== "string" ||
            !region.trim()
        ) {
            return res.status(400).json({
                error: "title, description and region are required"
            });
        }

        // Resolve agency ID based on role
        let resolvedAgencyId = agencyId;

        if (req.user.role === "requester") {
            resolvedAgencyId = req.user.agencyId;
        }

        if (!resolvedAgencyId) {
            return res.status(400).json({
                error: "agencyId is required"
            });
        }

        if (!isValidObjectId(resolvedAgencyId)) {
            return res.status(400).json({
                error: "agencyId is not a valid ID"
            });
        }

        // Check whether agency exists
        const agencyExists = await Agency.findById(resolvedAgencyId);

        if (!agencyExists) {
            return res.status(404).json({
                error: "Agency not found"
            });
        }

        // Validate enum values
        const validPriorities = [
            "low", "medium", "high", "urgent"
        ];

        const validIntents = [
            "refund",
            "booking",
            "cancellation",
            "inventory_sync",
            "special_request",
            "other"
        ];

        const validCategories = [
            "financial",
            "booking_operations",
            "inventory",
            "customer_service",
            "general"
        ];

        if (priority && !validPriorities.includes(priority)) {
            return res.status(400).json({
                error: `priority must be one of: ${validPriorities.join(", ")}`
            });
        }

        if (intent && !validIntents.includes(intent)) {
            return res.status(400).json({
                error: `intent must be one of: ${validIntents.join(", ")}`
            });
        }

        if (category && !validCategories.includes(category)) {
            return res.status(400).json({
                error: `category must be one of: ${validCategories.join(", ")}`
            });
        }

        // Validate dates
        let parsedCheckInDate = null;
        let parsedLCD = null;

        if (checkInDate) {
            parsedCheckInDate = new Date(checkInDate);

            if (isNaN(parsedCheckInDate.getTime())) {
                return res.status(400).json({
                    error: "checkInDate is not a valid date"
                });
            }
        }

        if (LCD) {
            parsedLCD = new Date(LCD);

            if (isNaN(parsedLCD.getTime())) {
                return res.status(400).json({
                    error: "LCD is not a valid date"
                });
            }
        }

        // Create ticket
        const newTicket = await Ticket.create({
            title: title.trim(),
            description: description.trim(),
            agencyId: resolvedAgencyId,
            createdBy: req.user.id,
            TBOH: TBOH ? TBOH.trim() : null,
            priority: priority || "medium",
            intent: intent || "other",
            category: category || "general",
            checkInDate: parsedCheckInDate,
            LCD: parsedLCD,
            region: region.trim(),
            status: "new"
        });

        // Calculate SLA
        const slaInfo = calculateSLA(newTicket);

        newTicket.slaDueAt = slaInfo.slaDueAt;
        newTicket.slaStatus = slaInfo.status;

        await newTicket.save();

        // Find related tickets
        const linkResults = await findAndLinkTickets(newTicket);

        // Log ticket creation
        await Activity.create({
            ticketId: newTicket._id,
            actor: req.user.id,
            action: "created",
            details: `Ticket created by ${req.user.name}`
        });

        // Log linking activity
        if (linkResults.length > 0) {
            await Activity.create({
                ticketId: newTicket._id,
                actor: req.user.id,
                action: "linked",
                details: `Linked to ${linkResults.length} related ticket(s)`
            });
        }

        // Return populated ticket
        const populatedTicket = await Ticket.findById(newTicket._id)
            .populate("agencyId", "agencyName agencyCode region")
            .populate("createdBy", "name email")
            .populate("assignedAgent", "name email")
            .populate("linkedTickets.ticketId", "title status priority intent TBOH");

        res.status(201).json({
            success: true,
            ticket: populatedTicket,
            linkedCount: linkResults.length
        });

    } catch (err) {
        console.error("Create ticket error:", err.message);

        res.status(500).json({
            error: "Failed to create ticket"
        });
    }
}


// ============================================
// GET SINGLE TICKET
// GET /api/tickets/:id
// ============================================

async function getTicketById(req, res) {
    try {
        const { id } = req.params;

        if (!isValidObjectId(id)) {
            return res.status(400).json({
                error: "Invalid ticket ID"
            });
        }

        const ticket = await Ticket.findById(id)
            .populate("agencyId", "agencyName agencyCode region")
            .populate("createdBy", "name email")
            .populate("assignedAgent", "name email")
            .populate("escalationManager", "name email")
            .populate(
                "linkedTickets.ticketId",
                "title status priority intent TBOH"
            );

        if (!ticket) {
            return res.status(404).json({
                error: "Ticket not found"
            });
        }

        // Requester: only their own agency's tickets
        // Defensive check for missing agency reference
        if (req.user.role === "requester") {
            if (!ticket.agencyId || !ticket.agencyId._id) {
                return res.status(500).json({
                    error: "Ticket has no valid agency reference"
                });
            }

            const ticketAgencyId = ticket.agencyId._id.toString();

            if (
                !req.user.agencyId ||
                ticketAgencyId !== req.user.agencyId.toString()
            ) {
                return res.status(403).json({
                    error: "Access denied"
                });
            }
        }

        // Escalation Manager: escalated tickets OR tickets assigned to them
        if (req.user.role === "escalation_manager") {
            if (!canEscalationManagerAccess(ticket, req.user.id)) {
                return res.status(403).json({
                    error: "Access denied"
                });
            }
        }

        // Fetch activity timeline
        const activities = await Activity.find({
            ticketId: id
        })
            .populate("actor", "name role")
            .sort({ createdAt: 1 });

        res.json({
            success: true,
            ticket,
            activities
        });

    } catch (err) {
        console.error("Get ticket by ID error:", err.message);

        res.status(500).json({
            error: "Failed to fetch ticket"
        });
    }
}


// ============================================
// UPDATE TICKET
// PUT /api/tickets/:id
// ============================================

async function updateTicket(req, res) {
    try {
        const { id } = req.params;

        const {
            status,
            priority,
            intent,
            category
        } = req.body;

        if (!isValidObjectId(id)) {
            return res.status(400).json({
                error: "Invalid ticket ID"
            });
        }

        const ticket = await Ticket.findById(id);

        if (!ticket) {
            return res.status(404).json({
                error: "Ticket not found"
            });
        }

        // Requesters cannot update ticket details
        if (req.user.role === "requester") {
            return res.status(403).json({
                error: "Requesters cannot update ticket details"
            });
        }

        // Escalation Manager: escalated tickets OR tickets assigned to them
        if (req.user.role === "escalation_manager") {
            if (!canEscalationManagerAccess(ticket, req.user.id)) {
                return res.status(403).json({
                    error: "Access denied"
                });
            }
        }

        const validStatuses = [
            "new", "open", "pending",
            "escalated", "resolved", "closed"
        ];

        const validPriorities = [
            "low", "medium", "high", "urgent"
        ];

        const validIntents = [
            "refund",
            "booking",
            "cancellation",
            "inventory_sync",
            "special_request",
            "other"
        ];

        const validCategories = [
            "financial",
            "booking_operations",
            "inventory",
            "customer_service",
            "general"
        ];

        const activityLogs = [];

        // Update status
        if (status !== undefined && status !== ticket.status) {
            if (!validStatuses.includes(status)) {
                return res.status(400).json({
                    error: `status must be one of: ${validStatuses.join(", ")}`
                });
            }

            activityLogs.push({
                action: "status_changed",
                details: `Status changed from "${ticket.status}" to "${status}"`
            });

            ticket.status = status;
        }

        // Update priority
        if (priority !== undefined && priority !== ticket.priority) {
            if (!validPriorities.includes(priority)) {
                return res.status(400).json({
                    error: `priority must be one of: ${validPriorities.join(", ")}`
                });
            }

            activityLogs.push({
                action: "priority_changed",
                details: `Priority changed from "${ticket.priority}" to "${priority}"`
            });

            ticket.priority = priority;
        }

        // Update intent
        if (intent !== undefined && intent !== ticket.intent) {
            if (!validIntents.includes(intent)) {
                return res.status(400).json({
                    error: `intent must be one of: ${validIntents.join(", ")}`
                });
            }

            ticket.intent = intent;
        }

        // Update category
        if (category !== undefined && category !== ticket.category) {
            if (!validCategories.includes(category)) {
                return res.status(400).json({
                    error: `category must be one of: ${validCategories.join(", ")}`
                });
            }

            ticket.category = category;
        }

        // Recalculate SLA
        const slaInfo = calculateSLA(ticket);

        ticket.slaDueAt = slaInfo.slaDueAt;
        ticket.slaStatus = slaInfo.status;

        await ticket.save();
        if (ticket.assignedAgent) {
            await syncAgentWorkload(ticket.assignedAgent);
        }
        
        // Save activity logs
        for (const log of activityLogs) {
            await Activity.create({
                ticketId: ticket._id,
                actor: req.user.id,
                action: log.action,
                details: log.details
            });
        }

        // Return updated ticket
        const updatedTicket = await Ticket.findById(id)
            .populate("agencyId", "agencyName agencyCode region")
            .populate("createdBy", "name email")
            .populate("assignedAgent", "name email");

        res.json({
            success: true,
            ticket: updatedTicket
        });

    } catch (err) {
        console.error("Update ticket error:", err.message);

        res.status(500).json({
            error: "Failed to update ticket"
        });
    }
}


// ============================================
// EXPORT FUNCTIONS
// ============================================

module.exports = {
    createTicket,
    getTicketById,
    updateTicket,
    calculateSLA
};
