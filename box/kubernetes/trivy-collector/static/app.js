// State
let currentReportType = 'vulnerabilityreport';
let currentReports = [];
let sortColumn = null;
let sortDirection = 'asc';

// Total reports count (from stats API)
let totalVulnReports = 0;
let totalSbomReports = 0;

// Total severity counts (from stats API)
let totalSeverity = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    unknown: 0
};

// Filter state
let filters = {
    cluster: '',
    namespace: '',
    app: ''
};
let clusterOptions = [];
let namespaceOptions = [];
let currentFilterKey = null;

// DOM Elements
const btnVuln = document.getElementById('btn-vuln');
const btnSbom = document.getElementById('btn-sbom');
const reportsThead = document.getElementById('reports-thead');
const reportsBody = document.getElementById('reports-body');

// LED Elements
const ledVuln = document.getElementById('led-vuln');
const ledSbom = document.getElementById('led-sbom');

// View Elements
const reportsSection = document.getElementById('reports');
const detailView = document.getElementById('detail-view');
const detailTitle = document.getElementById('detail-title');
const detailSummary = document.getElementById('detail-summary');
const btnBack = document.getElementById('btn-back');

// Vuln Detail Elements
const vulnDetailThead = document.getElementById('vuln-detail-thead');
const vulnDetailTbody = document.getElementById('vuln-detail-tbody');

// SBOM Detail Elements
const sbomDetailThead = document.getElementById('sbom-detail-thead');
const sbomDetailTbody = document.getElementById('sbom-detail-tbody');

// Toolbar Elements
const reportsCount = document.getElementById('reports-count');
const btnExportCsv = document.getElementById('btn-export-csv');

// Filter Popup Elements
const filterPopup = document.getElementById('filter-popup');
const filterPopupTitle = document.getElementById('filter-popup-title');
const filterPopupBody = document.getElementById('filter-popup-body');
const filterPopupClose = document.getElementById('filter-popup-close');
const filterApply = document.getElementById('filter-apply');
const filterClear = document.getElementById('filter-clear');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    renderTableHeader();
    loadVersion();
    loadStats();
    loadClusters();
    loadNamespaces();
    loadReports();
    loadWatcherStatus();

    // Event listeners
    btnVuln.addEventListener('click', () => switchReportType('vulnerabilityreport'));
    btnSbom.addEventListener('click', () => switchReportType('sbomreport'));
    btnBack.addEventListener('click', showListView);
    btnExportCsv.addEventListener('click', exportToCsv);
    document.getElementById('btn-export-detail').addEventListener('click', exportDetailToJson);
    document.getElementById('btn-version-back').addEventListener('click', hideVersionPage);

    // Scroll navigation
    document.getElementById('btn-scroll-top').addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    document.getElementById('btn-scroll-bottom').addEventListener('click', () => {
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    });

    // Filter popup events
    filterPopupClose.addEventListener('click', closeFilterPopup);
    filterApply.addEventListener('click', applyFilter);
    filterClear.addEventListener('click', clearFilter);

    // Close popups when clicking outside
    document.addEventListener('click', (e) => {
        if (!filterPopup.contains(e.target) && !e.target.classList.contains('filter-btn')) {
            closeFilterPopup();
        }
        // Close help tooltip when clicking outside
        if (currentHelpTooltip && !currentHelpTooltip.contains(e.target) && !e.target.closest('.help-btn')) {
            closeHelpTooltip();
        }
        // Notes modal is handled by its own overlay click handler
    });

    // Column sorting and filter click handlers
    initSortableColumns();
    initFilterButtons();

    // DB help button (click)
    document.getElementById('db-help-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        showHelpTooltip('dbinfo', e.currentTarget);
    });

    // SBOM help button in toolbar (click)
    const sbomHelpBtn = document.getElementById('sbom-help-btn');
    if (sbomHelpBtn) {
        sbomHelpBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            showHelpTooltip('sbom', e.currentTarget);
        });
    }

    // Poll status every 5 seconds
    setInterval(loadWatcherStatus, 5000);
    setInterval(loadStats, 5000);

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (currentHelpTooltip) {
                closeHelpTooltip();
            } else if (!filterPopup.classList.contains('hidden')) {
                closeFilterPopup();
            } else if (!versionView.classList.contains('hidden')) {
                hideVersionPage();
            } else if (dashboardView && !dashboardView.classList.contains('hidden')) {
                hideDashboardView();
            } else if (!detailView.classList.contains('hidden')) {
                showListView();
            }
        }
    });

    // Dashboard event listeners initialization
    initDashboardEventListeners();
});

// LED blink effect
function blinkLed(ledElement) {
    ledElement.classList.remove('blink');
    void ledElement.offsetWidth; // Force reflow to restart animation
    ledElement.classList.add('blink');
    setTimeout(() => ledElement.classList.remove('blink'), 300);
}

// API calls
async function fetchApi(endpoint) {
    const response = await fetch(endpoint);
    return response.json();
}

// Load watcher status
async function loadWatcherStatus() {
    try {
        const status = await fetchApi('/api/v1/watcher/status');
        updateLed(ledVuln, status.vuln_watcher);
        updateLed(ledSbom, status.sbom_watcher);
    } catch (error) {
        ledVuln.className = 'led off';
        ledSbom.className = 'led off';
    }
}

function updateLed(led, watcherInfo) {
    if (!watcherInfo.running) {
        led.className = 'led off';
        led.title = 'Watcher not running';
    } else if (!watcherInfo.initial_sync_done) {
        led.className = 'led syncing';
        led.title = 'Initial sync in progress...';
    } else {
        led.className = 'led running';
        led.title = 'Watcher running';
        blinkLed(led);
    }
}

// Version, status, and config data cache
let versionData = null;
let statusData = null;
let configData = null;

// Version View Elements
const versionView = document.getElementById('version-view');
const versionAppInfo = document.getElementById('version-app-info');
const versionServerStatus = document.getElementById('version-server-status');
const versionBuildInfo = document.getElementById('version-build-info');
const versionConfigInfo = document.getElementById('version-config-info');

// Load version info
async function loadVersion() {
    try {
        const version = await fetchApi('/api/v1/version');
        versionData = version;
        const commitShort = version.commit.substring(0, 7);
        const versionInfo = document.getElementById('version-info');
        versionInfo.textContent = `v${version.version} (${commitShort})`;
        versionInfo.title = 'Click to view detailed version info';
        versionInfo.classList.add('clickable');
        versionInfo.addEventListener('click', showVersionPage);
    } catch (error) {
        console.error('Failed to load version:', error);
    }
}

// Load config info
async function loadConfig() {
    try {
        configData = await fetchApi('/api/v1/config');
    } catch (error) {
        console.error('Failed to load config:', error);
    }
}

// Load server status info
async function loadStatus() {
    try {
        statusData = await fetchApi('/api/v1/status');
    } catch (error) {
        console.error('Failed to load status:', error);
    }
}

// Show version page
async function showVersionPage() {
    if (!versionData) return;

    // Hide other views
    reportsSection.classList.add('hidden');
    detailView.classList.add('hidden');
    versionView.classList.remove('hidden');

    const commitShort = versionData.commit.substring(0, 7);
    const buildDate = new Date(versionData.build_date).toLocaleString();

    // Render application info
    versionAppInfo.innerHTML = `
        <div class="detail-summary-item">
            <span class="detail-summary-label">Version</span>
            <span class="detail-summary-value">v${versionData.version}+${commitShort}</span>
        </div>
        <div class="detail-summary-item">
            <span class="detail-summary-label">Build Date</span>
            <span class="detail-summary-value">${buildDate}</span>
        </div>
        <div class="detail-summary-item">
            <span class="detail-summary-label">Commit</span>
            <span class="detail-summary-value mono">${versionData.commit}</span>
        </div>
    `;

    // Load and render server status
    if (!statusData) {
        versionServerStatus.innerHTML = '<p class="loading">Loading...</p>';
        await loadStatus();
    }

    if (statusData) {
        versionServerStatus.innerHTML = `
            <div class="detail-summary-item">
                <span class="detail-summary-label">Hostname</span>
                <span class="detail-summary-value">${escapeHtml(statusData.hostname)}</span>
            </div>
            <div class="detail-summary-item">
                <span class="detail-summary-label">Uptime</span>
                <span class="detail-summary-value">${escapeHtml(statusData.uptime)}</span>
            </div>
            <div class="detail-summary-item">
                <span class="detail-summary-label">Collectors</span>
                <span class="detail-summary-value">${statusData.collectors}</span>
            </div>
        `;
    } else {
        versionServerStatus.innerHTML = '<p class="no-data">Failed to load server status</p>';
    }

    // Render build environment info
    versionBuildInfo.innerHTML = `
        <div class="detail-summary-item">
            <span class="detail-summary-label">Rust Version</span>
            <span class="detail-summary-value"><a href="https://github.com/rust-lang/rust/releases" target="_blank" rel="noopener noreferrer">${versionData.rust_version}</a> (${versionData.rust_channel})</span>
        </div>
        <div class="detail-summary-item">
            <span class="detail-summary-label">LLVM Version</span>
            <span class="detail-summary-value">${versionData.llvm_version}</span>
        </div>
        <div class="detail-summary-item">
            <span class="detail-summary-label">Platform</span>
            <span class="detail-summary-value">${versionData.platform}</span>
        </div>
    `;

    // Load and render config info
    if (!configData) {
        versionConfigInfo.innerHTML = '<p class="loading">Loading...</p>';
        await loadConfig();
    }

    if (configData && configData.items) {
        versionConfigInfo.innerHTML = configData.items.map(item => `
            <div class="detail-summary-item">
                <span class="detail-summary-label">${escapeHtml(item.env)}</span>
                <span class="detail-summary-value${item.sensitive ? ' sensitive' : ''}">${escapeHtml(item.value)}</span>
            </div>
        `).join('');
    } else {
        versionConfigInfo.innerHTML = '<p class="no-data">Failed to load configuration</p>';
    }

    // Scroll to top
    window.scrollTo(0, 0);
}

// Hide version page
function hideVersionPage() {
    versionView.classList.add('hidden');
    reportsSection.classList.remove('hidden');
}

// Load stats
async function loadStats() {
    const ledDb = document.getElementById('led-db');
    try {
        const stats = await fetchApi('/api/v1/stats');
        document.getElementById('stat-clusters').textContent = stats.total_clusters;

        // Store total report counts for filter display
        totalVulnReports = stats.total_vuln_reports;
        totalSbomReports = stats.total_sbom_reports;

        // Store total severity counts for filter display
        totalSeverity.critical = stats.total_critical;
        totalSeverity.high = stats.total_high;
        totalSeverity.medium = stats.total_medium;
        totalSeverity.low = stats.total_low;
        totalSeverity.unknown = stats.total_unknown;

        // Update severity display (respects filter state)
        updateSeverityTotals();

        const totalReports = stats.total_vuln_reports + stats.total_sbom_reports;
        const totalVulns = stats.total_critical + stats.total_high + stats.total_medium + stats.total_low + stats.total_unknown;

        // Update dbinfo tooltip content
        const now = new Date();
        const updatedAt = now.toLocaleString();
        helpTooltips.dbinfo.content = `
            <p><strong>SQLite:</strong> ${stats.sqlite_version}</p>
            <p><strong>Size:</strong> ${stats.db_size_human} (${stats.db_size_bytes.toLocaleString()} bytes)</p>
            <p><strong>Clusters:</strong> ${stats.total_clusters}</p>
            <p><strong>Reports:</strong> ${totalReports.toLocaleString()} (Vuln: ${stats.total_vuln_reports.toLocaleString()}, SBOM: ${stats.total_sbom_reports.toLocaleString()})</p>
            <p><strong>Total Vulnerabilities:</strong> ${totalVulns.toLocaleString()}</p>
            <p style="margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); font-size: 11px; color: var(--text-muted);">Updated: ${updatedAt}</p>
        `;

        // Update tooltip if it's currently open
        if (currentHelpTooltipKey === 'dbinfo' && currentHelpTooltip) {
            const tooltipBody = currentHelpTooltip.querySelector('.help-tooltip-body');
            if (tooltipBody) {
                tooltipBody.innerHTML = helpTooltips.dbinfo.content;
            }
        }

        // Set DB LED to running (green) and blink
        ledDb.className = 'led running';
        ledDb.title = 'Database connected';
        blinkLed(ledDb);
    } catch (error) {
        console.error('Failed to load stats:', error);
        // Set DB LED to error (red)
        ledDb.className = 'led error';
        ledDb.title = 'Database error';
    }
}

