
const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true
        },

        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true
        },

        password: {
            type: String,
            required: true
        },

        role: {
            type: String,
            enum: [
                "requester",
                "agent",
                "escalation_manager",
                "lead"
            ],
            required: true
        },

        region: {
            type: String,
            default: "Not Assigned"
        },

        availability: {
            type: String,
            enum: ["available", "busy", "offline"],
            default: "available"
        },

        currentTickets: {
            type: Number,
            default: 0
        },

        agencyId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Agency",
            default: null
        },

        isActive: {
            type: Boolean,
            default: true
        }
    },
    {
        timestamps: true
    }
);

const User = mongoose.model("User", userSchema);

module.exports = User;
