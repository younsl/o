// State
let currentReportType = 'vulnerabilityreport';
let currentReports = [];
let sortColumn = null;
let sortDirection = 'asc';

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
        if (currentHelpTooltip && !currentHelpTooltip.contains(e.target) && !e.target.classList.contains('help-btn')) {
            closeHelpTooltip();
        }
        // Notes modal is handled by its own overlay click handler
    });

    // Column sorting and filter click handlers
    initSortableColumns();
    initFilterButtons();

    // DB help button
    document.getElementById('db-help-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        showHelpTooltip('dbinfo', e.currentTarget);
    });

    // Poll status every 5 seconds
    setInterval(loadWatcherStatus, 5000);
    setInterval(loadStats, 5000);

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (currentNotesPopup) {
                closeNotesPopup();
            } else if (currentHelpTooltip) {
                closeHelpTooltip();
            } else if (!filterPopup.classList.contains('hidden')) {
                closeFilterPopup();
            } else if (!detailView.classList.contains('hidden')) {
                showListView();
            }
        }
    });
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

// Load version info
async function loadVersion() {
    try {
        const version = await fetchApi('/api/v1/version');
        const commitShort = version.commit.substring(0, 7);
        document.getElementById('version-info').textContent = `v${version.version} (${commitShort})`;
        document.getElementById('version-info').title = `Build: ${version.build_date}\nCommit: ${version.commit}`;
    } catch (error) {
        console.error('Failed to load version:', error);
    }
}

// Load stats
async function loadStats() {
    const ledDb = document.getElementById('led-db');
    try {
        const stats = await fetchApi('/api/v1/stats');
        document.getElementById('stat-clusters').textContent = stats.total_clusters;
        document.getElementById('stat-critical').textContent = stats.total_critical;
        document.getElementById('stat-high').textContent = stats.total_high;
        document.getElementById('stat-medium').textContent = stats.total_medium;
        document.getElementById('stat-low').textContent = stats.total_low;
        document.getElementById('stat-unknown').textContent = stats.total_unknown;

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

// Render reports
function renderReports() {
    // Update reports count
    const reportTypeName = currentReportType === 'vulnerabilityreport' ? 'Vulnerability' : 'SBOM';
    document.querySelector('#reports-count .stat-label').textContent = reportTypeName;
    document.getElementById('reports-number').textContent = currentReports.length;

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
        row.addEventListener('click', (e) => {
            // Don't navigate to detail if clicking notes button
            if (e.target.classList.contains('notes-btn')) return;
            showReportDetail(report);
        });
        reportsBody.appendChild(row);
    });

    // Add notes button handlers
    initNotesButtons();
}