// Load clusters for filter
async function loadClusters() {
    try {
        const data = await fetchApi('/api/v1/clusters');
        clusterOptions = data.items || [];
    } catch (error) {
        console.error('Failed to load clusters:', error);
    }
}

// Load namespaces for filter
async function loadNamespaces() {
    try {
        const endpoint = filters.cluster
            ? `/api/v1/namespaces?cluster=${encodeURIComponent(filters.cluster)}`
            : '/api/v1/namespaces';
        const data = await fetchApi(endpoint);
        namespaceOptions = data.items || [];
    } catch (error) {
        console.error('Failed to load namespaces:', error);
    }
}

// Load reports
async function loadReports() {
    const colspan = currentReportType === 'vulnerabilityreport' ? 10 : 6;
    reportsBody.innerHTML = `<tr><td colspan="${colspan}" class="loading">Loading...</td></tr>`;

    // Reset sort state on new search
    sortColumn = null;
    sortDirection = 'asc';
    updateSortIndicators();

    try {
        const params = new URLSearchParams();

        if (filters.cluster) params.append('cluster', filters.cluster);
        if (filters.namespace) params.append('namespace', filters.namespace);
        if (filters.app) params.append('app', filters.app);

        const endpoint = currentReportType === 'vulnerabilityreport'
            ? `/api/v1/vulnerabilityreports?${params}`
            : `/api/v1/sbomreports?${params}`;

        const data = await fetchApi(endpoint);
        currentReports = data.items || [];

        renderReports();
        updateFilterButtonStates();
    } catch (error) {
        console.error('Failed to load reports:', error);
        const colspan = currentReportType === 'vulnerabilityreport' ? 10 : 6;
        reportsBody.innerHTML = `<tr><td colspan="${colspan}" class="no-data">Error loading reports</td></tr>`;
    }
}

// Check if any filter is active
function isFilterActive() {
    return filters.cluster || filters.namespace || filters.app;
}

// Calculate filtered severity counts from current reports
function calculateFilteredSeverity() {
    const filtered = {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        unknown: 0
    };

    if (currentReportType === 'vulnerabilityreport') {
        currentReports.forEach(report => {
            const summary = report.summary || {};
            filtered.critical += summary.critical || 0;
            filtered.high += summary.high || 0;
            filtered.medium += summary.medium || 0;
            filtered.low += summary.low || 0;
            filtered.unknown += summary.unknown || 0;
        });
    }

    return filtered;
}

// Update severity totals display with filtered/total format
function updateSeverityTotals() {
    const severityLevels = ['critical', 'high', 'medium', 'low', 'unknown'];
    const filteredSeverity = calculateFilteredSeverity();
    const filterActive = isFilterActive();

    severityLevels.forEach(level => {
        const el = document.getElementById(`stat-${level}`);
        const filteredVal = filteredSeverity[level];
        const totalVal = totalSeverity[level];

        if (filterActive && totalVal > 0) {
            el.innerHTML = `<span class="filtered-count">${filteredVal}</span><span class="total-count"> / ${totalVal}</span>`;
        } else {
            el.textContent = totalVal;
        }
    });
}

// Render reports
function renderReports() {
    // Update reports count
    const reportTypeName = currentReportType === 'vulnerabilityreport' ? 'Vulnerability' : 'SBOM';
    document.getElementById('reports-type-label').textContent = reportTypeName;

    // Get total count based on current report type
    const totalCount = currentReportType === 'vulnerabilityreport' ? totalVulnReports : totalSbomReports;
    const filteredCount = currentReports.length;

    // Display filtered/total when filter is active
    const reportsNumberEl = document.getElementById('reports-number');
    if (isFilterActive() && totalCount > 0) {
        reportsNumberEl.innerHTML = `<span class="filtered-count">${filteredCount}</span><span class="total-count"> / ${totalCount}</span>`;
    } else {
        reportsNumberEl.textContent = filteredCount;
    }

    // Update severity totals with filtered/total display
    updateSeverityTotals();

    const colspan = currentReportType === 'vulnerabilityreport' ? 10 : 6;
    if (currentReports.length === 0) {
        reportsBody.innerHTML = `<tr><td colspan="${colspan}" class="no-data">No reports found</td></tr>`;
        btnExportCsv.disabled = true;
        return;
    }

    btnExportCsv.disabled = false;
    reportsBody.innerHTML = '';
    currentReports.forEach(report => {
        const row = document.createElement('tr');
        row.innerHTML = currentReportType === 'vulnerabilityreport'
            ? createVulnRow(report)
            : createSbomRow(report);
        row.addEventListener('click', () => {
            showReportDetail(report);
        });
        reportsBody.appendChild(row);
    });
}

function createVulnRow(report) {
    const summary = report.summary || {};
    const hasNotes = report.notes && report.notes.trim().length > 0;
    const notesIcon = hasNotes ? '<i class="fa-solid fa-note-sticky notes-indicator" title="Has notes"></i>' : '';
    return `
        <td>${escapeHtml(report.cluster)}</td>
        <td>${escapeHtml(report.namespace)}</td>
        <td>${escapeHtml(report.app || '-')}</td>
        <td class="image-cell">${escapeHtml(report.image || '-')}${notesIcon}</td>
        <td class="severity-col">${formatSeverity(summary.critical, 'critical')}</td>
        <td class="severity-col">${formatSeverity(summary.high, 'high')}</td>
        <td class="severity-col">${formatSeverity(summary.medium, 'medium')}</td>
        <td class="severity-col">${formatSeverity(summary.low, 'low')}</td>
        <td class="severity-col">${formatSeverity(summary.unknown, 'unknown')}</td>
        <td>${formatDate(report.updated_at)}</td>
    `;
}

function createSbomRow(report) {
    const hasNotes = report.notes && report.notes.trim().length > 0;
    const notesIcon = hasNotes ? '<i class="fa-solid fa-note-sticky notes-indicator" title="Has notes"></i>' : '';
    return `
        <td>${escapeHtml(report.cluster)}</td>
        <td>${escapeHtml(report.namespace)}</td>
        <td>${escapeHtml(report.app || '-')}</td>
        <td class="image-cell">${escapeHtml(report.image || '-')}${notesIcon}</td>
        <td><span class="components-badge">${report.components_count || 0}</span></td>
        <td>${formatDate(report.updated_at)}</td>
    `;
}

function formatSeverity(count, level) {
    if (!count || count === 0) {
        return '<span class="severity-zero">0</span>';
    }
    return `<span class="severity-badge severity-${level}">${count}</span>`;
}

function formatSeverityLabel(severity) {
    const sev = (severity || '').toUpperCase();
    const labels = { 'CRITICAL': 'C', 'HIGH': 'H', 'MEDIUM': 'M', 'LOW': 'L', 'UNKNOWN': 'U' };
    const label = labels[sev] || '?';
    return `<span class="severity-badge severity-${sev.toLowerCase()}">${label}</span>`;
}

