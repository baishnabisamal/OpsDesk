
function roleCheck(allowedRoles) {
    return (req, res, next) => {

        // Check whether the user is authenticated
        if (!req.user) {
            return res.status(401).json({
                error: "Not authenticated"
            });
        }

        // Check whether the user's role is permitted
        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({
                error: "Access denied"
            });
        }

        next();
    };
}

module.exports = { roleCheck };
