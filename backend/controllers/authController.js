
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");

// LOGIN
async function login(req, res) {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                error: "email and password are required"
            });
        }

        const user = await User.findOne({
            email: email.trim().toLowerCase()
        });

        if (!user) {
            return res.status(401).json({
                error: "Invalid email or password"
            });
        }

        if (!user.isActive) {
            return res.status(403).json({
                error: "This account has been deactivated"
            });
        }

        const isPasswordValid = await bcrypt.compare(
            password,
            user.password
        );

        if (!isPasswordValid) {
            return res.status(401).json({
                error: "Invalid email or password"
            });
        }

        if (!process.env.JWT_SECRET) {
            throw new Error("JWT_SECRET is not configured");
        }

        const tokenPayload = {
            id: user._id,
            name: user.name,
            email: user.email,
            role: user.role,
            region: user.region,
            agencyId: user.agencyId
        };

        const token = jwt.sign(
            tokenPayload,
            process.env.JWT_SECRET,
            { expiresIn: "8h" }
        );

        res.json({
            success: true,
            token,
            user: tokenPayload
        });

    } catch (err) {
        console.error("Login error:", err.message);

        res.status(500).json({
            error: "Something went wrong during login"
        });
    }
}

module.exports = { login };
