const dns = require("node:dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const express = require("express");
const cors = require("cors");
require("dotenv").config();

const connectDB = require("./config/db");

const authRoutes = require("./routes/authRoutes")

const app = express();

const ticketRoutes = require("./routes/ticketRoutes");

// Middleware
app.use(cors());
app.use(express.json());
app.use("/api/auth", authRoutes);
app.use("/api/tickets", ticketRoutes);

// Connect to MongoDB
connectDB();

// Test route
app.get("/", (req, res) => {
    res.send("OpsDesk Backend Running");
});

// Start server
const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