function formatDate(dateStr) {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleString();
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Switch report type
function switchReportType(type) {
    currentReportType = type;
    btnVuln.classList.toggle('active', type === 'vulnerabilityreport');
    btnSbom.classList.toggle('active', type === 'sbomreport');

    // Exit detail view and show list view
    showListView();

    renderTableHeader();
    loadReports();
}

// Render table header based on report type
function renderTableHeader() {
    if (currentReportType === 'vulnerabilityreport') {
        reportsThead.innerHTML = `
            <tr>
                <th class="sortable filterable" data-sort-key="cluster" data-filter-key="cluster">
                    <span class="th-content">Cluster</span>
                    <i class="fa-solid fa-sort sort-icon"></i>
                    <button class="filter-btn" title="Filter"><i class="fa-solid fa-filter"></i></button>
                </th>
                <th class="sortable filterable" data-sort-key="namespace" data-filter-key="namespace">
                    <span class="th-content">Namespace</span>
                    <i class="fa-solid fa-sort sort-icon"></i>
                    <button class="filter-btn" title="Filter"><i class="fa-solid fa-filter"></i></button>
                </th>
                <th class="filterable" data-filter-key="app">
                    <span class="th-content">Application</span>
                    <button class="filter-btn" title="Filter"><i class="fa-solid fa-filter"></i></button>
                </th>
                <th>Image</th>
                <th class="severity-col sortable" data-sort-key="critical">C <i class="fa-solid fa-sort sort-icon"></i></th>
                <th class="severity-col sortable" data-sort-key="high">H <i class="fa-solid fa-sort sort-icon"></i></th>
                <th class="severity-col sortable" data-sort-key="medium">M <i class="fa-solid fa-sort sort-icon"></i></th>
                <th class="severity-col sortable" data-sort-key="low">L <i class="fa-solid fa-sort sort-icon"></i></th>
                <th class="severity-col sortable" data-sort-key="unknown">U <i class="fa-solid fa-sort sort-icon"></i></th>
                <th class="sortable" data-sort-key="updated_at">Updated <i class="fa-solid fa-sort sort-icon"></i></th>
            </tr>
        `;
    } else {
        reportsThead.innerHTML = `
            <tr>
                <th class="sortable filterable" data-sort-key="cluster" data-filter-key="cluster">
                    <span class="th-content">Cluster</span>
                    <i class="fa-solid fa-sort sort-icon"></i>
                    <button class="filter-btn" title="Filter"><i class="fa-solid fa-filter"></i></button>
                </th>
                <th class="sortable filterable" data-sort-key="namespace" data-filter-key="namespace">
                    <span class="th-content">Namespace</span>
                    <i class="fa-solid fa-sort sort-icon"></i>
                    <button class="filter-btn" title="Filter"><i class="fa-solid fa-filter"></i></button>
                </th>
                <th class="filterable" data-filter-key="app">
                    <span class="th-content">Application</span>
                    <button class="filter-btn" title="Filter"><i class="fa-solid fa-filter"></i></button>
                </th>
                <th>Image</th>
                <th class="sortable" data-sort-key="components">Components <i class="fa-solid fa-sort sort-icon"></i></th>
                <th class="sortable" data-sort-key="updated_at">Updated <i class="fa-solid fa-sort sort-icon"></i></th>
            </tr>
        `;
    }
    // Re-initialize event handlers for new header elements
    initSortableColumns();
    initFilterButtons();
    updateFilterButtonStates();
}

// Help Tooltip Functions
const helpTooltips = {
    sbom: {
        title: 'SBOM',
        content: `
            <p>Software Bill of Materials — a complete list of components in your software.</p>
            <p>Like a nutrition label for code.</p>
            <p><strong>Use cases:</strong></p>
            <p>• Track vulnerability impact</p>
            <p>• Verify license compliance</p>
            <p>• Manage supply chain security</p>
            <p><a href="https://www.cisa.gov/sbom" target="_blank">Learn more →</a></p>
        `
    },
    purl: {
        title: 'PURL',
        content: `
            <p>Package URL — a standard format to identify software packages.</p>
            <p>Format: <code>pkg:type/namespace/name@version</code></p>
            <p>Examples:</p>
            <p><code>pkg:npm/%40babel/core@7.24.0</code></p>
            <p><code>pkg:golang/github.com/gin-gonic/gin@v1.9.1</code></p>
            <p><a href="https://github.com/package-url/purl-spec" target="_blank">Learn more →</a></p>
        `
    },
    bomformat: {
        title: 'BOM Format',
        content: `
            <p>The standard format used for SBOM data.</p>
            <p><code>CycloneDX</code> — OWASP standard, optimized for security.</p>
            <p><code>SPDX</code> — Linux Foundation standard, focused on licensing.</p>
            <p>Trivy uses <strong>CycloneDX</strong> by default. The version number (e.g., 1.5) indicates the spec version, which determines supported fields and features.</p>
            <p><a href="https://cyclonedx.org/specification/overview/" target="_blank">Learn more →</a></p>
        `
    },
    dbinfo: {
        title: 'Database',
        content: '<p>Loading...</p>'
    },
    // Dashboard tooltips
    'dash-collectors': {
        title: 'Collectors',
        content: `
            <p>Number of Kubernetes clusters sending reports to this server.</p>
            <p>Each collector watches Trivy Operator CRDs in its cluster.</p>
        `
    },
    'dash-vuln': {
        title: 'Vulnerability Reports',
        content: `
            <p>Number of VulnerabilityReports collected from Trivy Operator.</p>
            <p>Each report contains CVE findings for a container image.</p>
        `
    },
    'dash-sbom': {
        title: 'SBOM Reports',
        content: `
            <p>Number of SbomReports collected from Trivy Operator.</p>
            <p>Each report lists software components in a container image.</p>
        `
    },
    'dash-critical': {
        title: 'Critical Vulnerabilities',
        content: `
            <p>CVSS 9.0-10.0 — Immediate action required.</p>
            <p>These vulnerabilities can be exploited remotely with high impact.</p>
        `
    },
    'dash-high': {
        title: 'High Vulnerabilities',
        content: `
            <p>CVSS 7.0-8.9 — Should be prioritized for remediation.</p>
            <p>Significant risk but may require specific conditions to exploit.</p>
        `
    },
    'dash-medium': {
        title: 'Medium Vulnerabilities',
        content: `
            <p>CVSS 4.0-6.9 — Plan for remediation.</p>
            <p>Moderate risk, often requires user interaction or local access.</p>
        `
    },
    'dash-low': {
        title: 'Low Vulnerabilities',
        content: `
            <p>CVSS 0.1-3.9 — Monitor and review.</p>
            <p>Low risk, typically requires unlikely conditions to exploit.</p>
        `
    },
    'chart-report-trend': {
        title: 'Report Count Trends',
        content: `
            <p>Shows Collectors, Vulnerability Reports, and SBOM Reports over time.</p>
            <p>Collectors (dashed line, right axis): Number of clusters sending data.</p>
            <p>Reports (solid lines, left axis): Vuln and SBOM report counts.</p>
        `
    },
    'chart-severity-trend': {
        title: 'Severity Over Time',
        content: `
            <p>Stacked area chart showing vulnerability severity distribution.</p>
            <p>Monitor if critical/high vulnerabilities are increasing or decreasing.</p>
        `
    },
    'chart-severity-bar': {
        title: 'Severity Distribution',
        content: `
            <p>Current snapshot of vulnerabilities by severity level.</p>
            <p>Helps identify which severity categories need the most attention.</p>
        `
    }
};

let currentHelpTooltip = null;
let currentHelpTooltipKey = null;

function showHelpTooltip(tooltipKey, buttonElement) {
    // Toggle: if same tooltip is open, close it
    if (currentHelpTooltipKey === tooltipKey) {
        closeHelpTooltip();
        return;
    }

    // Close existing tooltip
    closeHelpTooltip();

    const tooltipData = helpTooltips[tooltipKey];
    if (!tooltipData) return;

    currentHelpTooltipKey = tooltipKey;

    const tooltip = document.createElement('div');
    tooltip.className = 'help-tooltip';
    tooltip.innerHTML = `
        <div class="help-tooltip-header">
            <span class="help-tooltip-title">${tooltipData.title}</span>
            <button class="help-tooltip-close">&times;</button>
        </div>
        <div class="help-tooltip-body">
            ${tooltipData.content}
        </div>
    `;

    document.body.appendChild(tooltip);
    currentHelpTooltip = tooltip;

    // Position tooltip near the button
    const btnRect = buttonElement.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();

    let left = btnRect.left + btnRect.width / 2 - tooltipRect.width / 2;
    let top = btnRect.bottom + 8;

    // Keep tooltip within viewport
    if (left < 10) left = 10;
    if (left + tooltipRect.width > window.innerWidth - 10) {
        left = window.innerWidth - tooltipRect.width - 10;
    }
    if (top + tooltipRect.height > window.innerHeight - 10) {
        top = btnRect.top - tooltipRect.height - 8;
    }

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;

    // Close button event
    tooltip.querySelector('.help-tooltip-close').addEventListener('click', closeHelpTooltip);
}

function closeHelpTooltip() {
    if (currentHelpTooltip) {
        currentHelpTooltip.remove();
        currentHelpTooltip = null;
        currentHelpTooltipKey = null;
    }
}

function initHelpButtons() {
    // Exclude buttons with their own handlers registered in DOMContentLoaded
    const helpBtns = document.querySelectorAll('.help-btn:not(#db-help-btn):not(#sbom-help-btn)');
    helpBtns.forEach(btn => {
        // Skip if already has listener (prevent duplicate registration)
        if (btn.dataset.listenerAttached) return;
        btn.dataset.listenerAttached = 'true';

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const tooltipKey = btn.dataset.tooltip;
            if (tooltipKey) {
                showHelpTooltip(tooltipKey, btn);
            }
        });
    });
}

// Filter Popup Functions
function initFilterButtons() {
    const filterBtns = document.querySelectorAll('.filter-btn');
    filterBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const th = btn.closest('th');
            const filterKey = th.dataset.filterKey;
            if (filterKey) {
                openFilterPopup(filterKey, btn);
            }
        });
    });
}

function openFilterPopup(filterKey, buttonElement) {
    currentFilterKey = filterKey;

    // Position popup below the button
    const rect = buttonElement.getBoundingClientRect();
    const containerRect = reportsSection.getBoundingClientRect();

    // Calculate popup position relative to container
    const popupWidth = 220; // Approximate popup width
    let left = rect.left - containerRect.left;

    // Ensure popup doesn't overflow container right edge
    if (left + popupWidth > containerRect.width) {
        left = containerRect.width - popupWidth - 10;
    }

    filterPopup.style.top = `${rect.bottom - containerRect.top + 5}px`;
    filterPopup.style.left = `${Math.max(10, left)}px`;

    // Set title
    const titles = { cluster: 'Cluster', namespace: 'Namespace', app: 'Application' };
    filterPopupTitle.textContent = titles[filterKey] || 'Filter';

    // Render content based on filter type
    renderFilterContent(filterKey);

    filterPopup.classList.remove('hidden');
}

function renderFilterContent(filterKey) {
    if (filterKey === 'cluster') {
        filterPopupBody.innerHTML = `
            <select id="filter-input">
                <option value="">All Clusters</option>
                ${clusterOptions.map(c => `
                    <option value="${escapeHtml(c.name)}" ${filters.cluster === c.name ? 'selected' : ''}>
                        ${escapeHtml(c.name)} (${c.vuln_report_count} vuln, ${c.sbom_report_count} sbom)
                    </option>
                `).join('')}
            </select>
        `;
    } else if (filterKey === 'namespace') {
        filterPopupBody.innerHTML = `
            <select id="filter-input">
                <option value="">All Namespaces</option>
                ${namespaceOptions.map(ns => `
                    <option value="${escapeHtml(ns)}" ${filters.namespace === ns ? 'selected' : ''}>
                        ${escapeHtml(ns)}
                    </option>
                `).join('')}
            </select>
        `;
    } else if (filterKey === 'app') {
        filterPopupBody.innerHTML = `
            <input type="text" id="filter-input" placeholder="Search application..." value="${escapeHtml(filters.app)}">
        `;
        // Focus and select
        setTimeout(() => {
            const input = document.getElementById('filter-input');
            input.focus();
            input.select();
            // Enter key to apply
            input.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') applyFilter();
            });
        }, 50);
    }
}

function closeFilterPopup() {
    filterPopup.classList.add('hidden');
    currentFilterKey = null;
}

function applyFilter() {
    if (!currentFilterKey) return;

    const input = document.getElementById('filter-input');
    const value = input.value;

    filters[currentFilterKey] = value;

    // If cluster changed, reload namespaces and reset namespace filter
    if (currentFilterKey === 'cluster') {
        filters.namespace = '';
        loadNamespaces();
    }

    closeFilterPopup();
    loadReports();
}

function clearFilter() {
    if (!currentFilterKey) return;

    filters[currentFilterKey] = '';

    // If cluster cleared, reload namespaces
    if (currentFilterKey === 'cluster') {
        filters.namespace = '';
        loadNamespaces();
    }

    closeFilterPopup();
    loadReports();
}

