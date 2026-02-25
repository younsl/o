import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import ReportsPage from './pages/ReportsPage'
import DetailPage from './pages/DetailPage'
import DashboardView from './components/DashboardView'
import VersionView from './components/VersionView'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/vulnerabilities" replace />} />
          <Route path="vulnerabilities" element={<ReportsPage reportType="vulnerabilityreport" />} />
          <Route path="vulnerabilities/:cluster/:namespace/:name" element={<DetailPage reportType="vulnerabilityreport" />} />
          <Route path="sbom" element={<ReportsPage reportType="sbomreport" />} />
          <Route path="sbom/:cluster/:namespace/:name" element={<DetailPage reportType="sbomreport" />} />
          <Route path="dashboard" element={<DashboardView />} />
          <Route path="version" element={<VersionView />} />
          <Route path="*" element={<Navigate to="/vulnerabilities" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
