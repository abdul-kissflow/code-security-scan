import { useCallback, useEffect, useRef, useState } from "react";
import { Outlet, useNavigate, useParams } from "react-router-dom";
import LeftNav from "./LeftNav.jsx";
import { getScans, logout as apiLogout } from "../api.js";
import { useAuth } from "../AuthContext.jsx";

export default function AppShell() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const { id: activeId } = useParams();
  const [scans, setScans] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const refreshRef = useRef(null);

  const refresh = useCallback(() => {
    return getScans()
      .then((list) => {
        setScans(list);
        setLoaded(true);
        return list;
      })
      .catch(() => {});
  }, []);
  refreshRef.current = refresh;

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Keep the nav's status dots live while anything is actually running -
  // stops polling on its own once everything settles.
  useEffect(() => {
    if (!scans.some((s) => s.overallStatus === "running")) return;
    const timer = setInterval(() => refreshRef.current(), 4000);
    return () => clearInterval(timer);
  }, [scans]);

  async function handleLogout() {
    await apiLogout().catch(() => {});
    setUser(null);
    navigate("/login");
  }

  return (
    <div className="app-shell-layout">
      <LeftNav scans={scans} activeId={activeId} loaded={loaded} />
      <div className="app-main-column">
        <header className="app-topbar">
          <h1>Code Health Analyzer</h1>
          <div className="app-topbar-user">
            <span className="muted">{user?.email}</span>
            <button type="button" className="btn-small" onClick={handleLogout}>
              Sign out
            </button>
          </div>
        </header>
        <main className="app-main">
          <Outlet context={{ refreshScans: refresh }} />
        </main>
      </div>
    </div>
  );
}