function updateFilterButtonStates() {
    const filterBtns = document.querySelectorAll('.filter-btn');
    filterBtns.forEach(btn => {
        const th = btn.closest('th');
        const filterKey = th.dataset.filterKey;
        if (filterKey && filters[filterKey]) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
}

// View switching
function showListView() {
    reportsSection.classList.remove('hidden');
    detailView.classList.add('hidden');
    versionView.classList.add('hidden');
    // Hide dashboard view if visible
    const dashboardViewEl = document.getElementById('dashboard-view');
    if (dashboardViewEl) dashboardViewEl.classList.add('hidden');
    // Update nav buttons when returning to list
    const btnDashboardEl = document.getElementById('btn-dashboard');
    if (btnDashboardEl) btnDashboardEl.classList.remove('active');

    // Show severity totals only for vuln reports, show SBOM help for SBOM reports
    const severityTotals = document.getElementById('severity-totals');
    const sbomHelpBtn = document.getElementById('sbom-help-btn');
    if (currentReportType === 'vulnerabilityreport') {
        if (severityTotals) severityTotals.classList.remove('hidden');
        if (sbomHelpBtn) sbomHelpBtn.classList.add('hidden');
    } else {
        if (severityTotals) severityTotals.classList.add('hidden');
        if (sbomHelpBtn) sbomHelpBtn.classList.remove('hidden');
    }
}

function showDetailView() {
    reportsSection.classList.add('hidden');
    detailView.classList.remove('hidden');
    versionView.classList.add('hidden');
}

// Show report detail (drill-down view)
// Current detail report for notes
let currentDetailReport = null;

async function showReportDetail(report) {
    showDetailView();
    detailTitle.textContent = `${report.cluster} / ${report.namespace} / ${report.name}`;
    detailSummary.innerHTML = '<p class="loading">Loading...</p>';
    vulnDetailThead.innerHTML = '';
    vulnDetailTbody.innerHTML = '';
    sbomDetailThead.innerHTML = '';
    sbomDetailTbody.innerHTML = '';

    try {
        const endpoint = currentReportType === 'vulnerabilityreport'
            ? `/api/v1/vulnerabilityreports/${encodeURIComponent(report.cluster)}/${encodeURIComponent(report.namespace)}/${encodeURIComponent(report.name)}`
            : `/api/v1/sbomreports/${encodeURIComponent(report.cluster)}/${encodeURIComponent(report.namespace)}/${encodeURIComponent(report.name)}`;

        const data = await fetchApi(endpoint);
        currentDetailReport = data;

        if (currentReportType === 'vulnerabilityreport') {
            renderVulnDetail(data);
        } else {
            renderSbomDetail(data);
        }

        // Render notes section
        renderNotesSection(data.meta);
    } catch (error) {
        console.error('Failed to load report detail:', error);
        detailSummary.innerHTML = '<p class="no-data">Error loading report details</p>';
    }
}

// Render notes section in detail view (read-only mode)
function renderNotesSection(meta) {
    const display = document.getElementById('notes-display');
    const textarea = document.getElementById('notes-textarea');
    const footer = document.getElementById('notes-footer');
    const actions = document.getElementById('notes-actions');

    const notes = meta.notes || '';
    textarea.value = notes;

    // Show read-only display, hide textarea
    display.classList.remove('hidden');
    textarea.classList.add('hidden');

    // Display notes or placeholder
    if (notes.trim()) {
        display.innerHTML = `<div class="notes-text">${escapeHtml(notes).replace(/\n/g, '<br>')}</div>`;
    } else {
        display.innerHTML = `<div class="notes-empty">No notes added</div>`;
    }

    // Footer with timestamps
    const createdStr = meta.notes_created_at ? formatDate(meta.notes_created_at) : '';
    const updatedStr = meta.notes_updated_at ? formatDate(meta.notes_updated_at) : '';

    if (createdStr || updatedStr) {
        footer.innerHTML = `
            <div class="notes-timestamps-inline">
                ${createdStr ? `<span>Created: ${createdStr}</span>` : ''}
                ${updatedStr && updatedStr !== createdStr ? `<span>Updated: ${updatedStr}</span>` : ''}
            </div>
        `;
    } else {
        footer.innerHTML = '';
    }

    // Edit button
    actions.innerHTML = `
        <button class="btn-secondary btn-sm" id="btn-edit-notes"><i class="fa-solid fa-pen"></i> Edit</button>
    `;

    document.getElementById('btn-edit-notes').addEventListener('click', enterNotesEditMode);
}

// Enter edit mode for notes
function enterNotesEditMode() {
    const display = document.getElementById('notes-display');
    const textarea = document.getElementById('notes-textarea');
    const actions = document.getElementById('notes-actions');

    // Hide display, show textarea
    display.classList.add('hidden');
    textarea.classList.remove('hidden');
    textarea.focus();

    // Save/Cancel buttons
    actions.innerHTML = `
        <button class="btn-secondary btn-sm" id="btn-cancel-notes"><i class="fa-solid fa-xmark"></i> Cancel</button>
        <button class="btn-primary btn-sm" id="btn-save-notes"><i class="fa-solid fa-save"></i> Save</button>
    `;

    document.getElementById('btn-cancel-notes').addEventListener('click', cancelNotesEdit);
    document.getElementById('btn-save-notes').addEventListener('click', saveDetailNotes);
}

// Cancel notes edit
function cancelNotesEdit() {
    if (currentDetailReport) {
        renderNotesSection(currentDetailReport.meta);
    }
}

// Save notes from detail view
async function saveDetailNotes() {
    if (!currentDetailReport) return;

    const meta = currentDetailReport.meta;
    const textarea = document.getElementById('notes-textarea');
    const btn = document.getElementById('btn-save-notes');
    const notes = textarea.value;

    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

    try {
        const response = await fetch(
            `/api/v1/reports/${encodeURIComponent(meta.cluster)}/${encodeURIComponent(currentReportType)}/${encodeURIComponent(meta.namespace)}/${encodeURIComponent(meta.name)}/notes`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ notes })
            }
        );

        if (response.ok) {
            // Update local data
            currentDetailReport.meta.notes = notes;
            const now = new Date().toISOString();
            if (!currentDetailReport.meta.notes_created_at && notes) {
                currentDetailReport.meta.notes_created_at = now;
            }
            if (notes) {
                currentDetailReport.meta.notes_updated_at = now;
            } else {
                currentDetailReport.meta.notes_created_at = null;
                currentDetailReport.meta.notes_updated_at = null;
            }

            // Update the list data as well
            const report = currentReports.find(r =>
                r.cluster === meta.cluster &&
                r.namespace === meta.namespace &&
                r.name === meta.name
            );
            if (report) {
                report.notes = notes;
                report.notes_created_at = currentDetailReport.meta.notes_created_at;
                report.notes_updated_at = currentDetailReport.meta.notes_updated_at;
            }

            // Re-render footer and list view (for notes indicator)
            renderNotesSection(currentDetailReport.meta);
            renderReports();

            btn.innerHTML = '<i class="fa-solid fa-check"></i> Saved';
            setTimeout(() => {
                btn.disabled = false;
                btn.innerHTML = '<i class="fa-solid fa-save"></i> Save';
            }, 1500);
        } else {
            throw new Error('Failed to save');
        }
    } catch (error) {
        console.error('Failed to save notes:', error);
        btn.innerHTML = '<i class="fa-solid fa-xmark"></i> Error';
        setTimeout(() => {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-save"></i> Save';
        }, 2000);
    }
}

function renderVulnDetail(report) {
    const vulnerabilities = report.data?.report?.vulnerabilities || [];
    const summary = report.data?.report?.summary || {};
    const apiVersion = report.data?.apiVersion || 'aquasecurity.github.io/v1alpha1';
    const kind = report.data?.kind || 'VulnerabilityReport';

    // Show vuln section, hide SBOM sections
    document.getElementById('dependency-graph-container').classList.add('hidden');
    document.getElementById('sbom-table-section').classList.remove('visible');
    document.getElementById('vuln-table-section').classList.add('visible');

    // Update section count
    document.getElementById('vuln-count').textContent = `(${vulnerabilities.length})`;

    detailSummary.innerHTML = `
        <div class="detail-summary-item">
            <span class="detail-summary-label">API Version</span>
            <span class="detail-summary-value">${escapeHtml(apiVersion)}</span>
        </div>
        <div class="detail-summary-item">
            <span class="detail-summary-label">Kind</span>
            <span class="detail-summary-value">${escapeHtml(kind)}</span>
        </div>
        <div class="detail-summary-item">
            <span class="detail-summary-label">Cluster</span>
            <span class="detail-summary-value">${escapeHtml(report.meta.cluster)}</span>
        </div>
        <div class="detail-summary-item">
            <span class="detail-summary-label">Namespace</span>
            <span class="detail-summary-value">${escapeHtml(report.meta.namespace)}</span>
        </div>
        <div class="detail-summary-item">
            <span class="detail-summary-label">Image</span>
            <span class="detail-summary-value">${escapeHtml(report.meta.image)}</span>
        </div>
        <div class="detail-summary-item">
            <span class="detail-summary-label">Total</span>
            <span class="detail-summary-value">${vulnerabilities.length}</span>
        </div>
        <div class="detail-summary-item">
            <span class="detail-summary-label">Critical</span>
            <span class="detail-summary-value" style="color: var(--critical)">${summary.criticalCount || 0}</span>
        </div>
        <div class="detail-summary-item">
            <span class="detail-summary-label">High</span>
            <span class="detail-summary-value" style="color: var(--high)">${summary.highCount || 0}</span>
        </div>
        <div class="detail-summary-item">
            <span class="detail-summary-label">Medium</span>
            <span class="detail-summary-value" style="color: var(--medium)">${summary.mediumCount || 0}</span>
        </div>
        <div class="detail-summary-item">
            <span class="detail-summary-label">Low</span>
            <span class="detail-summary-value" style="color: var(--low)">${summary.lowCount || 0}</span>
        </div>
        <div class="detail-summary-item">
            <span class="detail-summary-label">Unknown</span>
            <span class="detail-summary-value" style="color: var(--unknown)">${summary.unknownCount || 0}</span>
        </div>
    `;

    vulnDetailThead.innerHTML = `
        <tr>
            <th class="col-index">#</th>
            <th class="col-severity">Severity</th>
            <th class="col-id">CVE ID</th>
            <th class="col-score">Score</th>
            <th>Package</th>
            <th>Installed</th>
            <th>Fixed</th>
            <th>Title</th>
        </tr>
    `;

    const severityOrder = { 'CRITICAL': 0, 'HIGH': 1, 'MEDIUM': 2, 'LOW': 3, 'UNKNOWN': 4 };
    vulnerabilities.sort((a, b) => {
        return (severityOrder[a.severity] || 5) - (severityOrder[b.severity] || 5);
    });

    if (vulnerabilities.length === 0) {
        vulnDetailTbody.innerHTML = '<tr><td colspan="8" class="no-data">No vulnerabilities found</td></tr>';
        return;
    }

    vulnDetailTbody.innerHTML = vulnerabilities.map((vuln, index) => {
        const vulnId = vuln.vulnerabilityID || vuln.vulnerability_id || '-';
        const link = vuln.primaryLink || vuln.primary_link;
        const idCell = link
            ? `<a href="${escapeHtml(link)}" target="_blank">${escapeHtml(vulnId)}</a>`
            : escapeHtml(vulnId);
        const severityLabel = formatSeverityLabel(vuln.severity);
        const score = vuln.score != null ? vuln.score.toFixed(1) : '-';

        return `
            <tr>
                <td class="col-index">${index + 1}</td>
                <td class="col-severity">${severityLabel}</td>
                <td class="col-id">${idCell}</td>
                <td class="col-score">${score}</td>
                <td>${escapeHtml(vuln.resource || '-')}</td>
                <td>${escapeHtml(vuln.installedVersion || vuln.installed_version || '-')}</td>
                <td>${escapeHtml(vuln.fixedVersion || vuln.fixed_version || '-')}</td>
                <td class="text-wrap-break">${escapeHtml(vuln.title || '-')}</td>
            </tr>
        `;
    }).join('');
}

