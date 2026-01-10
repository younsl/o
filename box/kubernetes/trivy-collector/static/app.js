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
const detailThead = document.getElementById('detail-thead');
const detailTbody = document.getElementById('detail-tbody');
const btnBack = document.getElementById('btn-back');

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

    // Poll watcher status every 5 seconds
    setInterval(loadWatcherStatus, 5000);

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

        // Update DB status in header
        document.getElementById('header-db-size').textContent = stats.db_size_human;
        document.getElementById('db-status').title = `Database: ${stats.db_size_human} (${stats.db_size_bytes.toLocaleString()} bytes)`;

        // Set DB LED to running (green)
        ledDb.className = 'led running';
        ledDb.title = 'Database connected';
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
    const colspan = currentReportType === 'vulnerabilityreport' ? 9 : 6;
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
        const colspan = currentReportType === 'vulnerabilityreport' ? 9 : 6;
        reportsBody.innerHTML = `<tr><td colspan="${colspan}" class="no-data">Error loading reports</td></tr>`;
    }
}

// Render reports
function renderReports() {
    // Update reports count
    const reportTypeName = currentReportType === 'vulnerabilityreport' ? 'Vulnerability' : 'SBOM';
    reportsCount.textContent = `${currentReports.length} ${reportTypeName} Reports`;

    const colspan = currentReportType === 'vulnerabilityreport' ? 9 : 6;
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
    const notesBtn = `<button class="notes-btn${hasNotes ? ' has-notes' : ''}" data-cluster="${escapeHtml(report.cluster)}" data-namespace="${escapeHtml(report.namespace)}" data-name="${escapeHtml(report.name)}" data-report-type="vulnerabilityreport" data-notes="${escapeHtml(report.notes || '')}" data-notes-created="${escapeHtml(report.notes_created_at || '')}" data-notes-updated="${escapeHtml(report.notes_updated_at || '')}" title="${hasNotes ? 'View/Edit notes' : 'Add notes'}">📝</button>`;
    return `
        <td>${escapeHtml(report.cluster)}</td>
        <td>${escapeHtml(report.namespace)}</td>
        <td>${escapeHtml(report.app || '-')}</td>
        <td class="image-cell">${escapeHtml(report.image || '-')}${notesBtn}</td>
        <td class="severity-col">${formatSeverity(summary.critical, 'critical')}</td>
        <td class="severity-col">${formatSeverity(summary.high, 'high')}</td>
        <td class="severity-col">${formatSeverity(summary.medium, 'medium')}</td>
        <td class="severity-col">${formatSeverity(summary.low, 'low')}</td>
        <td>${formatDate(report.updated_at)}</td>
    `;
}

