
const mongoose = require("mongoose");

const activitySchema = new mongoose.Schema(
    {
        ticketId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Ticket",
            required: true
        },

        action: {
            type: String,
            enum: [
                "created",
                "status_changed",
                "assigned",
                "reassigned",
                "unassigned",
                "linked",
                "escalated",
                "comment_added"
            ],
            required: true
        },

        description: {
            type: String,
            required: true
        },

        performedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true
        }
    },
    {
        timestamps: true
    }
);

activitySchema.index({ ticketId: 1, createdAt: 1 });

const Activity = mongoose.model("Activity", activitySchema);

module.exports = Activity;