// Render dependency graph for SBOM
function renderDependencyGraph(components, dependencies) {
    const graphContainer = document.getElementById('dependency-graph-container');
    const graph = document.getElementById('dependency-graph');
    const treeSection = document.getElementById('dependency-tree-section');
    const tree = document.getElementById('dependency-tree');

    if (!components || components.length === 0) {
        graphContainer.classList.add('hidden');
        return;
    }

    graphContainer.classList.remove('hidden');

    // Group components by type
    const typeGroups = {};
    components.forEach(comp => {
        const type = comp.type || comp.component_type || 'unknown';
        if (!typeGroups[type]) {
            typeGroups[type] = [];
        }
        typeGroups[type].push(comp);
    });

    // Sort by count descending
    const sortedTypes = Object.entries(typeGroups)
        .sort((a, b) => b[1].length - a[1].length);

    const maxCount = sortedTypes[0]?.[1]?.length || 1;

    // Type colors
    const typeColors = {
        'library': '#3b82f6',
        'application': '#22c55e',
        'framework': '#f97316',
        'operating-system': '#ef4444',
        'device': '#8b5cf6',
        'file': '#6b7280',
        'container': '#06b6d4',
        'firmware': '#ec4899',
        'unknown': '#6b7280'
    };

    // Calculate total for percentages
    const total = components.length;

    // Build pie chart SVG
    const size = 180;
    const radius = 70;
    const centerX = size / 2;
    const centerY = size / 2;

    let currentAngle = -90; // Start from top
    const slices = sortedTypes.map(([type, items]) => {
        const percentage = (items.length / total) * 100;
        const angle = (percentage / 100) * 360;
        const color = typeColors[type.toLowerCase()] || typeColors['unknown'];

        const startAngle = currentAngle;
        const endAngle = currentAngle + angle;
        currentAngle = endAngle;

        // Calculate arc path
        const startRad = (startAngle * Math.PI) / 180;
        const endRad = (endAngle * Math.PI) / 180;

        const x1 = centerX + radius * Math.cos(startRad);
        const y1 = centerY + radius * Math.sin(startRad);
        const x2 = centerX + radius * Math.cos(endRad);
        const y2 = centerY + radius * Math.sin(endRad);

        const largeArc = angle > 180 ? 1 : 0;

        const pathD = `M ${centerX} ${centerY} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`;

        return { type, count: items.length, percentage, color, pathD };
    });

    const pieChart = `
        <svg class="pie-chart" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
            ${slices.map(s => `<path d="${s.pathD}" fill="${s.color}" class="pie-slice" data-type="${escapeHtml(s.type)}" data-count="${s.count}"/>`).join('')}
            <circle cx="${centerX}" cy="${centerY}" r="40" fill="var(--bg-secondary)" />
            <text x="${centerX}" y="${centerY - 6}" text-anchor="middle" class="pie-total-count">${total}</text>
            <text x="${centerX}" y="${centerY + 10}" text-anchor="middle" class="pie-total-label">Total</text>
        </svg>
    `;

    const legend = `
        <div class="pie-legend">
            ${slices.map(s => `
                <div class="pie-legend-item">
                    <span class="pie-legend-color" style="background-color: ${s.color}"></span>
                    <span class="pie-legend-label">${escapeHtml(s.type)}</span>
                    <span class="pie-legend-value">${s.count} (${s.percentage.toFixed(1)}%)</span>
                </div>
            `).join('')}
        </div>
    `;

    graph.innerHTML = `
        <div class="pie-container">
            ${pieChart}
            ${legend}
        </div>
    `;

    // Render Cytoscape dependency graph
    renderCytoscapeGraph(components, dependencies);
}

// Global Cytoscape instance
let cyInstance = null;

// Render Cytoscape dependency graph
function renderCytoscapeGraph(components, dependencies) {
    const treeSection = document.getElementById('dependency-tree-section');
    const container = document.getElementById('cytoscape-graph');

    if (!dependencies || dependencies.length === 0) {
        treeSection.style.display = 'none';
        return;
    }

    treeSection.style.display = 'block';

    // Build component lookup map by bom-ref
    const componentMap = {};
    components.forEach(comp => {
        const ref = comp['bom-ref'] || comp.bomRef || comp.bom_ref;
        if (ref) {
            componentMap[ref] = comp;
        }
    });

    // Build nodes and edges for Cytoscape
    const nodes = [];
    const edges = [];
    const nodeIds = new Set();

    // Type colors for nodes
    const typeColors = {
        'library': '#3b82f6',
        'application': '#22c55e',
        'framework': '#f97316',
        'operating-system': '#ef4444',
        'device': '#8b5cf6',
        'file': '#6b7280',
        'container': '#06b6d4',
        'firmware': '#ec4899',
        'unknown': '#888888'
    };

    // Limit nodes for performance (max 100)
    const maxNodes = 100;
    let nodeCount = 0;

    // Add nodes from dependencies
    dependencies.forEach(dep => {
        if (nodeCount >= maxNodes) return;

        const ref = dep.ref;
        const dependsOn = dep.dependsOn || [];

        if (!nodeIds.has(ref)) {
            const comp = componentMap[ref];
            const name = comp?.name || ref.split('/').pop() || ref;
            const version = comp?.version || '';
            const type = (comp?.type || comp?.component_type || 'unknown').toLowerCase();
            const color = typeColors[type] || typeColors['unknown'];

            nodes.push({
                data: {
                    id: ref,
                    label: version ? `${name}\n${version}` : name,
                    name: name,
                    version: version,
                    type: type,
                    color: color,
                    dependencyCount: dependsOn.length
                }
            });
            nodeIds.add(ref);
            nodeCount++;
        }

        // Add edges and dependent nodes
        dependsOn.forEach(depRef => {
            if (nodeCount >= maxNodes) return;

            if (!nodeIds.has(depRef)) {
                const comp = componentMap[depRef];
                const name = comp?.name || depRef.split('/').pop() || depRef;
                const version = comp?.version || '';
                const type = (comp?.type || comp?.component_type || 'unknown').toLowerCase();
                const color = typeColors[type] || typeColors['unknown'];

                nodes.push({
                    data: {
                        id: depRef,
                        label: version ? `${name}\n${version}` : name,
                        name: name,
                        version: version,
                        type: type,
                        color: color,
                        dependencyCount: 0
                    }
                });
                nodeIds.add(depRef);
                nodeCount++;
            }

            edges.push({
                data: {
                    id: `${ref}->${depRef}`,
                    source: ref,
                    target: depRef
                }
            });
        });
    });

    if (nodes.length === 0) {
        container.innerHTML = '<p class="no-data" style="padding: 20px; text-align: center;">No dependency data available</p>';
        return;
    }

    // Destroy previous instance
    if (cyInstance) {
        cyInstance.destroy();
    }

    // Initialize Cytoscape
    cyInstance = cytoscape({
        container: container,
        elements: { nodes, edges },
        style: [
            {
                selector: 'node',
                style: {
                    'background-color': 'data(color)',
                    'label': 'data(label)',
                    'color': '#f5f5f5',
                    'text-valign': 'bottom',
                    'text-halign': 'center',
                    'font-size': '10px',
                    'text-margin-y': 6,
                    'width': 30,
                    'height': 30,
                    'text-wrap': 'wrap',
                    'text-max-width': '80px',
                    'border-width': 2,
                    'border-color': '#2a2a2a'
                }
            },
            {
                selector: 'node:selected',
                style: {
                    'border-color': '#f97316',
                    'border-width': 3
                }
            },
            {
                selector: 'edge',
                style: {
                    'width': 1.5,
                    'line-color': '#555',
                    'target-arrow-color': '#555',
                    'target-arrow-shape': 'triangle',
                    'curve-style': 'bezier',
                    'arrow-scale': 0.8
                }
            },
            {
                selector: 'edge:selected',
                style: {
                    'line-color': '#f97316',
                    'target-arrow-color': '#f97316'
                }
            }
        ],
        layout: {
            name: 'fcose',
            quality: 'proof',
            randomize: true,
            animate: false,
            fit: true,
            padding: 30,
            nodeRepulsion: 8000,
            idealEdgeLength: 80,
            edgeElasticity: 0.45,
            nestingFactor: 0.1,
            numIter: 2500,
            tile: true,
            tilingPaddingVertical: 20,
            tilingPaddingHorizontal: 20
        },
        minZoom: 0.1,
        maxZoom: 3
    });

    // Tooltip on hover
    cyInstance.on('mouseover', 'node', (event) => {
        const node = event.target;
        const data = node.data();
        node.style('border-color', '#f97316');
        container.title = `${data.name} ${data.version ? 'v' + data.version : ''}\nType: ${data.type}\nDependencies: ${data.dependencyCount}`;
    });

    cyInstance.on('mouseout', 'node', (event) => {
        const node = event.target;
        if (!node.selected()) {
            node.style('border-color', '#2a2a2a');
        }
        container.title = '';
    });

    // Zoom controls
    document.getElementById('graph-zoom-in').onclick = () => {
        cyInstance.zoom(cyInstance.zoom() * 1.2);
        cyInstance.center();
    };
    document.getElementById('graph-zoom-out').onclick = () => {
        cyInstance.zoom(cyInstance.zoom() / 1.2);
        cyInstance.center();
    };
    document.getElementById('graph-fit').onclick = () => {
        cyInstance.fit();
    };
    document.getElementById('graph-save').onclick = () => {
        const png = cyInstance.png({ full: true, scale: 2, bg: '#161616' });
        const link = document.createElement('a');
        link.href = png;
        link.download = 'dependency-graph.png';
        link.click();
    };
}

function renderSbomDetail(report) {
    const componentsData = report.data?.report?.components || {};
    const components = componentsData.components || [];
    // CycloneDX dependencies can be at different paths
    const dependencies = componentsData.dependencies
        || report.data?.report?.dependencies
        || report.data?.dependencies
        || [];

    const summary = report.data?.report?.summary || {};
    const scanner = report.data?.report?.scanner || {};
    const registry = report.data?.report?.registry || {};
    const artifact = report.data?.report?.artifact || {};
    const apiVersion = report.data?.apiVersion || 'aquasecurity.github.io/v1alpha1';
    const kind = report.data?.kind || 'SbomReport';

    // Get full image with registry
    const fullImage = registry.server
        ? `${registry.server}/${artifact.repository}:${artifact.tag}`
        : report.meta.image;

    // Render dependency graph and tree
    renderDependencyGraph(components, dependencies);

    // Show SBOM section, hide vuln section
    document.getElementById('sbom-table-section').classList.add('visible');
    document.getElementById('vuln-table-section').classList.remove('visible');

    // Update section count
    document.getElementById('sbom-count').textContent = `(${components.length})`;

    detailSummary.innerHTML = `
        <div class="detail-summary-item">
            <span class="detail-summary-label">API Version</span>
            <span class="detail-summary-value">${escapeHtml(apiVersion)}</span>
        </div>
        <div class="detail-summary-item">
            <span class="detail-summary-label">Kind</span>
            <span class="detail-summary-value">${escapeHtml(kind)}</span>
        </div>
        <div class="detail-summary-item">
            <span class="detail-summary-label">Cluster</span>
            <span class="detail-summary-value">${escapeHtml(report.meta.cluster)}</span>
        </div>
        <div class="detail-summary-item">
            <span class="detail-summary-label">Namespace</span>
            <span class="detail-summary-value">${escapeHtml(report.meta.namespace)}</span>
        </div>
        <div class="detail-summary-item">
            <span class="detail-summary-label">Image</span>
            <span class="detail-summary-value">${escapeHtml(fullImage)}</span>
        </div>
        <div class="detail-summary-item">
            <span class="detail-summary-label">Components</span>
            <span class="detail-summary-value">${components.length}</span>
        </div>
        <div class="detail-summary-item">
            <span class="detail-summary-label">Dependencies</span>
            <span class="detail-summary-value">${summary.dependenciesCount || 0}</span>
        </div>
        <div class="detail-summary-item">
            <span class="detail-summary-label">BOM Format <button class="help-btn" data-tooltip="bomformat" title="What is BOM Format?"><i class="fa-solid fa-info"></i></button></span>
            <span class="detail-summary-value">${escapeHtml(componentsData.bomFormat || '-')} ${escapeHtml(componentsData.specVersion || '')}</span>
        </div>
        <div class="detail-summary-item">
            <span class="detail-summary-label">Scanner</span>
            <span class="detail-summary-value">${escapeHtml(scanner.name || '-')} ${escapeHtml(scanner.version || '')}</span>
        </div>
    `;

    sbomDetailThead.innerHTML = `
        <tr>
            <th class="col-index">#</th>
            <th>Name</th>
            <th>Version</th>
            <th>Type</th>
            <th>License</th>
            <th>PURL <button class="help-btn" data-tooltip="purl" title="What is PURL?"><i class="fa-solid fa-info"></i></button></th>
        </tr>
    `;

    if (components.length === 0) {
        sbomDetailTbody.innerHTML = '<tr><td colspan="6" class="no-data">No components found</td></tr>';
        return;
    }

    sbomDetailTbody.innerHTML = components.map((comp, index) => {
        // Extract license names
        const licenses = (comp.licenses || [])
            .map(l => l.license?.name || l.name || '')
            .filter(Boolean)
            .join(', ') || '-';

        return `
            <tr>
                <td class="col-index">${index + 1}</td>
                <td>${escapeHtml(comp.name || '-')}</td>
                <td>${escapeHtml(comp.version || '-')}</td>
                <td>${escapeHtml(comp.type || comp.component_type || '-')}</td>
                <td>${escapeHtml(licenses)}</td>
                <td class="text-wrap-break">${escapeHtml(comp.purl || '-')}</td>
            </tr>
        `;
    }).join('');

    // Initialize help buttons after rendering
    initHelpButtons();
}

