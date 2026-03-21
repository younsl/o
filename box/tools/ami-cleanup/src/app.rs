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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ami::{OwnedAmi, ScanResult};
    use chrono::{Duration, Utc};
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use std::collections::HashSet;

    fn make_ami(id: &str, name: &str, size_gb: i64, snap_count: usize) -> OwnedAmi {
        OwnedAmi {
            ami_id: id.to_string(),
            name: name.to_string(),
            creation_date: Some(Utc::now() - Duration::days(30)),
            last_launched: None,
            snapshot_ids: (0..snap_count).map(|i| format!("snap-{id}-{i}")).collect(),
            size_gb,
            shared: false,
            managed: false,
        }
    }

    fn make_scan_result(
        region: &str,
        owned: Vec<OwnedAmi>,
        used: HashSet<String>,
        unused: Vec<OwnedAmi>,
    ) -> ScanResult {
        ScanResult {
            region: region.to_string(),
            owned_amis: owned,
            used_ami_ids: used,
            unused_amis: unused,
        }
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn ctrl_c() -> KeyEvent {
        KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)
    }

    // -- ProfileSelector tests --

    #[test]
    fn test_profile_selector_new() {
        let ps = ProfileSelector::new(vec!["a".into(), "b".into(), "c".into()]);
        assert_eq!(ps.profiles.len(), 3);
        assert_eq!(ps.cursor, 0);
        assert_eq!(ps.selected, vec![false, false, false]);
        assert!(ps.owner_profile.is_none());
        assert!(ps.consumer_profiles.is_empty());
        assert_eq!(ps.scroll_offset, 0);
    }

    #[test]
    fn test_profile_selector_empty() {
        let ps = ProfileSelector::new(vec![]);
        assert!(ps.profiles.is_empty());
        assert_eq!(ps.selected.len(), 0);
    }

    #[test]
    fn test_profile_selector_adjust_scroll_cursor_above() {
        let mut ps = ProfileSelector::new((0..10).map(|i| format!("p{i}")).collect());
        ps.scroll_offset = 5;
        ps.cursor = 2;
        ps.adjust_scroll(3);
        assert_eq!(ps.scroll_offset, 2);
    }

    #[test]
    fn test_profile_selector_adjust_scroll_cursor_below() {
        let mut ps = ProfileSelector::new((0..10).map(|i| format!("p{i}")).collect());
        ps.scroll_offset = 0;
        ps.cursor = 5;
        ps.adjust_scroll(3);
        assert_eq!(ps.scroll_offset, 3);
    }

    #[test]
    fn test_profile_selector_adjust_scroll_within_viewport() {
        let mut ps = ProfileSelector::new(vec!["a".into(), "b".into(), "c".into()]);
        ps.scroll_offset = 0;
        ps.cursor = 1;
        ps.adjust_scroll(3);
        assert_eq!(ps.scroll_offset, 0);
    }

    // -- App constructor tests --

    #[test]
    fn test_app_new_select_profile() {
        let app = App::new_select_profile(vec!["dev".into(), "prod".into()]);
        assert_eq!(app.mode, AppMode::SelectOwner);
        assert!(app.rows.is_empty());
        assert_eq!(app.cursor, 0);
        assert_eq!(app.sort_field, SortField::Default);
        assert_eq!(app.sort_order, SortOrder::Desc);
        assert_eq!(app.profile_selector.profiles.len(), 2);
        assert!(app.scan_started_at.is_none());
    }

    #[test]
    fn test_app_new_scanning() {
        let app = App::new_scanning("test header".into());
        assert_eq!(app.mode, AppMode::Scanning);
        assert_eq!(app.header, "test header");
        assert!(app.scan_started_at.is_some());
    }

    // -- Scan log tests --

    #[test]
    fn test_add_scan_log() {
        let mut app = App::new_scanning("h".into());
        app.add_scan_log("step 1".into());
        app.add_scan_log("step 2".into());
        assert_eq!(app.scan_logs.len(), 2);
        assert!(!app.scan_logs[0].done);
        assert_eq!(app.scan_logs[0].text, "step 1");
    }

    #[test]
    fn test_finish_scan_log() {
        let mut app = App::new_scanning("h".into());
        app.add_scan_log("working..".into());
        app.finish_scan_log("done!".into());
        assert!(app.scan_logs[0].done);
        assert_eq!(app.scan_logs[0].text, "done!");
    }

    #[test]
    fn test_finish_scan_log_empty() {
        let mut app = App::new_scanning("h".into());
        app.finish_scan_log("result".into());
        assert!(app.scan_logs.is_empty());
    }

    #[test]
    fn test_finish_scan_log_already_done() {
        let mut app = App::new_scanning("h".into());
        app.add_scan_log("working..".into());
        app.finish_scan_log("first".into());
        app.finish_scan_log("second".into());
        assert_eq!(app.scan_logs[0].text, "first");
    }

    // -- Spinner tests --

    #[test]
    fn test_spinner_char_initial() {
        let app = App::new_scanning("h".into());
        assert_eq!(app.spinner_char(), '⠋');
    }

    #[test]
    fn test_tick_spinner_full_cycle() {
        let mut app = App::new_scanning("h".into());
        let chars: Vec<char> = (0..10)
            .map(|_| {
                let c = app.spinner_char();
                app.tick_spinner();
                c
            })
            .collect();
        assert_eq!(
            chars,
            vec!['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
        );
        assert_eq!(app.spinner_char(), '⠋');
    }

    // -- load_scan_results tests --

    #[test]
    fn test_load_scan_results_populates_rows_and_summary() {
        let mut app = App::new_scanning("h".into());
        let ami1 = make_ami("ami-1", "web", 8, 1);
        let ami2 = make_ami("ami-2", "db", 16, 2);
        let ami3 = make_ami("ami-3", "in-use", 8, 1);
        let owned = vec![ami1.clone(), ami2.clone(), ami3];
        let used: HashSet<String> = ["ami-3".to_string()].into();
        let unused = vec![ami1, ami2];
        let results = vec![make_scan_result("us-east-1", owned, used, unused)];
        app.load_scan_results(&results);

        assert_eq!(app.mode, AppMode::Browse);
        assert_eq!(app.rows.len(), 2);
        assert_eq!(app.summary.total_owned, 3);
        assert_eq!(app.summary.total_used, 1);
        assert_eq!(app.summary.total_unused, 2);
        assert_eq!(app.summary.total_snapshots, 3);
        assert_eq!(app.rows[0].region, "us-east-1");
        assert_eq!(app.rows[0].status, AmiStatus::Pending);
        assert!(!app.rows[0].selected);
    }

    #[test]
    fn test_load_scan_results_empty_goes_to_done() {
        let mut app = App::new_scanning("h".into());
        let results = vec![make_scan_result(
            "us-east-1",
            vec![],
            HashSet::new(),
            vec![],
        )];
        app.load_scan_results(&results);
        assert_eq!(app.mode, AppMode::Done);
        assert!(app.rows.is_empty());
    }

    #[test]
    fn test_load_scan_results_shared_and_managed_counts() {
        let mut app = App::new_scanning("h".into());
        let mut shared = make_ami("ami-1", "shared", 8, 0);
        shared.shared = true;
        let mut managed = make_ami("ami-2", "managed", 8, 0);
        managed.managed = true;
        let normal = make_ami("ami-3", "normal", 8, 0);
        let owned = vec![shared, managed, normal.clone()];
        let results = vec![make_scan_result(
            "us-east-1",
            owned,
            HashSet::new(),
            vec![normal],
        )];
        app.load_scan_results(&results);
        assert_eq!(app.summary.total_shared, 1);
        assert_eq!(app.summary.total_managed, 1);
    }

    // -- Aggregation tests --

    #[test]
    fn test_selected_count() {
        let mut app = App::new_scanning("h".into());
        let a1 = make_ami("ami-1", "a", 8, 1);
        let a2 = make_ami("ami-2", "b", 8, 1);
        let results = vec![make_scan_result(
            "r",
            vec![a1.clone(), a2.clone()],
            HashSet::new(),
            vec![a1, a2],
        )];
        app.load_scan_results(&results);
        assert_eq!(app.selected_count(), 0);
        app.rows[0].selected = true;
        assert_eq!(app.selected_count(), 1);
    }

    #[test]
    fn test_selected_snapshot_count() {
        let mut app = App::new_scanning("h".into());
        let a1 = make_ami("ami-1", "a", 8, 2);
        let a2 = make_ami("ami-2", "b", 8, 3);
        let results = vec![make_scan_result(
            "r",
            vec![a1.clone(), a2.clone()],
            HashSet::new(),
            vec![a1, a2],
        )];
        app.load_scan_results(&results);
        app.rows[0].selected = true;
        app.rows[1].selected = true;
        assert_eq!(app.selected_snapshot_count(), 5);
    }

    #[test]
    fn test_selected_size_gb() {
        let mut app = App::new_scanning("h".into());
        let a1 = make_ami("ami-1", "a", 8, 0);
        let a2 = make_ami("ami-2", "b", 16, 0);
        let results = vec![make_scan_result(
            "r",
            vec![a1.clone(), a2.clone()],
            HashSet::new(),
            vec![a1, a2],
        )];
        app.load_scan_results(&results);
        app.rows[0].selected = true;
        assert_eq!(app.selected_size_gb(), 8);
    }

    #[test]
    fn test_total_size_gb() {
        let mut app = App::new_scanning("h".into());
        let a1 = make_ami("ami-1", "a", 8, 0);
        let a2 = make_ami("ami-2", "b", 16, 0);
        let results = vec![make_scan_result(
            "r",
            vec![a1.clone(), a2.clone()],
            HashSet::new(),
            vec![a1, a2],
        )];
        app.load_scan_results(&results);
        assert_eq!(app.total_size_gb(), 24);
    }

    // -- Status count tests --

    #[test]
    fn test_deleted_count() {
        let mut app = App::new_scanning("h".into());
        let a = make_ami("ami-1", "a", 8, 0);
        let results = vec![make_scan_result(
            "r",
            vec![a.clone()],
            HashSet::new(),
            vec![a],
        )];
        app.load_scan_results(&results);
        assert_eq!(app.deleted_count(), 0);
        app.rows[0].status = AmiStatus::Deleted;
        assert_eq!(app.deleted_count(), 1);
    }

    #[test]
    fn test_failed_count() {
        let mut app = App::new_scanning("h".into());
        let a = make_ami("ami-1", "a", 8, 0);
        let results = vec![make_scan_result(
            "r",
            vec![a.clone()],
            HashSet::new(),
            vec![a],
        )];
        app.load_scan_results(&results);
        app.rows[0].status = AmiStatus::Failed("err".into());
        assert_eq!(app.failed_count(), 1);
    }

    // -- Mark status tests --

    #[test]
    fn test_mark_deleted() {
        let mut app = App::new_scanning("h".into());
        let a = make_ami("ami-1", "a", 8, 0);
        let results = vec![make_scan_result(
            "r",
            vec![a.clone()],
            HashSet::new(),
            vec![a],
        )];
        app.load_scan_results(&results);
        app.rows[0].selected = true;
        app.mark_deleted("ami-1");
        assert_eq!(app.rows[0].status, AmiStatus::Deleted);
        assert!(!app.rows[0].selected);
    }

    #[test]
    fn test_mark_deleted_nonexistent() {
        let mut app = App::new_scanning("h".into());
        let a = make_ami("ami-1", "a", 8, 0);
        let results = vec![make_scan_result(
            "r",
            vec![a.clone()],
            HashSet::new(),
            vec![a],
        )];
        app.load_scan_results(&results);
        app.mark_deleted("ami-999");
        assert_eq!(app.rows[0].status, AmiStatus::Pending);
    }

    #[test]
    fn test_mark_failed() {
        let mut app = App::new_scanning("h".into());
        let a = make_ami("ami-1", "a", 8, 0);
        let results = vec![make_scan_result(
            "r",
            vec![a.clone()],
            HashSet::new(),
            vec![a],
        )];
        app.load_scan_results(&results);
        app.rows[0].selected = true;
        app.mark_failed("ami-1", "access denied".into());
        assert_eq!(
            app.rows[0].status,
            AmiStatus::Failed("access denied".into())
        );
        assert!(!app.rows[0].selected);
    }

    // -- has_deleting --

    #[test]
    fn test_has_deleting() {
        let mut app = App::new_scanning("h".into());
        let a = make_ami("ami-1", "a", 8, 0);
        let results = vec![make_scan_result(
            "r",
            vec![a.clone()],
            HashSet::new(),
            vec![a],
        )];
        app.load_scan_results(&results);
        assert!(!app.has_deleting());
        app.rows[0].status = AmiStatus::Deleting;
        assert!(app.has_deleting());
    }

    // -- Sort tests --

    #[test]
    fn test_cycle_sort_full_cycle() {
        let mut app = App::new_select_profile(vec![]);
        assert_eq!(app.sort_field, SortField::Default);
        let expected = vec![
            (SortField::Age, SortOrder::Desc),
            (SortField::Age, SortOrder::Asc),
            (SortField::LastLaunched, SortOrder::Desc),
            (SortField::LastLaunched, SortOrder::Asc),
            (SortField::Size, SortOrder::Desc),
            (SortField::Size, SortOrder::Asc),
            (SortField::Name, SortOrder::Asc),
            (SortField::Name, SortOrder::Desc),
            (SortField::Default, SortOrder::Desc),
        ];
        for (field, order) in expected {
            app.cycle_sort();
            assert_eq!(app.sort_field, field);
            assert_eq!(app.sort_order, order);
        }
    }

    #[test]
    fn test_sort_label() {
        let mut app = App::new_select_profile(vec![]);
        assert_eq!(app.sort_label(), "");

        app.sort_field = SortField::Age;
        app.sort_order = SortOrder::Desc;
        assert_eq!(app.sort_label(), " Age↓");

        app.sort_field = SortField::Age;
        app.sort_order = SortOrder::Asc;
        assert_eq!(app.sort_label(), " Age↑");

        app.sort_field = SortField::LastLaunched;
        app.sort_order = SortOrder::Desc;
        assert_eq!(app.sort_label(), " Launched↓");

        app.sort_field = SortField::Size;
        app.sort_order = SortOrder::Asc;
        assert_eq!(app.sort_label(), " Size↑");

        app.sort_field = SortField::Name;
        app.sort_order = SortOrder::Asc;
        assert_eq!(app.sort_label(), " Name↑");

        app.sort_field = SortField::Name;
        app.sort_order = SortOrder::Desc;
        assert_eq!(app.sort_label(), " Name↓");
    }

    #[test]
    fn test_apply_sort_by_age() {
        let mut app = App::new_scanning("h".into());
        let mut old = make_ami("ami-old", "old", 8, 0);
        old.creation_date = Some(Utc::now() - Duration::days(100));
        let mut new = make_ami("ami-new", "new", 8, 0);
        new.creation_date = Some(Utc::now() - Duration::days(10));
        let results = vec![make_scan_result(
            "r",
            vec![old.clone(), new.clone()],
            HashSet::new(),
            vec![old, new],
        )];
        app.load_scan_results(&results);

        app.sort_field = SortField::Age;
        app.sort_order = SortOrder::Desc;
        app.apply_sort();
        assert_eq!(app.rows[0].ami.ami_id, "ami-old");

        app.sort_order = SortOrder::Asc;
        app.apply_sort();
        assert_eq!(app.rows[0].ami.ami_id, "ami-new");
    }

    #[test]
    fn test_apply_sort_by_size() {
        let mut app = App::new_scanning("h".into());
        let small = make_ami("ami-s", "small", 8, 0);
        let large = make_ami("ami-l", "large", 100, 0);
        let results = vec![make_scan_result(
            "r",
            vec![small.clone(), large.clone()],
            HashSet::new(),
            vec![small, large],
        )];
        app.load_scan_results(&results);

        app.sort_field = SortField::Size;
        app.sort_order = SortOrder::Desc;
        app.apply_sort();
        assert_eq!(app.rows[0].ami.ami_id, "ami-l");
    }

    #[test]
    fn test_apply_sort_by_name() {
        let mut app = App::new_scanning("h".into());
        let a = make_ami("ami-a", "alpha", 8, 0);
        let z = make_ami("ami-z", "zulu", 8, 0);
        let results = vec![make_scan_result(
            "r",
            vec![z.clone(), a.clone()],
            HashSet::new(),
            vec![z, a],
        )];
        app.load_scan_results(&results);

        app.sort_field = SortField::Name;
        app.sort_order = SortOrder::Asc;
        app.apply_sort();
        assert_eq!(app.rows[0].ami.name, "alpha");

        app.sort_order = SortOrder::Desc;
        app.apply_sort();
        assert_eq!(app.rows[0].ami.name, "zulu");
    }

    // -- Key handling tests --

    #[test]
    fn test_ctrl_c_quits_all_modes() {
        for mode in [
            AppMode::SelectOwner,
            AppMode::SelectConsumers,
            AppMode::Scanning,
            AppMode::Browse,
            AppMode::Confirm,
            AppMode::Done,
        ] {
            let mut app = App::new_select_profile(vec!["test".into()]);
            app.mode = mode.clone();
            assert!(
                matches!(app.handle_key(ctrl_c()), AppAction::Quit),
                "Ctrl+C should quit in {mode:?}"
            );
        }
    }

    #[test]
    fn test_select_owner_navigation() {
        let mut app = App::new_select_profile(vec!["a".into(), "b".into(), "c".into()]);
        assert_eq!(app.profile_selector.cursor, 0);

        app.handle_key(key(KeyCode::Down));
        assert_eq!(app.profile_selector.cursor, 1);

        app.handle_key(key(KeyCode::Char('j')));
        assert_eq!(app.profile_selector.cursor, 2);

        app.handle_key(key(KeyCode::Down));
        assert_eq!(app.profile_selector.cursor, 2);

        app.handle_key(key(KeyCode::Up));
        assert_eq!(app.profile_selector.cursor, 1);

        app.handle_key(key(KeyCode::Char('k')));
        assert_eq!(app.profile_selector.cursor, 0);

        app.handle_key(key(KeyCode::Up));
        assert_eq!(app.profile_selector.cursor, 0);
    }

    #[test]
    fn test_select_owner_enter_transitions() {
        let mut app = App::new_select_profile(vec!["dev".into(), "prod".into()]);
        app.handle_key(key(KeyCode::Down));
        app.handle_key(key(KeyCode::Enter));
        assert_eq!(app.profile_selector.owner_profile, Some("prod".into()));
        assert_eq!(app.mode, AppMode::SelectConsumers);
        assert_eq!(app.profile_selector.cursor, 0);
    }

    #[test]
    fn test_select_owner_space_selects() {
        let mut app = App::new_select_profile(vec!["dev".into()]);
        app.handle_key(key(KeyCode::Char(' ')));
        assert_eq!(app.profile_selector.owner_profile, Some("dev".into()));
        assert_eq!(app.mode, AppMode::SelectConsumers);
    }

    #[test]
    fn test_select_owner_q_quits() {
        let mut app = App::new_select_profile(vec!["dev".into()]);
        assert!(matches!(
            app.handle_key(key(KeyCode::Char('q'))),
            AppAction::Quit
        ));
    }

    #[test]
    fn test_select_consumers_toggle_and_enter() {
        let mut app = App::new_select_profile(vec!["dev".into(), "stg".into(), "prod".into()]);
        app.handle_key(key(KeyCode::Enter));
        assert_eq!(app.mode, AppMode::SelectConsumers);

        app.handle_key(key(KeyCode::Down));
        app.handle_key(key(KeyCode::Char(' ')));
        assert!(app.profile_selector.selected[1]);

        app.handle_key(key(KeyCode::Up));
        app.handle_key(key(KeyCode::Char(' ')));
        assert!(!app.profile_selector.selected[0]);

        let action = app.handle_key(key(KeyCode::Enter));
        assert!(matches!(action, AppAction::StartScan));
        assert_eq!(app.mode, AppMode::Scanning);
        assert_eq!(
            app.profile_selector.consumer_profiles,
            vec!["stg".to_string()]
        );
    }

    #[test]
    fn test_browse_navigation() {
        let mut app = App::new_scanning("h".into());
        let amis: Vec<OwnedAmi> = (0..3)
            .map(|i| make_ami(&format!("ami-{i}"), &format!("n{i}"), 8, 0))
            .collect();
        let results = vec![make_scan_result("r", amis.clone(), HashSet::new(), amis)];
        app.load_scan_results(&results);

        app.handle_key(key(KeyCode::Down));
        assert_eq!(app.cursor, 1);
        app.handle_key(key(KeyCode::Down));
        assert_eq!(app.cursor, 2);
        app.handle_key(key(KeyCode::Down));
        assert_eq!(app.cursor, 2);
        app.handle_key(key(KeyCode::Up));
        assert_eq!(app.cursor, 1);
    }

    #[test]
    fn test_browse_space_toggle() {
        let mut app = App::new_scanning("h".into());
        let a = make_ami("ami-1", "a", 8, 0);
        let results = vec![make_scan_result(
            "r",
            vec![a.clone()],
            HashSet::new(),
            vec![a],
        )];
        app.load_scan_results(&results);

        app.handle_key(key(KeyCode::Char(' ')));
        assert!(app.rows[0].selected);
        app.handle_key(key(KeyCode::Char(' ')));
        assert!(!app.rows[0].selected);
    }

    #[test]
    fn test_browse_cannot_toggle_non_pending() {
        let mut app = App::new_scanning("h".into());
        let a = make_ami("ami-1", "a", 8, 0);
        let results = vec![make_scan_result(
            "r",
            vec![a.clone()],
            HashSet::new(),
            vec![a],
        )];
        app.load_scan_results(&results);
        app.rows[0].status = AmiStatus::Deleted;
        app.handle_key(key(KeyCode::Char(' ')));
        assert!(!app.rows[0].selected);
    }

    #[test]
    fn test_browse_select_all_toggle() {
        let mut app = App::new_scanning("h".into());
        let a1 = make_ami("ami-1", "a", 8, 0);
        let a2 = make_ami("ami-2", "b", 8, 0);
        let results = vec![make_scan_result(
            "r",
            vec![a1.clone(), a2.clone()],
            HashSet::new(),
            vec![a1, a2],
        )];
        app.load_scan_results(&results);

        app.handle_key(key(KeyCode::Char('a')));
        assert!(app.rows.iter().all(|r| r.selected));
        app.handle_key(key(KeyCode::Char('a')));
        assert!(app.rows.iter().all(|r| !r.selected));
    }

    #[test]
    fn test_browse_select_all_skips_non_pending() {
        let mut app = App::new_scanning("h".into());
        let a1 = make_ami("ami-1", "a", 8, 0);
        let a2 = make_ami("ami-2", "b", 8, 0);
        let results = vec![make_scan_result(
            "r",
            vec![a1.clone(), a2.clone()],
            HashSet::new(),
            vec![a1, a2],
        )];
        app.load_scan_results(&results);
        app.rows[0].status = AmiStatus::Deleted;

        app.handle_key(key(KeyCode::Char('a')));
        assert!(!app.rows[0].selected);
        assert!(app.rows[1].selected);
    }

    #[test]
    fn test_browse_sort_key() {
        let mut app = App::new_scanning("h".into());
        let a = make_ami("ami-1", "a", 8, 0);
        let results = vec![make_scan_result(
            "r",
            vec![a.clone()],
            HashSet::new(),
            vec![a],
        )];
        app.load_scan_results(&results);
        assert_eq!(app.sort_field, SortField::Default);
        app.handle_key(key(KeyCode::Char('s')));
        assert_eq!(app.sort_field, SortField::Age);
    }

    #[test]
    fn test_browse_delete_enters_confirm() {
        let mut app = App::new_scanning("h".into());
        let a = make_ami("ami-1", "a", 8, 0);
        let results = vec![make_scan_result(
            "r",
            vec![a.clone()],
            HashSet::new(),
            vec![a],
        )];
        app.load_scan_results(&results);
        app.rows[0].selected = true;
        app.handle_key(key(KeyCode::Char('d')));
        assert_eq!(app.mode, AppMode::Confirm);
    }

    #[test]
    fn test_browse_delete_no_selection_stays() {
        let mut app = App::new_scanning("h".into());
        let a = make_ami("ami-1", "a", 8, 0);
        let results = vec![make_scan_result(
            "r",
            vec![a.clone()],
            HashSet::new(),
            vec![a],
        )];
        app.load_scan_results(&results);
        app.handle_key(key(KeyCode::Char('d')));
        assert_eq!(app.mode, AppMode::Browse);
    }

    #[test]
    fn test_browse_home_end_g() {
        let mut app = App::new_scanning("h".into());
        let amis: Vec<OwnedAmi> = (0..5)
            .map(|i| make_ami(&format!("ami-{i}"), &format!("n{i}"), 8, 0))
            .collect();
        let results = vec![make_scan_result("r", amis.clone(), HashSet::new(), amis)];
        app.load_scan_results(&results);

        app.handle_key(key(KeyCode::End));
        assert_eq!(app.cursor, 4);
        app.handle_key(key(KeyCode::Home));
        assert_eq!(app.cursor, 0);
        app.handle_key(key(KeyCode::Char('G')));
        assert_eq!(app.cursor, 4);
        app.handle_key(key(KeyCode::Char('g')));
        assert_eq!(app.cursor, 0);
    }

    #[test]
    fn test_confirm_yes_starts_deletion() {
        let mut app = App::new_scanning("h".into());
        let a = make_ami("ami-1", "a", 8, 0);
        let results = vec![make_scan_result(
            "r",
            vec![a.clone()],
            HashSet::new(),
            vec![a],
        )];
        app.load_scan_results(&results);
        app.rows[0].selected = true;
        app.mode = AppMode::Confirm;

        let action = app.handle_key(key(KeyCode::Char('y')));
        assert!(matches!(action, AppAction::Delete));
        assert_eq!(app.mode, AppMode::Browse);
        assert_eq!(app.rows[0].status, AmiStatus::Deleting);
    }

    #[test]
    fn test_confirm_cancel() {
        let mut app = App::new_scanning("h".into());
        let a = make_ami("ami-1", "a", 8, 0);
        let results = vec![make_scan_result(
            "r",
            vec![a.clone()],
            HashSet::new(),
            vec![a],
        )];
        app.load_scan_results(&results);
        app.rows[0].selected = true;
        app.mode = AppMode::Confirm;

        let action = app.handle_key(key(KeyCode::Char('n')));
        assert!(matches!(action, AppAction::None));
        assert_eq!(app.mode, AppMode::Browse);
        assert_eq!(app.rows[0].status, AmiStatus::Pending);
    }

    #[test]
    fn test_done_mode_keys() {
        let mut app = App::new_scanning("h".into());

        app.mode = AppMode::Done;
        assert!(matches!(
            app.handle_key(key(KeyCode::Char('q'))),
            AppAction::Quit
        ));

        app.mode = AppMode::Done;
        assert!(matches!(app.handle_key(key(KeyCode::Esc)), AppAction::Quit));

        app.mode = AppMode::Done;
        assert!(matches!(
            app.handle_key(key(KeyCode::Enter)),
            AppAction::Quit
        ));

        app.mode = AppMode::Done;
        assert!(matches!(
            app.handle_key(key(KeyCode::Char('x'))),
            AppAction::None
        ));
    }

    #[test]
    fn test_scanning_q_quits() {
        let mut app = App::new_scanning("h".into());
        assert!(matches!(
            app.handle_key(key(KeyCode::Char('q'))),
            AppAction::Quit
        ));
    }

    #[test]
    fn test_scanning_esc_quits() {
        let mut app = App::new_scanning("h".into());
        assert!(matches!(app.handle_key(key(KeyCode::Esc)), AppAction::Quit));
    }

    #[test]
    fn test_scanning_other_keys_noop() {
        let mut app = App::new_scanning("h".into());
        assert!(matches!(
            app.handle_key(key(KeyCode::Char('x'))),
            AppAction::None
        ));
    }

    // -- Scroll tests --

    #[test]
    fn test_adjust_scroll() {
        let mut app = App::new_scanning("h".into());
        let amis: Vec<OwnedAmi> = (0..20)
            .map(|i| make_ami(&format!("ami-{i}"), &format!("n{i}"), 8, 0))
            .collect();
        let results = vec![make_scan_result("r", amis.clone(), HashSet::new(), amis)];
        app.load_scan_results(&results);

        app.cursor = 15;
        app.adjust_scroll(10);
        assert_eq!(app.scroll_offset, 6);

        app.cursor = 3;
        app.adjust_scroll(10);
        assert_eq!(app.scroll_offset, 3);

        app.cursor = 8;
        app.adjust_scroll(10);
        assert_eq!(app.scroll_offset, 3);
    }
}
