import "dotenv/config";
import cors from "cors";
import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "./db.js";
import { requireAuth } from "./middleware/auth.js";
import authRouter from "./routes/auth.js";
import scansRouter from "./routes/scans.js";

if (!process.env.SESSION_SECRET) {
  console.error("SESSION_SECRET is not set (.env) - refusing to start with a guessable session key");
  process.exit(1);
}

const app = express();
const PgSession = connectPgSimple(session);

app.use(cors());
app.use(express.json());
app.use(
  session({
    store: new PgSession({ pool }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 },
  })
);

app.get("/api/health", (req, res) => res.json({ ok: true }));
app.use("/api/auth", authRouter);
app.use("/api/scans", requireAuth, scansRouter);

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => {
  console.log(`FE scanner backend listening on http://localhost:${PORT}`);
});

// The /explain route runs a codebase-exploring Claude Agent SDK session that
// can legitimately take longer than Node's default 5-minute request timeout.
server.requestTimeout = 0;
server.headersTimeout = 0;
