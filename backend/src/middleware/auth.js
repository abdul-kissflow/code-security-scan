/**
 * Requires an authenticated session (set by /api/auth/dev-login). Every
 * /api/scans/* route sits behind this - there's no anonymous scan pool
 * anymore now that scans belong to a user.
 */
export function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  req.user = { id: req.session.userId, email: req.session.userEmail, name: req.session.userName };
  next();
}