// Column sorting
function initSortableColumns() {
    const headers = document.querySelectorAll('th.sortable');
    headers.forEach(header => {
        // Remove existing listener to prevent duplicates
        const newHeader = header.cloneNode(true);
        header.parentNode.replaceChild(newHeader, header);

        newHeader.addEventListener('click', (e) => {
            // Don't sort if clicking filter button
            if (e.target.classList.contains('filter-btn')) return;
            const columnKey = newHeader.dataset.sortKey;
            if (columnKey) {
                handleSort(columnKey);
            }
        });
    });
}

function handleSort(column) {
    if (sortColumn === column) {
        // Toggle direction on same column
        sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        // First click on new column: start with ascending
        sortColumn = column;
        sortDirection = 'asc';
    }

    updateSortIndicators();
    sortReports();
    renderReports();
}

function updateSortIndicators() {
    const headers = document.querySelectorAll('th.sortable');
    headers.forEach(header => {
        const icon = header.querySelector('.sort-icon');
        if (icon) {
            if (header.dataset.sortKey === sortColumn) {
                icon.className = sortDirection === 'desc'
                    ? 'fa-solid fa-sort-down sort-icon'
                    : 'fa-solid fa-sort-up sort-icon';
                header.classList.add('sorted');
            } else {
                icon.className = 'fa-solid fa-sort sort-icon';
                header.classList.remove('sorted');
            }
        }
    });
}

function sortReports() {
    if (!sortColumn) return;

    currentReports.sort((a, b) => {
        let aVal, bVal;

        if (sortColumn === 'cluster') {
            aVal = (a.cluster || '').toLowerCase();
            bVal = (b.cluster || '').toLowerCase();
            if (sortDirection === 'desc') {
                return bVal.localeCompare(aVal);
            } else {
                return aVal.localeCompare(bVal);
            }
        } else if (sortColumn === 'namespace') {
            aVal = (a.namespace || '').toLowerCase();
            bVal = (b.namespace || '').toLowerCase();
            if (sortDirection === 'desc') {
                return bVal.localeCompare(aVal);
            } else {
                return aVal.localeCompare(bVal);
            }
        } else if (sortColumn === 'components') {
            // SBOM components count sorting
            aVal = a.components_count || 0;
            bVal = b.components_count || 0;
            if (sortDirection === 'desc') {
                return bVal - aVal;
            } else {
                return aVal - bVal;
            }
        } else if (sortColumn === 'updated_at') {
            // Date sorting
            aVal = a.updated_at ? new Date(a.updated_at).getTime() : 0;
            bVal = b.updated_at ? new Date(b.updated_at).getTime() : 0;
            if (sortDirection === 'desc') {
                return bVal - aVal;
            } else {
                return aVal - bVal;
            }
        } else {
            // Vulnerability severity columns (numeric)
            if (currentReportType !== 'vulnerabilityreport') return 0;
            aVal = a.summary?.[sortColumn] || 0;
            bVal = b.summary?.[sortColumn] || 0;
            if (sortDirection === 'desc') {
                return bVal - aVal;
            } else {
                return aVal - bVal;
            }
        }
    });
}

// CSV Export
function exportToCsv() {
    if (currentReports.length === 0) return;

    let csvContent = '';
    let filename = '';

    if (currentReportType === 'vulnerabilityreport') {
        // Vulnerability report CSV
        csvContent = 'Cluster,Namespace,Application,Image,Critical,High,Medium,Low,Unknown,Updated\n';
        currentReports.forEach(report => {
            const summary = report.summary || {};
            csvContent += [
                escapeCsvField(report.cluster),
                escapeCsvField(report.namespace),
                escapeCsvField(report.app || ''),
                escapeCsvField(report.image || ''),
                summary.critical || 0,
                summary.high || 0,
                summary.medium || 0,
                summary.low || 0,
                summary.unknown || 0,
                report.updated_at || ''
            ].join(',') + '\n';
        });
        filename = `trivy-collector-vuln-${formatDateForFilename()}-${randomHash()}.csv`;
    } else {
        // SBOM report CSV
        csvContent = 'Cluster,Namespace,Application,Image,Components,Updated\n';
        currentReports.forEach(report => {
            csvContent += [
                escapeCsvField(report.cluster),
                escapeCsvField(report.namespace),
                escapeCsvField(report.app || ''),
                escapeCsvField(report.image || ''),
                report.components_count || 0,
                report.updated_at || ''
            ].join(',') + '\n';
        });
        filename = `trivy-collector-sbom-${formatDateForFilename()}-${randomHash()}.csv`;
    }

    downloadCsv(csvContent, filename);
}

function escapeCsvField(field) {
    if (field == null) return '';
    const str = String(field);
    // Escape quotes and wrap in quotes if contains comma, quote, or newline
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

function formatDateForFilename() {
    const now = new Date();
    return now.toISOString().slice(0, 10);
}

function randomHash() {
    return Math.random().toString(36).substring(2, 8);
}

function downloadCsv(content, filename) {
    const blob = new Blob(['\ufeff' + content], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
}

// Export detail to JSON (dispatches based on report type)
function exportDetailToJson() {
    if (currentReportType === 'vulnerabilityreport') {
        exportVulnDetailToJson();
    } else {
        exportSbomDetailToJson();
    }
}

// JSON Download helper
function downloadJson(data, filename) {
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
}

// Export vulnerability detail to JSON
function exportVulnDetailToJson() {
    if (!currentDetailReport) return;

    const report = currentDetailReport;
    const meta = report.meta;
    const vulnerabilities = report.data?.report?.vulnerabilities || [];
    const summary = report.data?.report?.summary || {};
    const apiVersion = report.data?.apiVersion || 'aquasecurity.github.io/v1alpha1';
    const kind = report.data?.kind || 'VulnerabilityReport';

    // Sort vulnerabilities by severity
    const severityOrder = { 'CRITICAL': 0, 'HIGH': 1, 'MEDIUM': 2, 'LOW': 3, 'UNKNOWN': 4 };
    const sortedVulns = [...vulnerabilities].sort((a, b) => {
        return (severityOrder[a.severity] || 5) - (severityOrder[b.severity] || 5);
    });

    const exportData = {
        exported_at: new Date().toISOString(),
        report_type: kind,
        summary: {
            api_version: apiVersion,
            cluster: meta.cluster,
            namespace: meta.namespace,
            name: meta.name,
            image: meta.image,
            total_vulnerabilities: vulnerabilities.length,
            critical: summary.criticalCount || 0,
            high: summary.highCount || 0,
            medium: summary.mediumCount || 0,
            low: summary.lowCount || 0,
            unknown: summary.unknownCount || 0
        },
        notes: {
            content: meta.notes || null,
            created_at: meta.notes_created_at || null,
            updated_at: meta.notes_updated_at || null
        },
        vulnerabilities: sortedVulns.map((vuln, idx) => ({
            index: idx + 1,
            severity: vuln.severity || '',
            vulnerability_id: vuln.vulnerabilityID || vuln.vulnerability_id || '',
            score: vuln.score != null ? vuln.score : null,
            resource: vuln.resource || '',
            installed_version: vuln.installedVersion || vuln.installed_version || '',
            fixed_version: vuln.fixedVersion || vuln.fixed_version || '',
            title: vuln.title || '',
            primary_link: vuln.primaryLink || vuln.primary_link || ''
        }))
    };

    const filename = `trivy-vuln-${meta.cluster}-${meta.namespace}-${meta.name}-${formatDateForFilename()}.json`;
    downloadJson(exportData, filename);
}

// Export SBOM detail to JSON
function exportSbomDetailToJson() {
    if (!currentDetailReport) return;

    const report = currentDetailReport;
    const meta = report.meta;
    const componentsData = report.data?.report?.components || {};
    const components = componentsData.components || [];
    const dependencies = componentsData.dependencies
        || report.data?.report?.dependencies
        || report.data?.dependencies
        || [];
    const summary = report.data?.report?.summary || {};
    const scanner = report.data?.report?.scanner || {};
    const registry = report.data?.report?.registry || {};
    const artifact = report.data?.report?.artifact || {};
    const apiVersion = report.data?.apiVersion || 'aquasecurity.github.io/v1alpha1';
    const kind = report.data?.kind || 'SbomReport';

    // Get full image with registry
    const fullImage = registry.server
        ? `${registry.server}/${artifact.repository}:${artifact.tag}`
        : meta.image;

    // Calculate component distribution
    const typeGroups = {};
    components.forEach(comp => {
        const type = comp.type || comp.component_type || 'unknown';
        if (!typeGroups[type]) {
            typeGroups[type] = 0;
        }
        typeGroups[type]++;
    });

    const totalComponents = components.length;
    const componentDistribution = Object.entries(typeGroups)
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => ({
            type,
            count,
            percentage: totalComponents > 0 ? parseFloat(((count / totalComponents) * 100).toFixed(1)) : 0
        }));

    const exportData = {
        exported_at: new Date().toISOString(),
        report_type: kind,
        summary: {
            api_version: apiVersion,
            cluster: meta.cluster,
            namespace: meta.namespace,
            name: meta.name,
            image: fullImage,
            bom_format: componentsData.bomFormat || null,
            spec_version: componentsData.specVersion || null,
            scanner: scanner.name ? {
                name: scanner.name,
                version: scanner.version || null
            } : null,
            total_components: totalComponents,
            total_dependencies: summary.dependenciesCount || dependencies.length || 0
        },
        notes: {
            content: meta.notes || null,
            created_at: meta.notes_created_at || null,
            updated_at: meta.notes_updated_at || null
        },
        component_distribution: componentDistribution,
        components: components.map((comp, idx) => {
            const licenses = (comp.licenses || [])
                .map(l => l.license?.name || l.name || '')
                .filter(Boolean);

            return {
                index: idx + 1,
                name: comp.name || '',
                version: comp.version || '',
                type: comp.type || comp.component_type || '',
                licenses: licenses.length > 0 ? licenses : null,
                purl: comp.purl || null,
                bom_ref: comp['bom-ref'] || comp.bomRef || comp.bom_ref || null
            };
        })
    };

    const filename = `trivy-sbom-${meta.cluster}-${meta.namespace}-${meta.name}-${formatDateForFilename()}.json`;
    downloadJson(exportData, filename);
}

// ============================================
// Dashboard Functions
// ============================================

// Dashboard State
let dashboardCharts = {
    reportTrend: null,
    severityTrend: null,
    severityBar: null
};
let dashboardData = null;
let dashboardRefreshInterval = null;
let dashboardCountdownInterval = null;
let dashboardAutoRefresh = true;
let dashboardRefreshSeconds = 30;
const DASHBOARD_REFRESH_INTERVAL = 30;

// Dashboard DOM Elements (initialized after DOM load)
let dashboardView = null;
let btnDashboard = null;
let btnDashboardBack = null;
let dropdownRange = null;
let dropdownCluster = null;
let btnRefreshToggle = null;
let btnRefreshNow = null;

// Initialize Dashboard Event Listeners (called from DOMContentLoaded)
function initDashboardEventListeners() {
    dashboardView = document.getElementById('dashboard-view');
    btnDashboard = document.getElementById('btn-dashboard');
    btnDashboardBack = document.getElementById('btn-dashboard-back');
    dropdownRange = document.getElementById('dropdown-range');
    dropdownCluster = document.getElementById('dropdown-cluster');
    btnRefreshToggle = document.getElementById('btn-refresh-toggle');

    if (btnDashboard) {
        btnDashboard.addEventListener('click', showDashboardView);
    }
    if (btnDashboardBack) {
        btnDashboardBack.addEventListener('click', hideDashboardView);
    }
    if (btnRefreshToggle) {
        btnRefreshToggle.addEventListener('click', toggleDashboardRefresh);
    }

    btnRefreshNow = document.getElementById('btn-refresh-now');
    if (btnRefreshNow) {
        btnRefreshNow.addEventListener('click', manualRefreshDashboard);
    }

    const btnExportPng = document.getElementById('btn-export-png');
    if (btnExportPng) {
        btnExportPng.addEventListener('click', exportDashboardPng);
    }

    // Initialize custom dropdowns
    initCustomDropdown(dropdownRange, loadDashboardData);
    initCustomDropdown(dropdownCluster, loadDashboardData);

    // Close dropdowns when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.custom-dropdown')) {
            closeAllDropdowns();
        }
    });
}

