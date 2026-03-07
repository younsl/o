use std::time::Instant;

use crate::ami::{OwnedAmi, ScanResult};
use chrono::Utc;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

#[derive(Debug, Clone, PartialEq)]
pub enum AmiStatus {
    Pending,
    Deleting,
    Deleted,
    Failed(String),
}

#[derive(Debug, Clone)]
pub struct AmiRow {
    pub region: String,
    pub ami: OwnedAmi,
    pub age_days: Option<i64>,
    pub selected: bool,
    pub status: AmiStatus,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AppMode {
    SelectOwner,
    SelectConsumers,
    Scanning,
    Browse,
    Confirm,
    Done,
}

pub enum AppAction {
    None,
    Quit,
    Delete,
    StartScan,
}

pub struct ProfileSelector {
    pub profiles: Vec<String>,
    pub cursor: usize,
    pub selected: Vec<bool>,
    pub owner_profile: Option<String>,
    pub consumer_profiles: Vec<String>,
    pub scroll_offset: usize,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SortField {
    Default,
    Age,
    LastLaunched,
    Size,
    Name,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SortOrder {
    Asc,
    Desc,
}

pub struct App {
    pub rows: Vec<AmiRow>,
    pub cursor: usize,
    pub mode: AppMode,
    pub header: String,
    pub scroll_offset: usize,
    pub summary: ScanSummary,
    pub scan_logs: Vec<ScanLog>,
    pub scan_spinner_frame: usize,
    pub profile_selector: ProfileSelector,
    pub sort_field: SortField,
    pub sort_order: SortOrder,
    pub scan_started_at: Option<Instant>,
    pub scan_elapsed_secs: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct ScanLog {
    pub text: String,
    pub done: bool,
}

#[derive(Default)]
pub struct ScanSummary {
    pub total_owned: usize,
    pub total_used: usize,
    pub total_shared: usize,
    pub total_managed: usize,
    pub total_unused: usize,
    pub total_snapshots: usize,
}

impl ProfileSelector {
    pub fn new(profiles: Vec<String>) -> Self {
        let len = profiles.len();
        ProfileSelector {
            profiles,
            cursor: 0,
            selected: vec![false; len],
            owner_profile: None,
            consumer_profiles: Vec::new(),
            scroll_offset: 0,
        }
    }

    pub fn adjust_scroll(&mut self, visible_rows: usize) {
        if self.cursor < self.scroll_offset {
            self.scroll_offset = self.cursor;
        } else if self.cursor >= self.scroll_offset + visible_rows {
            self.scroll_offset = self.cursor - visible_rows + 1;
        }
    }
}

impl App {
    pub fn new_select_profile(profiles: Vec<String>) -> Self {
        App {
            rows: Vec::new(),
            cursor: 0,
            mode: AppMode::SelectOwner,
            header: String::new(),
            scroll_offset: 0,
            summary: ScanSummary::default(),
            scan_logs: Vec::new(),
            scan_spinner_frame: 0,
            profile_selector: ProfileSelector::new(profiles),
            sort_field: SortField::Default,
            sort_order: SortOrder::Desc,
            scan_started_at: None,
            scan_elapsed_secs: None,
        }
    }

    pub fn new_scanning(header: String) -> Self {
        App {
            rows: Vec::new(),
            cursor: 0,
            mode: AppMode::Scanning,
            header,
            scroll_offset: 0,
            summary: ScanSummary::default(),
            scan_logs: Vec::new(),
            scan_spinner_frame: 0,
            profile_selector: ProfileSelector::new(Vec::new()),
            sort_field: SortField::Default,
            sort_order: SortOrder::Desc,
            scan_started_at: Some(Instant::now()),
            scan_elapsed_secs: None,
        }
    }

    pub fn add_scan_log(&mut self, text: String) {
        self.scan_logs.push(ScanLog { text, done: false });
    }

    pub fn finish_scan_log(&mut self, result: String) {
        if let Some(last) = self.scan_logs.last_mut() {
            if !last.done {
                last.text = result;
                last.done = true;
            }
        }
    }

    pub fn tick_spinner(&mut self) {
        self.scan_spinner_frame = self.scan_spinner_frame.wrapping_add(1);
    }

    pub fn spinner_char(&self) -> char {
        const FRAMES: &[char] = &['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
        FRAMES[self.scan_spinner_frame % FRAMES.len()]
    }

    pub fn load_scan_results(&mut self, scan_results: &[ScanResult]) {
        let now = Utc::now();
        for scan in scan_results {
            for ami in &scan.unused_amis {
                let age_days = ami.creation_date.map(|d| (now - d).num_days());
                self.rows.push(AmiRow {
                    region: scan.region.clone(),
                    ami: ami.clone(),
                    age_days,
                    selected: false,
                    status: AmiStatus::Pending,
                });
            }
        }

        self.summary = ScanSummary {
            total_owned: scan_results.iter().map(|r| r.owned_amis.len()).sum(),
            total_used: scan_results.iter().map(|r| r.used_ami_ids.len()).sum(),
            total_shared: scan_results
                .iter()
                .flat_map(|r| &r.owned_amis)
                .filter(|a| a.shared)
                .count(),
            total_managed: scan_results
                .iter()
                .flat_map(|r| &r.owned_amis)
                .filter(|a| a.managed)
                .count(),
            total_unused: self.rows.len(),
            total_snapshots: self.rows.iter().map(|r| r.ami.snapshot_ids.len()).sum(),
        };

        self.scan_elapsed_secs = self.scan_started_at.map(|t| t.elapsed().as_secs());

        self.mode = if self.rows.is_empty() {
            AppMode::Done
        } else {
            AppMode::Browse
        };
    }

    pub fn selected_count(&self) -> usize {
        self.rows.iter().filter(|r| r.selected).count()
    }

    pub fn selected_snapshot_count(&self) -> usize {
        self.rows
            .iter()
            .filter(|r| r.selected)
            .map(|r| r.ami.snapshot_ids.len())
            .sum()
    }

    pub fn selected_size_gb(&self) -> i64 {
        self.rows
            .iter()
            .filter(|r| r.selected)
            .map(|r| r.ami.size_gb)
            .sum()
    }

    pub fn total_size_gb(&self) -> i64 {
        self.rows.iter().map(|r| r.ami.size_gb).sum()
    }

    pub fn deleted_count(&self) -> usize {
        self.rows
            .iter()
            .filter(|r| r.status == AmiStatus::Deleted)
            .count()
    }

    pub fn failed_count(&self) -> usize {
        self.rows
            .iter()
            .filter(|r| matches!(r.status, AmiStatus::Failed(_)))
            .count()
    }

    /// Returns elapsed seconds: live during scan, final value after completion.
    pub fn elapsed_secs(&self) -> u64 {
        self.scan_elapsed_secs
            .or_else(|| self.scan_started_at.map(|t| t.elapsed().as_secs()))
            .unwrap_or(0)
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> AppAction {
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            return AppAction::Quit;
        }
        match self.mode {
            AppMode::SelectOwner => self.handle_select_owner(key),
            AppMode::SelectConsumers => self.handle_select_consumers(key),
            AppMode::Scanning => {
                if key.code == KeyCode::Char('q') || key.code == KeyCode::Esc {
                    return AppAction::Quit;
                }
                AppAction::None
            }
            AppMode::Browse => self.handle_browse(key),
            AppMode::Confirm => self.handle_confirm(key),
            AppMode::Done => self.handle_done(key),
        }
    }

    fn handle_select_owner(&mut self, key: KeyEvent) -> AppAction {
        let ps = &mut self.profile_selector;
        match key.code {
            KeyCode::Char('q') | KeyCode::Esc => AppAction::Quit,
            KeyCode::Down | KeyCode::Char('j') => {
                if !ps.profiles.is_empty() && ps.cursor < ps.profiles.len() - 1 {
                    ps.cursor += 1;
                }
                AppAction::None
            }
            KeyCode::Up | KeyCode::Char('k') => {
                if ps.cursor > 0 {
                    ps.cursor -= 1;
                }
                AppAction::None
            }
            KeyCode::Enter | KeyCode::Char(' ') => {
                if !ps.profiles.is_empty() {
                    ps.owner_profile = Some(ps.profiles[ps.cursor].clone());
                    // Reset for consumer selection
                    ps.cursor = 0;
                    ps.scroll_offset = 0;
                    self.mode = AppMode::SelectConsumers;
                }
                AppAction::None
            }
            _ => AppAction::None,
        }
    }

    fn handle_select_consumers(&mut self, key: KeyEvent) -> AppAction {
        let ps = &mut self.profile_selector;
        let owner = ps.owner_profile.clone().unwrap_or_default();
        match key.code {
            KeyCode::Char('q') | KeyCode::Esc => AppAction::Quit,
            KeyCode::Down | KeyCode::Char('j') => {
                if !ps.profiles.is_empty() && ps.cursor < ps.profiles.len() - 1 {
                    ps.cursor += 1;
                }
                AppAction::None
            }
            KeyCode::Up | KeyCode::Char('k') => {
                if ps.cursor > 0 {
                    ps.cursor -= 1;
                }
                AppAction::None
            }
            KeyCode::Char(' ') => {
                // Don't allow selecting owner as consumer
                if ps.profiles[ps.cursor] != owner {
                    ps.selected[ps.cursor] = !ps.selected[ps.cursor];
                }
                AppAction::None
            }
            KeyCode::Enter => {
                ps.consumer_profiles = ps
                    .profiles
                    .iter()
                    .zip(ps.selected.iter())
                    .filter(|(name, sel)| **sel && **name != owner)
                    .map(|(name, _)| name.clone())
                    .collect();
                self.mode = AppMode::Scanning;
                self.scan_started_at = Some(Instant::now());
                AppAction::StartScan
            }
            _ => AppAction::None,
        }
    }

    fn handle_browse(&mut self, key: KeyEvent) -> AppAction {
        match key.code {
            KeyCode::Char('q') | KeyCode::Esc => AppAction::Quit,
            KeyCode::Down | KeyCode::Char('j') => {
                if !self.rows.is_empty() && self.cursor < self.rows.len() - 1 {
                    self.cursor += 1;
                }
                AppAction::None
            }
            KeyCode::Up | KeyCode::Char('k') => {
                if self.cursor > 0 {
                    self.cursor -= 1;
                }
                AppAction::None
            }
            KeyCode::Char(' ') => {
                if let Some(row) = self.rows.get_mut(self.cursor) {
                    if row.status == AmiStatus::Pending {
                        row.selected = !row.selected;
                    }
                }
                AppAction::None
            }
            KeyCode::Char('a') => {
                let all_selected = self
                    .rows
                    .iter()
                    .filter(|r| r.status == AmiStatus::Pending)
                    .all(|r| r.selected);
                for row in &mut self.rows {
                    if row.status == AmiStatus::Pending {
                        row.selected = !all_selected;
                    }
                }
                AppAction::None
            }
            KeyCode::Char('s') => {
                self.cycle_sort();
                AppAction::None
            }
            KeyCode::Char('d') | KeyCode::Enter => {
                if self.selected_count() > 0 {
                    self.mode = AppMode::Confirm;
                }
                AppAction::None
            }
            KeyCode::Home | KeyCode::Char('g') => {
                self.cursor = 0;
                AppAction::None
            }
            KeyCode::End | KeyCode::Char('G') => {
                if !self.rows.is_empty() {
                    self.cursor = self.rows.len() - 1;
                }
                AppAction::None
            }
            _ => AppAction::None,
        }
    }

    fn handle_confirm(&mut self, key: KeyEvent) -> AppAction {
        match key.code {
            KeyCode::Char('y') | KeyCode::Char('Y') => {
                for row in &mut self.rows {
                    if row.selected && row.status == AmiStatus::Pending {
                        row.status = AmiStatus::Deleting;
                    }
                }
                self.mode = AppMode::Browse;
                AppAction::Delete
            }
            _ => {
                self.mode = AppMode::Browse;
                AppAction::None
            }
        }
    }

    fn handle_done(&mut self, key: KeyEvent) -> AppAction {
        match key.code {
            KeyCode::Char('q') | KeyCode::Esc | KeyCode::Enter => AppAction::Quit,
            _ => AppAction::None,
        }
    }

    pub fn mark_deleted(&mut self, ami_id: &str) {
        if let Some(row) = self.rows.iter_mut().find(|r| r.ami.ami_id == ami_id) {
            row.status = AmiStatus::Deleted;
            row.selected = false;
        }
    }

    pub fn mark_failed(&mut self, ami_id: &str, err: String) {
        if let Some(row) = self.rows.iter_mut().find(|r| r.ami.ami_id == ami_id) {
            row.status = AmiStatus::Failed(err);
            row.selected = false;
        }
    }

    pub fn has_deleting(&self) -> bool {
        self.rows.iter().any(|r| r.status == AmiStatus::Deleting)
    }

    pub fn cycle_sort(&mut self) {
        (self.sort_field, self.sort_order) = match (self.sort_field, self.sort_order) {
            (SortField::Default, _) => (SortField::Age, SortOrder::Desc),
            (SortField::Age, SortOrder::Desc) => (SortField::Age, SortOrder::Asc),
            (SortField::Age, SortOrder::Asc) => (SortField::LastLaunched, SortOrder::Desc),
            (SortField::LastLaunched, SortOrder::Desc) => (SortField::LastLaunched, SortOrder::Asc),
            (SortField::LastLaunched, SortOrder::Asc) => (SortField::Size, SortOrder::Desc),
            (SortField::Size, SortOrder::Desc) => (SortField::Size, SortOrder::Asc),
            (SortField::Size, SortOrder::Asc) => (SortField::Name, SortOrder::Asc),
            (SortField::Name, SortOrder::Asc) => (SortField::Name, SortOrder::Desc),
            (SortField::Name, SortOrder::Desc) => (SortField::Default, SortOrder::Desc),
        };
        self.apply_sort();
        self.cursor = 0;
        self.scroll_offset = 0;
    }

    pub fn apply_sort(&mut self) {
        match self.sort_field {
            SortField::Default => {}
            SortField::Age => self.rows.sort_by(|a, b| {
                let cmp = a.age_days.unwrap_or(0).cmp(&b.age_days.unwrap_or(0));
                if self.sort_order == SortOrder::Desc {
                    cmp.reverse()
                } else {
                    cmp
                }
            }),
            SortField::LastLaunched => self.rows.sort_by(|a, b| {
                let cmp = a.ami.last_launched.cmp(&b.ami.last_launched);
                if self.sort_order == SortOrder::Desc {
                    cmp.reverse()
                } else {
                    cmp
                }
            }),
            SortField::Size => self.rows.sort_by(|a, b| {
                let cmp = a.ami.size_gb.cmp(&b.ami.size_gb);
                if self.sort_order == SortOrder::Desc {
                    cmp.reverse()
                } else {
                    cmp
                }
            }),
            SortField::Name => self.rows.sort_by(|a, b| {
                let cmp = a.ami.name.cmp(&b.ami.name);
                if self.sort_order == SortOrder::Desc {
                    cmp.reverse()
                } else {
                    cmp
                }
            }),
        }
    }

    pub fn sort_label(&self) -> &'static str {
        match (self.sort_field, self.sort_order) {
            (SortField::Default, _) => "",
            (SortField::Age, SortOrder::Desc) => " Age↓",
            (SortField::Age, SortOrder::Asc) => " Age↑",
            (SortField::LastLaunched, SortOrder::Desc) => " Launched↓",
            (SortField::LastLaunched, SortOrder::Asc) => " Launched↑",
            (SortField::Size, SortOrder::Desc) => " Size↓",
            (SortField::Size, SortOrder::Asc) => " Size↑",
            (SortField::Name, SortOrder::Asc) => " Name↑",
            (SortField::Name, SortOrder::Desc) => " Name↓",
        }
    }

    pub fn adjust_scroll(&mut self, visible_rows: usize) {
        if self.cursor < self.scroll_offset {
            self.scroll_offset = self.cursor;
        } else if self.cursor >= self.scroll_offset + visible_rows {
            self.scroll_offset = self.cursor - visible_rows + 1;
        }
    }
}
