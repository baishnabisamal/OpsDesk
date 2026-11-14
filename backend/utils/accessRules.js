
// Single source of truth for Escalation Manager access

function escalationManagerMongoFilter(userId) {
    return {
        $or: [
            { escalationManager: userId },
            { assignedAgent: userId }
        ]
    };
}

function canEscalationManagerAccess(ticket, userId) {
    const escalationManagerId =
        ticket.escalationManager?._id || ticket.escalationManager;

    const assignedAgentId =
        ticket.assignedAgent?._id || ticket.assignedAgent;

    const isAssignedAsManager =
        escalationManagerId &&
        escalationManagerId.toString() === userId.toString();

    const isAssignedAsAgent =
        assignedAgentId &&
        assignedAgentId.toString() === userId.toString();

    return isAssignedAsManager || isAssignedAsAgent;
}

module.exports = {
    escalationManagerMongoFilter,
    canEscalationManagerAccess
};