// Initialize a custom dropdown
function initCustomDropdown(dropdown, onChange) {
    if (!dropdown) return;

    const toggle = dropdown.querySelector('.dropdown-toggle');
    const menu = dropdown.querySelector('.dropdown-menu');
    const items = dropdown.querySelectorAll('.dropdown-item');

    toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = dropdown.classList.contains('open');
        closeAllDropdowns();
        if (!isOpen) {
            dropdown.classList.add('open');
            menu.classList.remove('hidden');
        }
    });

    items.forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            const value = item.dataset.value;
            const text = item.textContent;

            // Update selected state
            items.forEach(i => i.classList.remove('selected'));
            item.classList.add('selected');

            // Update toggle button
            toggle.dataset.value = value;
            toggle.querySelector('.dropdown-text').textContent = text;

            // Close dropdown
            dropdown.classList.remove('open');
            menu.classList.add('hidden');

            // Trigger change callback
            if (onChange) onChange();
        });
    });
}

// Close all dropdowns
function closeAllDropdowns() {
    document.querySelectorAll('.custom-dropdown').forEach(d => {
        d.classList.remove('open');
        d.querySelector('.dropdown-menu')?.classList.add('hidden');
    });
}

// Get dropdown value
function getDropdownValue(dropdown) {
    if (!dropdown) return '';
    return dropdown.querySelector('.dropdown-toggle')?.dataset.value || '';
}

// Show Dashboard View
function showDashboardView() {
    reportsSection.classList.add('hidden');
    detailView.classList.add('hidden');
    versionView.classList.add('hidden');
    dashboardView.classList.remove('hidden');

    // Update nav buttons
    btnVuln.classList.remove('active');
    btnSbom.classList.remove('active');
    btnDashboard.classList.add('active');

    // Initialize help buttons for dashboard
    initHelpButtons();

    // Populate cluster filter
    populateDashboardClusters();

    // Load dashboard data
    loadDashboardData();

    // Start auto-refresh if enabled
    if (dashboardAutoRefresh) {
        startDashboardRefresh();
    }
}

// Hide Dashboard View
function hideDashboardView() {
    dashboardView.classList.add('hidden');
    reportsSection.classList.remove('hidden');

    // Update nav buttons
    btnDashboard.classList.remove('active');
    if (currentReportType === 'vulnerabilityreport') {
        btnVuln.classList.add('active');
    } else {
        btnSbom.classList.add('active');
    }

    // Stop auto-refresh
    stopDashboardRefresh();
}

// Populate cluster dropdown
async function populateDashboardClusters() {
    try {
        const data = await fetchApi('/api/v1/clusters');
        const menu = dropdownCluster?.querySelector('.dropdown-menu');
        if (!menu) return;

        // Clear and rebuild menu
        menu.innerHTML = '<div class="dropdown-item selected" data-value="">All Clusters</div>';

        if (data.items) {
            data.items.forEach(cluster => {
                const item = document.createElement('div');
                item.className = 'dropdown-item';
                item.dataset.value = cluster.name;
                item.textContent = cluster.name;
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    // Update selected state
                    menu.querySelectorAll('.dropdown-item').forEach(i => i.classList.remove('selected'));
                    item.classList.add('selected');
                    // Update toggle
                    const toggle = dropdownCluster.querySelector('.dropdown-toggle');
                    toggle.dataset.value = cluster.name;
                    toggle.querySelector('.dropdown-text').textContent = cluster.name;
                    // Close and reload
                    closeAllDropdowns();
                    loadDashboardData();
                });
                menu.appendChild(item);
            });
        }

        // Re-attach click handler for "All Clusters"
        const allClustersItem = menu.querySelector('.dropdown-item[data-value=""]');
        if (allClustersItem) {
            allClustersItem.addEventListener('click', (e) => {
                e.stopPropagation();
                menu.querySelectorAll('.dropdown-item').forEach(i => i.classList.remove('selected'));
                allClustersItem.classList.add('selected');
                const toggle = dropdownCluster.querySelector('.dropdown-toggle');
                toggle.dataset.value = '';
                toggle.querySelector('.dropdown-text').textContent = 'All Clusters';
                closeAllDropdowns();
                loadDashboardData();
            });
        }
    } catch (error) {
        console.error('Failed to load clusters for dashboard:', error);
    }
}

// Load Dashboard Data
async function loadDashboardData() {
    const range = getDropdownValue(dropdownRange) || '30d';
    const cluster = getDropdownValue(dropdownCluster);

    try {
        const params = new URLSearchParams({ range });
        if (cluster) params.append('cluster', cluster);

        // Fetch both trend data and current stats in parallel
        const [trendData, statsData] = await Promise.all([
            fetchApi(`/api/v1/dashboard/trends?${params}`),
            fetchApi('/api/v1/stats')
        ]);

        dashboardData = trendData;
        renderDashboard(trendData, statsData);
    } catch (error) {
        console.error('Failed to load dashboard data:', error);
    }
}

// Render Dashboard
function renderDashboard(data, stats) {
    updateDataRangeInfo(data);
    updateDashboardSummary(data, stats);
    renderReportTrendChart(data);
    renderSeverityTrendChart(data);
    renderSeverityBarChart(data, stats);
}

// Update data range info in header
function updateDataRangeInfo(data) {
    const infoEl = document.getElementById('data-range-info');
    if (!infoEl) return;

    const dataFrom = data?.meta?.data_from;
    const dataTo = data?.meta?.data_to;

    if (dataFrom && dataTo && dataFrom !== 'null' && dataTo !== 'null') {
        infoEl.innerHTML = `<i class="fa-solid fa-database"></i> Retention: ${dataFrom} ~ ${dataTo}`;
    } else if (data?.series?.length > 0) {
        // Fallback: use series data range
        const firstDate = data.series[0]?.date;
        const lastDate = data.series[data.series.length - 1]?.date;
        if (firstDate && lastDate) {
            infoEl.innerHTML = `<i class="fa-solid fa-database"></i> Retention: ${firstDate} ~ ${lastDate}`;
        } else {
            infoEl.innerHTML = `<i class="fa-solid fa-database"></i> Collecting data...`;
        }
    } else {
        infoEl.innerHTML = `<i class="fa-solid fa-database"></i> Collecting data...`;
    }
}

// Update Summary Cards
function updateDashboardSummary(data, stats) {
    // Use current stats for totals (matches Vulnerabilities page)
    if (stats) {
        document.getElementById('dash-collectors').textContent = (stats.total_clusters || 0).toLocaleString();
        document.getElementById('dash-vuln-reports').textContent = (stats.total_vuln_reports || 0).toLocaleString();
        document.getElementById('dash-sbom-reports').textContent = (stats.total_sbom_reports || 0).toLocaleString();
        document.getElementById('dash-critical').textContent = (stats.total_critical || 0).toLocaleString();
        document.getElementById('dash-high').textContent = (stats.total_high || 0).toLocaleString();
        document.getElementById('dash-medium').textContent = (stats.total_medium || 0).toLocaleString();
        document.getElementById('dash-low').textContent = (stats.total_low || 0).toLocaleString();
    } else {
        document.getElementById('dash-collectors').textContent = '0';
        document.getElementById('dash-vuln-reports').textContent = '0';
        document.getElementById('dash-sbom-reports').textContent = '0';
        document.getElementById('dash-critical').textContent = '0';
        document.getElementById('dash-high').textContent = '0';
        document.getElementById('dash-medium').textContent = '0';
        document.getElementById('dash-low').textContent = '0';
    }

    // Collectors change indicator (use meta.clusters length if available)
    const currentClusters = data?.meta?.clusters?.length || 0;
    const collectorsChangeEl = document.getElementById('dash-collectors-change');
    if (collectorsChangeEl) {
        collectorsChangeEl.textContent = '-';
        collectorsChangeEl.className = 'summary-change neutral';
    }

    // Calculate trend changes from time series data
    if (data?.series?.length >= 2) {
        const first = data.series[0];
        const latest = data.series[data.series.length - 1];

        updateChangeIndicator('dash-vuln-change', latest.vuln_reports, first.vuln_reports);
        updateChangeIndicator('dash-sbom-change', latest.sbom_reports, first.sbom_reports);
        updateChangeIndicator('dash-critical-change', latest.critical, first.critical, true);
        updateChangeIndicator('dash-high-change', latest.high, first.high, true);
        updateChangeIndicator('dash-medium-change', latest.medium, first.medium, true);
        updateChangeIndicator('dash-low-change', latest.low, first.low, true);
    } else {
        // No trend data, clear change indicators
        ['dash-vuln-change', 'dash-sbom-change', 'dash-critical-change', 'dash-high-change', 'dash-medium-change', 'dash-low-change'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.textContent = '-';
                el.className = 'summary-change neutral';
            }
        });
    }
}

// Update change indicator
function updateChangeIndicator(elementId, current, previous, inversePositive = false) {
    const element = document.getElementById(elementId);
    if (!element) return;

    const change = current - previous;
    const percentChange = previous === 0 ? 0 : Math.round((change / previous) * 100);

    element.className = 'summary-change';
    if (change > 0) {
        element.textContent = `+${percentChange}%`;
        element.classList.add(inversePositive ? 'negative' : 'positive');
    } else if (change < 0) {
        element.textContent = `${percentChange}%`;
        element.classList.add(inversePositive ? 'positive' : 'negative');
    } else {
        element.textContent = '0%';
        element.classList.add('neutral');
    }
}