function createVulnRow(report) {
    const summary = report.summary || {};
    const hasNotes = report.notes && report.notes.trim().length > 0;
    const notesBtn = `<button class="notes-btn${hasNotes ? ' has-notes' : ''}" data-cluster="${escapeHtml(report.cluster)}" data-namespace="${escapeHtml(report.namespace)}" data-name="${escapeHtml(report.name)}" data-report-type="vulnerabilityreport" data-notes="${escapeHtml(report.notes || '')}" data-notes-created="${escapeHtml(report.notes_created_at || '')}" data-notes-updated="${escapeHtml(report.notes_updated_at || '')}" title="${hasNotes ? 'View/Edit notes' : 'Add notes'}"><i class="fa-solid fa-note-sticky"></i></button>`;
    return `
        <td>${escapeHtml(report.cluster)}</td>
        <td>${escapeHtml(report.namespace)}</td>
        <td>${escapeHtml(report.app || '-')}</td>
        <td class="image-cell">${escapeHtml(report.image || '-')}${notesBtn}</td>
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
    const notesBtn = `<button class="notes-btn${hasNotes ? ' has-notes' : ''}" data-cluster="${escapeHtml(report.cluster)}" data-namespace="${escapeHtml(report.namespace)}" data-name="${escapeHtml(report.name)}" data-report-type="sbomreport" data-notes="${escapeHtml(report.notes || '')}" data-notes-created="${escapeHtml(report.notes_created_at || '')}" data-notes-updated="${escapeHtml(report.notes_updated_at || '')}" title="${hasNotes ? 'View/Edit notes' : 'Add notes'}"><i class="fa-solid fa-note-sticky"></i></button>`;
    return `
        <td>${escapeHtml(report.cluster)}</td>
        <td>${escapeHtml(report.namespace)}</td>
        <td>${escapeHtml(report.app || '-')}</td>
        <td class="image-cell">${escapeHtml(report.image || '-')}${notesBtn}</td>
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
    purl: {
        title: 'Package URL (PURL)',
        content: `
            <p><strong>PURL</strong>은 소프트웨어 패키지를 식별하는 표준화된 URL 형식입니다.</p>
            <p>형식: <code>pkg:type/namespace/name@version</code></p>
            <p>예시:</p>
            <p><code>pkg:npm/%40babel/core@7.24.0</code></p>
            <p><code>pkg:golang/github.com/gin-gonic/gin@v1.9.1</code></p>
            <p>PURL을 통해 패키지의 출처, 버전, 타입을 정확히 파악할 수 있어 취약점 추적과 의존성 관리에 유용합니다.</p>
            <p><a href="https://github.com/package-url/purl-spec" target="_blank">PURL 스펙 자세히 보기 →</a></p>
        `
    },
    bomformat: {
        title: 'BOM Format (SBOM 형식)',
        content: `
            <p><strong>BOM Format</strong>은 Software Bill of Materials(SBOM)의 표준 형식을 나타냅니다.</p>
            <p>주요 형식:</p>
            <p><code>CycloneDX</code> - OWASP에서 개발한 경량 SBOM 표준. 보안 취약점 추적에 최적화.</p>
            <p><code>SPDX</code> - Linux Foundation의 표준. 라이선스 컴플라이언스에 특화.</p>
            <p>Trivy는 기본적으로 <strong>CycloneDX</strong> 형식을 사용하며, 버전 정보(예: 1.5)는 스펙 버전을 의미합니다.</p>
            <p><a href="https://cyclonedx.org/specification/overview/" target="_blank">CycloneDX 스펙 보기 →</a></p>
        `
    },
    dbinfo: {
        title: 'Database Info',
        content: '<p>Loading...</p>'
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
    // Exclude #db-help-btn which has its own handler registered in DOMContentLoaded
    const helpBtns = document.querySelectorAll('.help-btn:not(#db-help-btn)');
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

// Notes Popup Functions
let currentNotesPopup = null;

function initNotesButtons() {
    const notesBtns = document.querySelectorAll('.notes-btn');
    notesBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            showNotesPopup(btn);
        });
    });
}

