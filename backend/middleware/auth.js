
const jwt = require("jsonwebtoken");

function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;

    // Check whether the token was provided
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({
            error: "No token provided"
        });
    }

    const token = authHeader.split(" ")[1];

    try {
        // Verify the token using our secret key
        const decoded = jwt.verify(
            token,
            process.env.JWT_SECRET
        );

        // Attach user details to the request
        req.user = decoded;

        next();

    } catch (err) {
        return res.status(401).json({
            error: "Invalid or expired token"
        });
    }
}

module.exports = { authenticate };
