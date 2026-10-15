import { Router } from "express";
import { pool } from "../db.js";

const router = Router();

/**
 * TEMPORARY stand-in for real SSO. Takes an email (no password, no identity
 * check) and upserts a user + starts a session. When real SSO (OIDC/SAML)
 * is wired up, this route is replaced by an IdP callback that ends the same
 * way - upsert user, set req.session.userId - so nothing downstream changes.
 */
router.post("/dev-login", async (req, res, next) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const name = String(req.body?.name || "").trim();
    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "A valid email is required" });
    }

    const { rows } = await pool.query(
      `insert into users (email, name) values ($1, $2)
       on conflict (email) do update set name = coalesce(nullif($2, ''), users.name)
       returning id, email, name`,
      [email, name]
    );
    const user = rows[0];

    req.session.userId = user.id;
    req.session.userEmail = user.email;
    req.session.userName = user.name;
    res.json(user);
  } catch (err) {
    next(err);
  }
});

router.get("/me", (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: "Not authenticated" });
  res.json({ id: req.session.userId, email: req.session.userEmail, name: req.session.userName });
});

router.post("/logout", (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

export default router;
