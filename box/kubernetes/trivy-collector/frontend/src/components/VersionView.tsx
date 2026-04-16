import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { getVersion, getStatus, getConfig } from '../api'
import { escapeHtml, formatDate } from '../utils'
import type { VersionResponse, StatusResponse, ConfigResponse } from '../types'

export default function VersionView() {
  const navigate = useNavigate()
  const [version, setVersion] = useState<VersionResponse | null>(null)
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [config, setConfig] = useState<ConfigResponse | null>(null)

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {})
    getStatus().then(setStatus).catch(() => {})
    getConfig().then(setConfig).catch(() => {})
  }, [])

  const commitShort = version ? version.commit.substring(0, 7) : ''

  return (
    <section className="detail-container">
      <div className="detail-header">
        <button className="btn-back" onClick={() => navigate('/vulnerabilities')}>
          <i className="fa-solid fa-arrow-left" /> Back to List
        </button>
        <h2>Version Information</h2>
      </div>

      <div className="graph-section">
        <div className="section-bar"><h3 className="graph-title">Application</h3></div>
        <div className="detail-summary">
          {version ? (
            <>
              <div className="detail-summary-item">
                <span className="detail-summary-label">Version</span>
                <span className="detail-summary-value">v{version.version}+{commitShort}</span>
              </div>
              <div className="detail-summary-item">
                <span className="detail-summary-label">Build Date</span>
                <span className="detail-summary-value">{formatDate(version.build_date)}</span>
              </div>
              <div className="detail-summary-item">
                <span className="detail-summary-label">Commit</span>
                <span className="detail-summary-value mono">{version.commit}</span>
              </div>
            </>
          ) : (
            <p className="loading">Loading...</p>
          )}
        </div>
      </div>

      <div className="graph-section">
        <div className="section-bar"><h3 className="graph-title">Build Environment</h3></div>
        <div className="detail-summary">
          <div className="detail-summary-divider">Backend</div>
          {version ? (
            <>
              <div className="detail-summary-item">
                <span className="detail-summary-label">Rust</span>
                <span className="detail-summary-value">
                  <a href="https://github.com/rust-lang/rust/releases" target="_blank" rel="noopener noreferrer">
                    {version.rust_version}
                  </a> ({version.rust_channel})
                </span>
              </div>
              <div className="detail-summary-item">
                <span className="detail-summary-label">LLVM</span>
                <span className="detail-summary-value">{version.llvm_version}</span>
              </div>
              <div className="detail-summary-item">
                <span className="detail-summary-label">Platform</span>
                <span className="detail-summary-value">{version.platform}</span>
              </div>
            </>
          ) : (
            <p className="loading">Loading...</p>
          )}
          <div className="detail-summary-divider">Frontend</div>
          <div className="detail-summary-item">
            <span className="detail-summary-label">React</span>
            <span className="detail-summary-value">
              <a href="https://github.com/facebook/react/releases" target="_blank" rel="noopener noreferrer">
                {__REACT_VERSION__}
              </a>
            </span>
          </div>
          <div className="detail-summary-item">
            <span className="detail-summary-label">TypeScript</span>
            <span className="detail-summary-value">
              <a href="https://github.com/microsoft/TypeScript/releases" target="_blank" rel="noopener noreferrer">
                {__TYPESCRIPT_VERSION__}
              </a>
            </span>
          </div>
          <div className="detail-summary-item">
            <span className="detail-summary-label">Vite</span>
            <span className="detail-summary-value">
              <a href="https://github.com/vitejs/vite/releases" target="_blank" rel="noopener noreferrer">
                {__VITE_VERSION__}
              </a>
            </span>
          </div>
          <div className="detail-summary-item">
            <span className="detail-summary-label">Node.js</span>
            <span className="detail-summary-value">{__NODE_VERSION__}</span>
          </div>
        </div>
      </div>

      <div className="graph-section">
        <div className="section-bar"><h3 className="graph-title">Server Status</h3></div>
        <div className="detail-summary">
          {status ? (
            <>
              <div className="detail-summary-item">
                <span className="detail-summary-label">Hostname</span>
                <span className="detail-summary-value">{escapeHtml(status.hostname)}</span>
              </div>
              <div className="detail-summary-item">
                <span className="detail-summary-label">Uptime</span>
                <span className="detail-summary-value">{escapeHtml(status.uptime)}</span>
              </div>
              <div className="detail-summary-item">
                <span className="detail-summary-label">Collectors</span>
                <span className="detail-summary-value">{status.collectors}</span>
              </div>
            </>
          ) : (
            <p className="loading">Loading...</p>
          )}
        </div>
      </div>

      <div className="graph-section">
        <div className="section-bar"><h3 className="graph-title">Runtime Configuration</h3></div>
        <div className="detail-summary vertical">
          {config?.items ? (
            config.items.map((item) => (
              <div key={item.env} className="detail-summary-item">
                <span className="detail-summary-label">{escapeHtml(item.env)}</span>
                <span className={`detail-summary-value${item.sensitive ? ' sensitive' : ''}`}>
                  {escapeHtml(item.value)}
                </span>
              </div>
            ))
          ) : (
            <p className="loading">Loading...</p>
          )}
        </div>
      </div>
    </section>
  )
}
