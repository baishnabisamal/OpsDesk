
const mongoose = require("mongoose");

const ticketSchema = new mongoose.Schema(
    {
        title: {
            type: String,
            required: true,
            trim: true
        },

        description: {
            type: String,
            required: true
        },

        agencyId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Agency",
            required: true
        },

        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true
        },

        TBOH: {
            type: String,
            trim: true,
            default: null
        },

        priority: {
            type: String,
            enum: ["low", "medium", "high", "urgent"],
            default: "medium"
        },

        intent: {
            type: String,
            enum: [
                "refund",
                "booking",
                "cancellation",
                "inventory_sync",
                "special_request",
                "other"
            ],
            default: "other"
        },

        category: {
            type: String,
            enum: [
                "financial",
                "booking_operations",
                "inventory",
                "customer_service",
                "general"
            ],
            default: "general"
        },

        checkInDate: {
            type: Date,
            default: null
        },

        LCD: {
            type: Date,
            default: null
        },

        status: {
            type: String,
            enum: [
                "new",
                "open",
                "pending",
                "escalated",
                "resolved",
                "closed"
            ],
            default: "new"
        },

        assignedAgent: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null
        },
        escalationManager: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null
        },

        region: {
            type: String,
            required: true
        },

        linkedTickets: [
            {
                ticketId: {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: "Ticket"
                },
                linkReason: {
                    type: String,
                    enum: ["same_TBOH", "same_agency_intent"]
                }
            }
        ],
            
        routingReason: {
            region: {
                type: Boolean,
                default: false
            },
        
            priority: {
                type: Boolean,
                default: false
            },
        
            availability: {
                type: Boolean,
                default: false
            },
        
            agentWorkloadAtAssignment: {
                type: Number,
                default: null
           },

            note: {
                type: String,
                default: null
            }
        },

        slaDueAt: {
            type: Date,
            default: null
        },

        slaStatus: {
            type: String,
            enum: ["on_track", "at_risk", "breached"],
            default: "on_track"
        }
    },
    {
        timestamps: true
    }
);

// Useful indexes for searching and filtering tickets
ticketSchema.index({ TBOH: 1 });
ticketSchema.index({ agencyId: 1, intent: 1 });
ticketSchema.index({ assignedAgent: 1, status: 1 });
ticketSchema.index({ region: 1, priority: 1 });

const Ticket = mongoose.model("Ticket", ticketSchema);

module.exports = Ticket;
