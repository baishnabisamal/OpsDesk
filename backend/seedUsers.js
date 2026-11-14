
require("dotenv").config();

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const User = require("./models/User");
const Agency = require("./models/Agency");
const connectDB = require("./config/db");

async function seed() {
    try {
        await connectDB();

        // Create the agency if it doesn't already exist
        const agency = await Agency.findOneAndUpdate(
            { agencyCode: "ABC001" },
            {
                $setOnInsert: {
                    agencyName: "ABC Travels",
                    agencyCode: "ABC001",
                    country: "India",
                    region: "Asia",
                    contactEmail: "contact@abctravels.com"
                }
            },
            {
                upsert: true,
                new: true,
                setDefaultsOnInsert: true
            }
        );

        // Hash the demo password
        const hashedPassword = await bcrypt.hash("password123", 10);

        // Demo user details
        const users = [
            {
                name: "Agency Requester",
                email: "requester@example.com",
                role: "requester",
                region: "Asia",
                agencyId: agency._id
            },
            {
                name: "Rahul (Agent)",
                email: "agent@example.com",
                role: "agent",
                region: "Asia",
                availability: "available",
                agencyId: null
            },
            {
                name: "Manager (Escalation)",
                email: "manager@example.com",
                role: "escalation_manager",
                region: "Asia",
                agencyId: null
            },
            {
                name: "Lead User",
                email: "lead@example.com",
                role: "lead",
                region: "Asia",
                agencyId: null
            }
        ];

        // Insert only users that don't already exist
        for (const user of users) {
            await User.findOneAndUpdate(
                { email: user.email },
                {
                    $setOnInsert: {
                        ...user,
                        password: hashedPassword
                    }
                },
                {
                    upsert: true,
                    new: true,
                    setDefaultsOnInsert: true
                }
            );
        }

        console.log("Seed completed successfully!");
        console.log("Agency:", agency.agencyName);
        console.log("Demo users checked/created:", users.length);

        console.log("Demo login password for newly created users: password123");

    } catch (error) {
        console.error("Seed error:", error.message);
    } finally {
        await mongoose.disconnect();
    }
}

seed();
