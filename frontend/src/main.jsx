import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import './index.css'
import './App.css'
import { AuthProvider } from './AuthContext.jsx'
import RequireAuth from './components/RequireAuth.jsx'
import Login from './components/Login.jsx'
import AppShell from './components/AppShell.jsx'
import UploadHome from './components/UploadHome.jsx'
import ScanView from './components/ScanView.jsx'
import TechnicalView from './components/TechnicalView.jsx'

function TechnicalRoute() {
  const id = window.location.pathname.split('/').pop()
  return <TechnicalView scanId={id} />
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/technical/:id" element={<TechnicalRoute />} />
          <Route
            path="/app"
            element={
              <RequireAuth>
                <AppShell />
              </RequireAuth>
            }
          >
            <Route index element={<UploadHome />} />
            <Route path="scans/:id" element={<ScanView />} />
          </Route>
          <Route path="*" element={<Navigate to="/app" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
