
const Ticket = require("../models/Ticket");
const User = require("../models/User");
const Activity = require("../models/Activity");
const { syncAgentWorkload } = require("../utils/workload");

// Assign or reassign a ticket to an agent
const assignTicket = async (req, res) => {
    try {
        const { agentId } = req.body;
        const { id: ticketId } = req.params;

        if (!agentId) {
            return res.status(400).json({
                error: "Agent ID is required"
            });
        }

        const ticket = await Ticket.findById(ticketId);

        if (!ticket) {
            return res.status(404).json({
                error: "Ticket not found"
            });
        }

        const agent = await User.findOne({
            _id: agentId,
            role: "agent",
            isActive: true
        });

        if (!agent) {
            return res.status(404).json({
                error: "Active agent not found"
            });
        }

        const previousAgent = ticket.assignedAgent;

        if (previousAgent && previousAgent.toString() === agentId) {
            return res.status(400).json({
                error: "Ticket is already assigned to this agent"
            });
        }

        let previousAgentName = null;

        if (previousAgent) {
            const previousAgentUser = await User.findById(previousAgent)
                .select("name");

            previousAgentName = previousAgentUser
                ? previousAgentUser.name
                : "Previous agent";
        }

        ticket.assignedAgent = agentId;
        await ticket.save();

        await syncAgentWorkload(agentId);

        if (previousAgent) {
            await syncAgentWorkload(previousAgent);
        }

        await Activity.create({
            ticketId: ticket._id,
            actor: req.user.id,
            action: previousAgent ? "reassigned" : "assigned",
            details: previousAgent
                ? `Ticket reassigned from ${previousAgentName} to ${agent.name}`
                : `Ticket assigned to ${agent.name}`
        });

        res.json({
            success: true,
            message: previousAgent
                ? "Ticket reassigned successfully"
                : "Ticket assigned successfully",
            ticket
        });

    } catch (err) {
        console.error("Assign ticket error:", err.message);

        res.status(500).json({
            error: "Failed to assign ticket"
        });
    }
};


// Unassign a ticket
const unassignTicket = async (req, res) => {
    try {
        const { id: ticketId } = req.params;

        const ticket = await Ticket.findById(ticketId);

        if (!ticket) {
            return res.status(404).json({
                error: "Ticket not found"
            });
        }

        if (!ticket.assignedAgent) {
            return res.status(400).json({
                error: "Ticket is not currently assigned"
            });
        }

        const previousAgent = ticket.assignedAgent;

        ticket.assignedAgent = null;
        await ticket.save();

        await syncAgentWorkload(previousAgent);

        await Activity.create({
            ticketId: ticket._id,
            actor: req.user.id,
            action: "unassigned",
            details: "Ticket unassigned"
        });

        res.json({
            success: true,
            message: "Ticket unassigned successfully",
            ticket
        });

    } catch (err) {
        console.error("Unassign ticket error:", err.message);

        res.status(500).json({
            error: "Failed to unassign ticket"
        });
    }
};


// Automatically assign a ticket to the best available agent
const autoAssignTicket = async (req, res) => {
    try {
        const { id: ticketId } = req.params;

        const ticket = await Ticket.findById(ticketId);

        if (!ticket) {
            return res.status(404).json({
                error: "Ticket not found"
            });
        }

        if (ticket.assignedAgent) {
            return res.status(400).json({
                error: "Ticket is already assigned"
            });
        }

        // Find active agents who are not offline
        const agents = await User.find({
            role: "agent",
            isActive: true,
            availability: { $in: ["available", "busy"] }
        });

        if (agents.length === 0) {
            return res.status(404).json({
                error: "No available agents found"
            });
        }

        // Refresh workload counts before comparing agents
        for (const agent of agents) {
            agent.currentTickets = await syncAgentWorkload(agent._id);
        }

        // Priority weights
        const availabilityWeight = {
            urgent: 100,
            high: 75,
            medium: 50,
            low: 25
        };

        // Prefer matching region, available agents and lower workload
        agents.sort((a, b) => {
            const aRegion = a.region === ticket.region ? 1 : 0;
            const bRegion = b.region === ticket.region ? 1 : 0;

            const aAvailable = a.availability === "available" ? 1 : 0;
            const bAvailable = b.availability === "available" ? 1 : 0;

            const aScore =
                aRegion * 100 +
                aAvailable * availabilityWeight[ticket.priority] -
                a.currentTickets;

            const bScore =
                bRegion * 100 +
                bAvailable * availabilityWeight[ticket.priority] -
                b.currentTickets;

            return bScore - aScore;
        });

        const selectedAgent = agents[0];

        const regionMatched = selectedAgent.region === ticket.region;
        const wasAvailable = selectedAgent.availability === "available";
        const workload = selectedAgent.currentTickets;

        ticket.assignedAgent = selectedAgent._id;

        ticket.routingReason = {
            region: regionMatched,
            priority: true,
            availability: wasAvailable,
            agentWorkloadAtAssignment: workload,
            note: `Automatically assigned to ${selectedAgent.name} based on region, availability, priority (${ticket.priority}), and workload (${workload} tickets).`
        };

        await ticket.save();

        // Refresh the selected agent's workload after assignment
        const updatedWorkload = await syncAgentWorkload(selectedAgent._id);

        await Activity.create({
            ticketId: ticket._id,
            actor: req.user.id,
            action: "assigned",
            details: `Automatically assigned to ${selectedAgent.name}`
        });

        res.json({
            success: true,
            message: "Ticket automatically assigned successfully",
            agent: {
                id: selectedAgent._id,
                name: selectedAgent.name,
                region: selectedAgent.region,
                availability: selectedAgent.availability,
                currentTickets: updatedWorkload
            },
            routingReason: ticket.routingReason,
            ticket
        });

    } catch (err) {
        console.error("Auto assign ticket error:", err.message);

        res.status(500).json({
            error: "Failed to automatically assign ticket"
        });
    }
};

// Escalate a ticket to an escalation manager
const escalateTicket = async (req, res) => {
    try {
        const { id: ticketId } = req.params;

        const ticket = await Ticket.findById(ticketId);

        if (!ticket) {
            return res.status(404).json({
                error: "Ticket not found"
            });
        }

        if (ticket.status === "escalated") {
            return res.status(400).json({
                error: "Ticket is already escalated"
            });
        }

        if (["resolved", "closed"].includes(ticket.status)) {
            return res.status(400).json({
                error: "Resolved or closed tickets cannot be escalated"
            });
        }

        // Find an active escalation manager in the ticket's region
        const manager = await User.findOne({
            role: "escalation_manager",
            isActive: true,
            region: ticket.region
        });

        if (!manager) {
            return res.status(404).json({
                error: "No active escalation manager found for this region"
            });
        }

        ticket.status = "escalated";
        ticket.escalationManager = manager._id;

        await ticket.save();

        // Refresh the assigned agent's workload
        if (ticket.assignedAgent) {
            await syncAgentWorkload(ticket.assignedAgent);
        }

        await Activity.create({
            ticketId: ticket._id,
            actor: req.user.id,
            action: "escalated",
            details: `Ticket escalated to ${manager.name}`
        });

        res.json({
            success: true,
            message: "Ticket escalated successfully",
            manager: {
                id: manager._id,
                name: manager.name,
                email: manager.email
            },
            ticket
        });

    } catch (err) {
        console.error("Escalate ticket error:", err.message);

        res.status(500).json({
            error: "Failed to escalate ticket"
        });
    }
};

module.exports = {
    assignTicket,
    unassignTicket,
    autoAssignTicket,
    escalateTicket
};