// Chart.js default options for dark theme
const chartDefaultOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
        mode: 'index',
        intersect: false
    },
    plugins: {
        legend: {
            position: 'bottom',
            align: 'start',
            labels: {
                color: '#9ca3af',
                font: { size: 11, family: 'Inter, sans-serif' },
                padding: 16,
                usePointStyle: true,
                pointStyle: 'line',
                boxWidth: 16,
                boxHeight: 2
            }
        },
        tooltip: {
            enabled: true,
            mode: 'index',
            intersect: false,
            backgroundColor: 'rgba(24, 24, 27, 0.95)',
            titleColor: '#f4f4f5',
            titleFont: { size: 12, weight: 'bold' },
            bodyColor: '#a1a1aa',
            bodyFont: { size: 11 },
            borderColor: '#3f3f46',
            borderWidth: 1,
            padding: 12,
            cornerRadius: 6,
            displayColors: true,
            boxWidth: 12,
            boxHeight: 12,
            boxPadding: 4,
            usePointStyle: true,
            callbacks: {
                label: function(context) {
                    const label = context.dataset.label || '';
                    const value = context.parsed.y;
                    return ` ${label}: ${value.toLocaleString()}`;
                }
            }
        }
    },
    scales: {
        x: {
            grid: { color: '#2a2a2a' },
            ticks: { color: '#808080', font: { size: 10 } }
        },
        y: {
            grid: { color: '#2a2a2a' },
            ticks: { color: '#808080', font: { size: 10 } },
            beginAtZero: true
        }
    }
};

// Format chart labels based on granularity
function formatChartLabels(series, granularity) {
    return series.map(s => {
        if (granularity === 'hourly' && s.date.includes(' ')) {
            // Format "2025-01-13 14:00" to "14:00"
            return s.date.split(' ')[1];
        }
        // For daily, show shorter date format
        if (s.date.length === 10) {
            // Format "2025-01-13" to "01-13"
            return s.date.substring(5);
        }
        return s.date;
    });
}

// Render Report Trend Chart
function renderReportTrendChart(data) {
    const ctx = document.getElementById('report-trend-chart');
    if (!ctx) return;

    if (dashboardCharts.reportTrend) {
        dashboardCharts.reportTrend.destroy();
    }

    const granularity = data.meta?.granularity || 'daily';
    const labels = formatChartLabels(data.series, granularity);

    dashboardCharts.reportTrend = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Collectors',
                    data: data.series.map(s => s.clusters_count || 0),
                    borderColor: '#6b7280',
                    backgroundColor: 'transparent',
                    fill: false,
                    tension: 0.3,
                    borderDash: [4, 4],
                    borderWidth: 2,
                    pointRadius: 0,
                    yAxisID: 'y1'
                },
                {
                    label: 'Vulnerability Reports',
                    data: data.series.map(s => s.vuln_reports),
                    borderColor: '#3b82f6',
                    backgroundColor: 'rgba(59, 130, 246, 0.1)',
                    fill: true,
                    tension: 0.3,
                    borderWidth: 2,
                    pointRadius: 0
                },
                {
                    label: 'SBOM Reports',
                    data: data.series.map(s => s.sbom_reports),
                    borderColor: '#8b5cf6',
                    backgroundColor: 'rgba(139, 92, 246, 0.1)',
                    fill: true,
                    tension: 0.3,
                    borderWidth: 2,
                    pointRadius: 0
                }
            ]
        },
        options: {
            ...chartDefaultOptions,
            scales: {
                ...chartDefaultOptions.scales,
                y1: {
                    type: 'linear',
                    display: true,
                    position: 'right',
                    title: {
                        display: true,
                        text: 'Collectors',
                        color: '#9ca3af'
                    },
                    ticks: { color: '#9ca3af' },
                    grid: { display: false }
                }
            }
        }
    });
}

// Render Severity Trend Chart
function renderSeverityTrendChart(data) {
    const ctx = document.getElementById('severity-trend-chart');
    if (!ctx) return;

    if (dashboardCharts.severityTrend) {
        dashboardCharts.severityTrend.destroy();
    }

    const granularity = data.meta?.granularity || 'daily';
    const labels = formatChartLabels(data.series, granularity);

    dashboardCharts.severityTrend = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Critical',
                    data: data.series.map(s => s.critical),
                    borderColor: '#ef4444',
                    backgroundColor: 'rgba(239, 68, 68, 0.15)',
                    fill: true,
                    tension: 0.3,
                    borderWidth: 2,
                    pointRadius: 0
                },
                {
                    label: 'High',
                    data: data.series.map(s => s.high),
                    borderColor: '#f97316',
                    backgroundColor: 'rgba(249, 115, 22, 0.15)',
                    fill: true,
                    tension: 0.3,
                    borderWidth: 2,
                    pointRadius: 0
                },
                {
                    label: 'Medium',
                    data: data.series.map(s => s.medium),
                    borderColor: '#eab308',
                    backgroundColor: 'rgba(234, 179, 8, 0.15)',
                    fill: true,
                    tension: 0.3,
                    borderWidth: 2,
                    pointRadius: 0
                },
                {
                    label: 'Low',
                    data: data.series.map(s => s.low),
                    borderColor: '#22c55e',
                    backgroundColor: 'rgba(34, 197, 94, 0.15)',
                    fill: true,
                    borderWidth: 2,
                    pointRadius: 0,
                    tension: 0.3
                }
            ]
        },
        options: chartDefaultOptions
    });
}

// Render Severity Bar Chart
function renderSeverityBarChart(data, stats) {
    const ctx = document.getElementById('severity-bar-chart');
    if (!ctx) return;

    if (dashboardCharts.severityBar) {
        dashboardCharts.severityBar.destroy();
    }

    // Use current stats for accurate counts (matches Summary Cards)
    const severityData = stats ? {
        critical: stats.total_critical || 0,
        high: stats.total_high || 0,
        medium: stats.total_medium || 0,
        low: stats.total_low || 0,
        unknown: stats.total_unknown || 0
    } : {
        critical: 0, high: 0, medium: 0, low: 0, unknown: 0
    };

    // Custom plugin to display data labels on bars
    const dataLabelPlugin = {
        id: 'dataLabels',
        afterDatasetsDraw(chart) {
            const { ctx } = chart;
            chart.data.datasets.forEach((dataset, datasetIndex) => {
                const meta = chart.getDatasetMeta(datasetIndex);
                meta.data.forEach((bar, index) => {
                    const value = dataset.data[index];
                    if (value === 0) return;

                    ctx.save();
                    ctx.font = 'bold 12px Inter, sans-serif';
                    ctx.fillStyle = '#e5e7eb';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'bottom';
                    ctx.fillText(value.toLocaleString(), bar.x, bar.y - 5);
                    ctx.restore();
                });
            });
        }
    };

    dashboardCharts.severityBar = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: ['Critical', 'High', 'Medium', 'Low', 'Unknown'],
            datasets: [{
                label: 'Current Vulnerabilities',
                data: [severityData.critical, severityData.high, severityData.medium, severityData.low, severityData.unknown],
                backgroundColor: [
                    'rgba(239, 68, 68, 0.8)',
                    'rgba(249, 115, 22, 0.8)',
                    'rgba(234, 179, 8, 0.8)',
                    'rgba(34, 197, 94, 0.8)',
                    'rgba(107, 114, 128, 0.8)'
                ],
                borderColor: [
                    '#ef4444',
                    '#f97316',
                    '#eab308',
                    '#22c55e',
                    '#6b7280'
                ],
                borderWidth: 1
            }]
        },
        options: {
            ...chartDefaultOptions,
            plugins: {
                ...chartDefaultOptions.plugins,
                legend: { display: false }
            }
        },
        plugins: [dataLabelPlugin]
    });
}

// Toggle auto-refresh
function toggleDashboardRefresh() {
    dashboardAutoRefresh = !dashboardAutoRefresh;

    if (dashboardAutoRefresh) {
        btnRefreshToggle.classList.add('active');
        startDashboardRefresh();
    } else {
        btnRefreshToggle.classList.remove('active');
        stopDashboardRefresh();
    }
}

// Update countdown display
function updateCountdownDisplay() {
    const intervalText = document.getElementById('refresh-interval-text');

    if (intervalText && dashboardAutoRefresh) {
        intervalText.textContent = `${dashboardRefreshSeconds}s`;
    } else if (intervalText) {
        intervalText.textContent = `${DASHBOARD_REFRESH_INTERVAL}s`;
    }
}

// Manual refresh dashboard
async function manualRefreshDashboard() {
    if (btnRefreshNow) {
        btnRefreshNow.classList.add('spinning');
    }

    await loadDashboardData();

    // Reset countdown if auto-refresh is enabled
    if (dashboardAutoRefresh) {
        dashboardRefreshSeconds = DASHBOARD_REFRESH_INTERVAL;
        updateCountdownDisplay();
    }

    if (btnRefreshNow) {
        setTimeout(() => {
            btnRefreshNow.classList.remove('spinning');
        }, 500);
    }
}

// Start auto-refresh
function startDashboardRefresh() {
    if (dashboardRefreshInterval) return;

    // Reset countdown
    dashboardRefreshSeconds = DASHBOARD_REFRESH_INTERVAL;
    updateCountdownDisplay();

    // Countdown interval (every second)
    dashboardCountdownInterval = setInterval(() => {
        if (dashboardRefreshSeconds <= 1) {
            // Refresh data first, then reset counter
            if (!dashboardView.classList.contains('hidden')) {
                loadDashboardData();
            }
            dashboardRefreshSeconds = DASHBOARD_REFRESH_INTERVAL;
        } else {
            dashboardRefreshSeconds--;
        }
        updateCountdownDisplay();
    }, 1000);

    // Mark as running
    dashboardRefreshInterval = true;
}

// Stop auto-refresh
function stopDashboardRefresh() {
    if (dashboardCountdownInterval) {
        clearInterval(dashboardCountdownInterval);
        dashboardCountdownInterval = null;
    }
    dashboardRefreshInterval = null;
    dashboardRefreshSeconds = DASHBOARD_REFRESH_INTERVAL;
    updateCountdownDisplay();
}

// Export dashboard as PNG
async function exportDashboardPng() {
    const dashboardContent = document.getElementById('dashboard-content');
    if (!dashboardContent || typeof html2canvas === 'undefined') {
        console.error('html2canvas not loaded or dashboard content not found');
        return;
    }

    // Show loading state
    const exportBtn = document.getElementById('btn-export-png');
    const originalText = exportBtn.innerHTML;
    exportBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Exporting...';
    exportBtn.disabled = true;

    try {
        // Wait a bit for any pending renders
        await new Promise(resolve => setTimeout(resolve, 100));

        const canvas = await html2canvas(dashboardContent, {
            backgroundColor: '#0d0d0d',
            scale: 2,
            useCORS: true,
            logging: false,
            windowWidth: dashboardContent.scrollWidth,
            windowHeight: dashboardContent.scrollHeight
        });

        // Generate filename with timestamp and filters
        const rangeValue = getDropdownValue(dropdownRange) || '30d';
        const clusterValue = getDropdownValue(dropdownCluster) || 'all';
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `trivy-dashboard_${rangeValue}_${clusterValue}_${timestamp}.png`;

        // Download the image
        const link = document.createElement('a');
        link.download = filename;
        link.href = canvas.toDataURL('image/png');
        link.click();
    } catch (error) {
        console.error('Failed to export dashboard:', error);
        alert('Failed to export dashboard. Please try again.');
    } finally {
        exportBtn.innerHTML = originalText;
        exportBtn.disabled = false;
    }
}
