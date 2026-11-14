
const Ticket = require("../models/Ticket");
const User = require("../models/User");

async function syncAgentWorkload(agentId) {
    const currentTickets = await Ticket.countDocuments({
        assignedAgent: agentId,
        status: {
            $in: ["new", "open", "pending", "escalated"]
        }
    });

    await User.findByIdAndUpdate(agentId, {
        currentTickets
    });

    return currentTickets;
}

module.exports = { syncAgentWorkload };