function showNotesPopup(buttonElement) {
    // Close existing popup
    closeNotesPopup();

    const cluster = buttonElement.dataset.cluster;
    const namespace = buttonElement.dataset.namespace;
    const name = buttonElement.dataset.name;
    const reportType = buttonElement.dataset.reportType;
    const notes = buttonElement.dataset.notes || '';
    const notesCreated = buttonElement.dataset.notesCreated || '';
    const notesUpdated = buttonElement.dataset.notesUpdated || '';

    // Format timestamps
    const createdStr = notesCreated ? formatDate(notesCreated) : '';
    const updatedStr = notesUpdated ? formatDate(notesUpdated) : '';
    const hasTimestamps = createdStr || updatedStr;

    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'notes-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'notes-modal';
    modal.innerHTML = `
        <div class="notes-modal-header">
            <span class="notes-modal-title">Notes</span>
            <button class="notes-modal-close">&times;</button>
        </div>
        <div class="notes-modal-body">
            <textarea class="notes-modal-textarea" placeholder="Add notes...">${escapeHtml(notes)}</textarea>
            ${hasTimestamps ? `
            <div class="notes-timestamps">
                ${createdStr ? `<span class="notes-timestamp">Created: ${createdStr}</span>` : ''}
                ${updatedStr && updatedStr !== createdStr ? `<span class="notes-timestamp">Updated: ${updatedStr}</span>` : ''}
            </div>
            ` : ''}
        </div>
        <div class="notes-modal-footer">
            <button class="btn-danger notes-modal-delete" data-cluster="${escapeHtml(cluster)}" data-namespace="${escapeHtml(namespace)}" data-name="${escapeHtml(name)}" data-report-type="${escapeHtml(reportType)}" ${!notes ? 'disabled' : ''}><i class="fa-solid fa-trash"></i> Delete</button>
            <div class="notes-modal-actions">
                <button class="btn-secondary notes-modal-cancel">Cancel</button>
                <button class="btn-primary notes-modal-save" data-cluster="${escapeHtml(cluster)}" data-namespace="${escapeHtml(namespace)}" data-name="${escapeHtml(name)}" data-report-type="${escapeHtml(reportType)}">Save</button>
            </div>
        </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    currentNotesPopup = overlay;

    // Event handlers
    modal.querySelector('.notes-modal-close').addEventListener('click', closeNotesPopup);
    modal.querySelector('.notes-modal-cancel').addEventListener('click', closeNotesPopup);
    modal.querySelector('.notes-modal-save').addEventListener('click', saveNotesFromPopup);
    modal.querySelector('.notes-modal-delete').addEventListener('click', deleteNotesFromPopup);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeNotesPopup();
    });

    // Focus textarea
    modal.querySelector('.notes-modal-textarea').focus();
}

function closeNotesPopup() {
    if (currentNotesPopup) {
        currentNotesPopup.remove();
        currentNotesPopup = null;
    }
}

async function saveNotesFromPopup(e) {
    const btn = e.target;
    const cluster = btn.dataset.cluster;
    const namespace = btn.dataset.namespace;
    const name = btn.dataset.name;
    const reportType = btn.dataset.reportType;
    const textarea = currentNotesPopup.querySelector('.notes-modal-textarea');
    const notes = textarea.value;

    btn.disabled = true;
    btn.textContent = 'Saving...';

    try {
        const response = await fetch(
            `/api/v1/reports/${encodeURIComponent(cluster)}/${encodeURIComponent(reportType)}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/notes`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ notes })
            }
        );

        if (response.ok) {
            // Update the local report data with new timestamp
            const report = currentReports.find(r =>
                r.cluster === cluster &&
                r.namespace === namespace &&
                r.name === name
            );
            if (report) {
                report.notes = notes;
                const now = new Date().toISOString();
                if (!report.notes_created_at) {
                    report.notes_created_at = now;
                }
                report.notes_updated_at = now;
            }
            closeNotesPopup();
            // Re-render to update the notes button state
            renderReports();
        } else {
            throw new Error('Failed to save');
        }
    } catch (error) {
        console.error('Failed to save notes:', error);
        btn.textContent = 'Error';
        setTimeout(() => {
            btn.textContent = 'Save';
            btn.disabled = false;
        }, 2000);
    }
}

function deleteNotesFromPopup(e) {
    const btn = e.target.closest('.notes-modal-delete');

    // Show inline confirmation buttons
    const originalHtml = btn.innerHTML;
    btn.classList.add('confirming');

    // Create confirm/cancel buttons
    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn-danger btn-confirm-yes';
    confirmBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
    confirmBtn.title = 'Yes, delete';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-secondary btn-confirm-no';
    cancelBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    cancelBtn.title = 'Cancel';

    // Insert buttons after delete button
    btn.parentNode.insertBefore(confirmBtn, btn.nextSibling);
    btn.parentNode.insertBefore(cancelBtn, confirmBtn.nextSibling);

    // Cancel handler
    cancelBtn.addEventListener('click', () => {
        btn.classList.remove('confirming');
        confirmBtn.remove();
        cancelBtn.remove();
    });

    // Confirm handler
    confirmBtn.addEventListener('click', async () => {
        const cluster = btn.dataset.cluster;
        const namespace = btn.dataset.namespace;
        const name = btn.dataset.name;
        const reportType = btn.dataset.reportType;

        btn.disabled = true;
        confirmBtn.disabled = true;
        cancelBtn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Deleting...';

        try {
            const response = await fetch(
                `/api/v1/reports/${encodeURIComponent(cluster)}/${encodeURIComponent(reportType)}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/notes`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ notes: '' })
                }
            );

            if (response.ok) {
                const report = currentReports.find(r =>
                    r.cluster === cluster &&
                    r.namespace === namespace &&
                    r.name === name
                );
                if (report) {
                    report.notes = '';
                    report.notes_created_at = null;
                    report.notes_updated_at = null;
                }
                closeNotesPopup();
                renderReports();
            } else {
                throw new Error('Failed to delete');
            }
        } catch (error) {
            console.error('Failed to delete notes:', error);
            btn.innerHTML = originalHtml;
            btn.classList.remove('confirming');
            btn.disabled = false;
            confirmBtn.remove();
            cancelBtn.remove();
        }
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

    filterPopup.style.top = `${rect.bottom - containerRect.top + 5}px`;
    filterPopup.style.left = `${Math.max(0, rect.left - containerRect.left - 100)}px`;

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

    // Show severity totals only for vuln reports
    const severityTotals = document.getElementById('severity-totals');
    if (currentReportType === 'vulnerabilityreport') {
        severityTotals.classList.remove('hidden');
    } else {
        severityTotals.classList.add('hidden');
    }
}

function showDetailView() {
    reportsSection.classList.add('hidden');
    detailView.classList.remove('hidden');
}

// Show report detail (drill-down view)
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

        if (currentReportType === 'vulnerabilityreport') {
            renderVulnDetail(data);
        } else {
            renderSbomDetail(data);
        }
    } catch (error) {
        console.error('Failed to load report detail:', error);
        detailSummary.innerHTML = '<p class="no-data">Error loading report details</p>';
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