function createSbomRow(report) {
    const hasNotes = report.notes && report.notes.trim().length > 0;
    const notesBtn = `<button class="notes-btn${hasNotes ? ' has-notes' : ''}" data-cluster="${escapeHtml(report.cluster)}" data-namespace="${escapeHtml(report.namespace)}" data-name="${escapeHtml(report.name)}" data-report-type="sbomreport" data-notes="${escapeHtml(report.notes || '')}" data-notes-created="${escapeHtml(report.notes_created_at || '')}" data-notes-updated="${escapeHtml(report.notes_updated_at || '')}" title="${hasNotes ? 'View/Edit notes' : 'Add notes'}">📝</button>`;
    return `
        <td>${escapeHtml(report.cluster)}</td>
        <td>${escapeHtml(report.namespace)}</td>
        <td>${escapeHtml(report.app || '-')}</td>
        <td class="image-cell">${escapeHtml(report.image || '-')}${notesBtn}</td>
        <td>${report.components_count || 0}</td>
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

    // Show/hide severity totals based on report type
    const severityTotals = document.getElementById('severity-totals');
    if (type === 'vulnerabilityreport') {
        severityTotals.classList.remove('hidden');
    } else {
        severityTotals.classList.add('hidden');
    }

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
                    <span class="sort-icon">⇅</span>
                    <button class="filter-btn" title="Filter">🔍</button>
                </th>
                <th class="sortable filterable" data-sort-key="namespace" data-filter-key="namespace">
                    <span class="th-content">Namespace</span>
                    <span class="sort-icon">⇅</span>
                    <button class="filter-btn" title="Filter">🔍</button>
                </th>
                <th class="filterable" data-filter-key="app">
                    <span class="th-content">Application</span>
                    <button class="filter-btn" title="Filter">🔍</button>
                </th>
                <th>Image</th>
                <th class="severity-col sortable" data-sort-key="critical">C <span class="sort-icon">⇅</span></th>
                <th class="severity-col sortable" data-sort-key="high">H <span class="sort-icon">⇅</span></th>
                <th class="severity-col sortable" data-sort-key="medium">M <span class="sort-icon">⇅</span></th>
                <th class="severity-col sortable" data-sort-key="low">L <span class="sort-icon">⇅</span></th>
                <th class="sortable" data-sort-key="updated_at">Updated <span class="sort-icon">⇅</span></th>
            </tr>
        `;
    } else {
        reportsThead.innerHTML = `
            <tr>
                <th class="sortable filterable" data-sort-key="cluster" data-filter-key="cluster">
                    <span class="th-content">Cluster</span>
                    <span class="sort-icon">⇅</span>
                    <button class="filter-btn" title="Filter">🔍</button>
                </th>
                <th class="sortable filterable" data-sort-key="namespace" data-filter-key="namespace">
                    <span class="th-content">Namespace</span>
                    <span class="sort-icon">⇅</span>
                    <button class="filter-btn" title="Filter">🔍</button>
                </th>
                <th class="filterable" data-filter-key="app">
                    <span class="th-content">Application</span>
                    <button class="filter-btn" title="Filter">🔍</button>
                </th>
                <th>Image</th>
                <th class="sortable" data-sort-key="components">Components <span class="sort-icon">⇅</span></th>
                <th class="sortable" data-sort-key="updated_at">Updated <span class="sort-icon">⇅</span></th>
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
    const helpBtns = document.querySelectorAll('.help-btn');
    helpBtns.forEach(btn => {
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
            <button class="btn-secondary notes-modal-cancel">Cancel</button>
            <button class="btn-primary notes-modal-save" data-cluster="${escapeHtml(cluster)}" data-namespace="${escapeHtml(namespace)}" data-name="${escapeHtml(name)}" data-report-type="${escapeHtml(reportType)}">Save</button>
        </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    currentNotesPopup = overlay;

    // Event handlers
    modal.querySelector('.notes-modal-close').addEventListener('click', closeNotesPopup);
    modal.querySelector('.notes-modal-cancel').addEventListener('click', closeNotesPopup);
    modal.querySelector('.notes-modal-save').addEventListener('click', saveNotesFromPopup);
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
    detailThead.innerHTML = '';
    detailTbody.innerHTML = '';

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

    detailSummary.innerHTML = `
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
    `;

    detailThead.innerHTML = `
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
        detailTbody.innerHTML = '<tr><td colspan="8" class="no-data">No vulnerabilities found</td></tr>';
        return;
    }

    detailTbody.innerHTML = vulnerabilities.map((vuln, index) => {
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

function renderSbomDetail(report) {
    const componentsData = report.data?.report?.components || {};
    const components = componentsData.components || [];
    const summary = report.data?.report?.summary || {};
    const scanner = report.data?.report?.scanner || {};
    const registry = report.data?.report?.registry || {};
    const artifact = report.data?.report?.artifact || {};

    // Get full image with registry
    const fullImage = registry.server
        ? `${registry.server}/${artifact.repository}:${artifact.tag}`
        : report.meta.image;

    detailSummary.innerHTML = `
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
            <span class="detail-summary-label">BOM Format <button class="help-btn" data-tooltip="bomformat" title="What is BOM Format?">?</button></span>
            <span class="detail-summary-value">${escapeHtml(componentsData.bomFormat || '-')} ${escapeHtml(componentsData.specVersion || '')}</span>
        </div>
        <div class="detail-summary-item">
            <span class="detail-summary-label">Scanner</span>
            <span class="detail-summary-value">${escapeHtml(scanner.name || '-')} ${escapeHtml(scanner.version || '')}</span>
        </div>
    `;

    detailThead.innerHTML = `
        <tr>
            <th class="col-index">#</th>
            <th>Name</th>
            <th>Version</th>
            <th>Type</th>
            <th>License</th>
            <th>PURL <button class="help-btn" data-tooltip="purl" title="What is PURL?">?</button></th>
        </tr>
    `;

    if (components.length === 0) {
        detailTbody.innerHTML = '<tr><td colspan="6" class="no-data">No components found</td></tr>';
        return;
    }

    detailTbody.innerHTML = components.map((comp, index) => {
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
                icon.textContent = sortDirection === 'desc' ? '▼' : '▲';
                header.classList.add('sorted');
            } else {
                icon.textContent = '⇅';
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
        csvContent = 'Cluster,Namespace,Application,Image,Critical,High,Medium,Low,Updated\n';
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
