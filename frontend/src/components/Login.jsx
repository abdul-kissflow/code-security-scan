import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { devLogin } from "../api.js";
import { useAuth } from "../AuthContext.jsx";

/**
 * TEMPORARY stand-in for real SSO - styled like the real thing (single
 * button, no password field) so swapping in an actual OIDC/SAML redirect
 * later doesn't change how this screen looks or behaves, just what's behind
 * the button.
 */
export default function Login() {
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const user = await devLogin(email, name);
      setUser(user);
      navigate("/app");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>Code Health Analyzer</h1>
        <p className="muted">Sign in to see your scans.</p>

        <label className="login-field">
          <span>Work email</span>
          <input
            type="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </label>
        <label className="login-field">
          <span>Name (optional)</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" />
        </label>

        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Continue with SSO"}
        </button>
        <p className="muted login-hint">Temporary sign-in while real SSO is wired up - no password needed yet.</p>

        {error && <p className="error-text">{error}</p>}
      </form>
    </div>
  );
}
