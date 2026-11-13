
const mongoose = require("mongoose");

const conversationSchema = new mongoose.Schema(
    {
        ticketId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Ticket",
            required: true
        },

        type: {
            type: String,
            enum: ["internal", "external"],
            required: true
        },

        sender: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true
        },

        recipients: [
            {
                name: {
                    type: String,
                    trim: true
                },

                email: {
                    type: String,
                    required: true,
                    lowercase: true,
                    trim: true,
                    immutable: true
                }
            }
        ],

        message: {
            type: String,
            required: true,
            trim: true
        }
    },
    {
        timestamps: true
    }
);

conversationSchema.index({ ticketId: 1, createdAt: 1 });

const Conversation = mongoose.model(
    "Conversation",
    conversationSchema
);

module.exports = Conversation;
