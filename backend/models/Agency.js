
const mongoose = require("mongoose");

const agencySchema = new mongoose.Schema(
    {
        agencyName: {
            type: String,
            required: true,
            trim: true
        },

        agencyCode: {
            type: String,
            required: true,
            unique: true,
            uppercase: true,
            trim: true
        },

        country: {
            type: String,
            required: true
        },

        region: {
            type: String,
            required: true
        },

        contactEmail: {
            type: String,
            required: true,
            lowercase: true,
            trim: true
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

const Agency = mongoose.model("Agency", agencySchema);

module.exports = Agency;
