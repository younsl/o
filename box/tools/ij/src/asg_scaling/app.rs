//! ASG Scaling tab: app state, modes, and key handling.

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use nucleo::Matcher;

use super::aws::AsgInfo;

const SPINNER_FRAMES: &[char] = &['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ---------------------------------------------------------------------------
// Row status
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum RowStatus {
    Pending,
    Applied,
    Failed(String),
}

// ---------------------------------------------------------------------------
// ASG row (wraps AsgInfo with UI state)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct AsgRow {
    pub info: AsgInfo,
    pub selected: bool,
    pub new_min: Option<i32>,
    pub new_max: Option<i32>,
    pub new_desired: Option<i32>,
    pub status: RowStatus,
}

impl AsgRow {
    pub fn from_info(info: AsgInfo) -> Self {
        Self {
            info,
            selected: false,
            new_min: None,
            new_max: None,
            new_desired: None,
            status: RowStatus::Pending,
        }
    }

    /// Format as a row string for the picker list.
    pub fn to_row(&self, widths: &ColWidths) -> String {
        format!(
            "{:<w0$}  {:>w1$}  {:>w2$}  {:>w3$}  {:>w4$}  {:<w5$}",
            self.info.name,
            self.info.instances_count,
            self.info.desired_capacity,
            self.info.min_size,
            self.info.max_size,
            self.info.region,
            w0 = widths.name,
            w1 = widths.instances,
            w2 = widths.desired,
            w3 = widths.min,
            w4 = widths.max,
            w5 = widths.region,
        )
    }

    /// Clear any pending changes.
    pub fn clear_changes(&mut self) {
        self.new_min = None;
        self.new_max = None;
        self.new_desired = None;
    }

    /// Apply multiplier to this row's values.
    pub fn apply_multiplier(&mut self, multiplier: i32) {
        self.new_min = Some(self.info.min_size * multiplier);
        self.new_max = Some(self.info.max_size * multiplier);
        self.new_desired = Some(self.info.desired_capacity * multiplier);
    }

    /// Apply absolute values.
    pub fn apply_absolute(&mut self, min: i32, max: i32, desired: i32) {
        self.new_min = Some(min);
        self.new_max = Some(max);
        self.new_desired = Some(desired);
    }

    /// Whether this row has pending changes.
    pub fn has_changes(&self) -> bool {
        self.new_min.is_some() || self.new_max.is_some() || self.new_desired.is_some()
    }
}

// ---------------------------------------------------------------------------
// Column widths
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ColWidths {
    pub name: usize,
    pub min: usize,
    pub max: usize,
    pub desired: usize,
    pub instances: usize,
    pub region: usize,
}

impl ColWidths {
    pub fn from_rows(rows: &[AsgRow]) -> Self {
        rows.iter().fold(
            Self {
                name: 4,      // "NAME"
                min: 3,       // "MIN"
                max: 3,       // "MAX"
                desired: 7,   // "DESIRED"
                instances: 9, // "INSTANCES"
                region: 6,    // "REGION"
            },
            |mut w, r| {
                w.name = w.name.max(r.info.name.len());
                w.min = w.min.max(digit_width(r.info.min_size));
                w.max = w.max.max(digit_width(r.info.max_size));
                w.desired = w.desired.max(digit_width(r.info.desired_capacity));
                w.instances = w.instances.max(digit_width(r.info.instances_count as i32));
                w.region = w.region.max(r.info.region.len());
                w
            },
        )
    }

    /// Build header columns as (formatted_text, is_sorted) pairs
    /// so the UI can apply distinct styles to the sorted column.
    pub fn header_columns(
        &self,
        sort_field: SortField,
        sort_order: SortOrder,
    ) -> Vec<(String, bool)> {
        let arrow = match sort_order {
            SortOrder::Asc => "↑",
            SortOrder::Desc => "↓",
        };

        let cols: &[(&str, SortField, usize, bool)] = &[
            ("NAME", SortField::Name, self.name, false),
            ("INSTANCES", SortField::Instances, self.instances, true),
            ("DESIRED", SortField::Desired, self.desired, true),
            ("MIN", SortField::Min, self.min, true),
            ("MAX", SortField::Max, self.max, true),
            ("REGION", SortField::Region, self.region, false),
        ];

        cols.iter()
            .map(|(name, field, width, right_align)| {
                let is_sorted = sort_field == *field && sort_field != SortField::Default;
                let label = if is_sorted {
                    format!("{name}{arrow}")
                } else {
                    name.to_string()
                };
                let formatted = if *right_align {
                    format!("{:>w$}", label, w = *width)
                } else {
                    format!("{:<w$}", label, w = *width)
                };
                (formatted, is_sorted)
            })
            .collect()
    }
}

fn digit_width(n: i32) -> usize {
    if n == 0 {
        return 1;
    }
    let abs = n.unsigned_abs();
    let digits = (abs as f64).log10().floor() as usize + 1;
    if n < 0 { digits + 1 } else { digits }
}

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SortField {
    Default,
    Name,
    Instances,
    Desired,
    Min,
    Max,
    Region,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SortOrder {
    Asc,
    Desc,
}

impl SortField {
    /// Cycle: Default → Name↑ → Name↓ → Instances↓ → Instances↑ → Desired↓ → Desired↑
    ///        → Min↓ → Min↑ → Max↓ → Max↑ → Region↑ → Region↓ → Default
    fn cycle(self, order: SortOrder) -> (SortField, SortOrder) {
        match (self, order) {
            (Self::Default, _) => (Self::Name, SortOrder::Asc),
            (Self::Name, SortOrder::Asc) => (Self::Name, SortOrder::Desc),
            (Self::Name, SortOrder::Desc) => (Self::Instances, SortOrder::Desc),
            (Self::Instances, SortOrder::Desc) => (Self::Instances, SortOrder::Asc),
            (Self::Instances, SortOrder::Asc) => (Self::Desired, SortOrder::Desc),
            (Self::Desired, SortOrder::Desc) => (Self::Desired, SortOrder::Asc),
            (Self::Desired, SortOrder::Asc) => (Self::Min, SortOrder::Desc),
            (Self::Min, SortOrder::Desc) => (Self::Min, SortOrder::Asc),
            (Self::Min, SortOrder::Asc) => (Self::Max, SortOrder::Desc),
            (Self::Max, SortOrder::Desc) => (Self::Max, SortOrder::Asc),
            (Self::Max, SortOrder::Asc) => (Self::Region, SortOrder::Asc),
            (Self::Region, SortOrder::Asc) => (Self::Region, SortOrder::Desc),
            (Self::Region, SortOrder::Desc) => (Self::Default, SortOrder::Desc),
        }
    }
}

// ---------------------------------------------------------------------------
// Input field for absolute value entry
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum InputField {
    Min,
    Max,
    Desired,
}

impl InputField {
    pub fn next(self) -> Self {
        match self {
            Self::Min => Self::Max,
            Self::Max => Self::Desired,
            Self::Desired => Self::Min,
        }
    }

    pub fn prev(self) -> Self {
        match self {
            Self::Min => Self::Desired,
            Self::Max => Self::Min,
            Self::Desired => Self::Max,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Min => "Min",
            Self::Max => "Max",
            Self::Desired => "Desired",
        }
    }
}

// ---------------------------------------------------------------------------
// App mode
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum AppMode {
    Scanning,
    Browse,
    ScaleMenu,
    InputAbsolute,
    Preview,
    Applying,
    Done,
    Error(String),
}

// ---------------------------------------------------------------------------
// App action (returned from key handler)
// ---------------------------------------------------------------------------

pub enum AppAction {
    None,
    Quit,
    /// Trigger apply for selected rows that have changes.
    Apply,
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

pub struct App {
    pub rows: Vec<AsgRow>,
    pub items: Vec<String>,
    pub widths: ColWidths,
    pub cursor: usize,
    pub scroll_offset: usize,
    pub mode: AppMode,

    // Sort
    pub sort_field: SortField,
    pub sort_order: SortOrder,

    // Scanning
    pub scan_spinner_frame: usize,
    pub scan_start: Option<std::time::Instant>,
    pub scan_regions_display: String,

    // Fuzzy filter
    pub query: String,
    pub filtered_indices: Vec<(usize, u32)>,
    pub matcher: Matcher,

    // Absolute input
    pub input_field: InputField,
    pub input_min: String,
    pub input_max: String,
    pub input_desired: String,

    // Preview confirm
    pub confirm_input: String,
    pub confirm_error: bool,
    pub preview_label: String,

    // Apply results
    pub apply_logs: Vec<String>,
}

impl App {
    pub fn new_scanning(regions_display: String) -> Self {
        Self {
            rows: Vec::new(),
            items: Vec::new(),
            widths: ColWidths {
                name: 4,
                min: 3,
                max: 3,
                desired: 7,
                instances: 9,
                region: 6,
            },
            cursor: 0,
            scroll_offset: 0,
            mode: AppMode::Scanning,
            sort_field: SortField::Default,
            sort_order: SortOrder::Desc,
            scan_spinner_frame: 0,
            scan_start: Some(std::time::Instant::now()),
            scan_regions_display: regions_display,
            query: String::new(),
            filtered_indices: Vec::new(),
            matcher: nucleo::Matcher::new(nucleo::Config::DEFAULT),
            input_field: InputField::Min,
            input_min: String::new(),
            input_max: String::new(),
            input_desired: String::new(),
            confirm_input: String::new(),
            confirm_error: false,
            preview_label: String::new(),
            apply_logs: Vec::new(),
        }
    }

    pub fn tick_spinner(&mut self) {
        self.scan_spinner_frame = self.scan_spinner_frame.wrapping_add(1);
    }

    pub fn spinner_char(&self) -> char {
        SPINNER_FRAMES[self.scan_spinner_frame % SPINNER_FRAMES.len()]
    }

    pub fn scan_elapsed_secs(&self) -> u64 {
        self.scan_start.map(|s| s.elapsed().as_secs()).unwrap_or(0)
    }

    /// Load ASG scan results into the app.
    pub fn load_results(&mut self, asgs: Vec<AsgInfo>) {
        self.rows = asgs.into_iter().map(AsgRow::from_info).collect();
        self.widths = ColWidths::from_rows(&self.rows);
        self.items = self.rows.iter().map(|r| r.to_row(&self.widths)).collect();
        self.filtered_indices = (0..self.rows.len()).map(|i| (i, 0)).collect();
        self.cursor = 0;
        self.scroll_offset = 0;
        self.query.clear();
        self.mode = AppMode::Browse;
    }

    pub fn set_error(&mut self, msg: String) {
        self.mode = AppMode::Error(msg);
    }

    /// Count of selected rows.
    pub fn selected_count(&self) -> usize {
        self.rows.iter().filter(|r| r.selected).count()
    }

    // -----------------------------------------------------------------------
    // Fuzzy filter
    // -----------------------------------------------------------------------

    pub fn update_filter(&mut self) {
        if self.query.is_empty() {
            self.filtered_indices = (0..self.items.len()).map(|i| (i, 0)).collect();
        } else {
            let pattern = nucleo::pattern::Pattern::parse(
                &self.query,
                nucleo::pattern::CaseMatching::Smart,
                nucleo::pattern::Normalization::Smart,
            );
            let mut results: Vec<(usize, u32)> = Vec::new();
            for (idx, item) in self.items.iter().enumerate() {
                let mut buf = Vec::new();
                let haystack = nucleo::Utf32Str::new(item, &mut buf);
                if let Some(score) = pattern.score(haystack, &mut self.matcher) {
                    results.push((idx, score));
                }
            }
            results.sort_by(|a, b| b.1.cmp(&a.1));
            self.filtered_indices = results;
        }

        if self.cursor >= self.filtered_indices.len() {
            self.cursor = self.filtered_indices.len().saturating_sub(1);
        }
    }

    // -----------------------------------------------------------------------
    // Sort
    // -----------------------------------------------------------------------

    /// Cycle to the next sort field/order and re-sort.
    pub fn toggle_sort(&mut self) {
        (self.sort_field, self.sort_order) = self.sort_field.cycle(self.sort_order);
        self.apply_sort();
    }

    /// Sort rows in place, then rebuild items and filter.
    pub fn apply_sort(&mut self) {
        match self.sort_field {
            SortField::Default => {
                self.rows.sort_by(|a, b| {
                    a.info
                        .region
                        .cmp(&b.info.region)
                        .then_with(|| a.info.name.cmp(&b.info.name))
                });
            }
            SortField::Name => self.rows.sort_by(|a, b| {
                let cmp = a.info.name.cmp(&b.info.name);
                if self.sort_order == SortOrder::Desc {
                    cmp.reverse()
                } else {
                    cmp
                }
            }),
            SortField::Instances => self.rows.sort_by(|a, b| {
                let cmp = a.info.instances_count.cmp(&b.info.instances_count);
                if self.sort_order == SortOrder::Desc {
                    cmp.reverse()
                } else {
                    cmp
                }
            }),
            SortField::Desired => self.rows.sort_by(|a, b| {
                let cmp = a.info.desired_capacity.cmp(&b.info.desired_capacity);
                if self.sort_order == SortOrder::Desc {
                    cmp.reverse()
                } else {
                    cmp
                }
            }),
            SortField::Min => self.rows.sort_by(|a, b| {
                let cmp = a.info.min_size.cmp(&b.info.min_size);
                if self.sort_order == SortOrder::Desc {
                    cmp.reverse()
                } else {
                    cmp
                }
            }),
            SortField::Max => self.rows.sort_by(|a, b| {
                let cmp = a.info.max_size.cmp(&b.info.max_size);
                if self.sort_order == SortOrder::Desc {
                    cmp.reverse()
                } else {
                    cmp
                }
            }),
            SortField::Region => self.rows.sort_by(|a, b| {
                let cmp = a.info.region.cmp(&b.info.region);
                if self.sort_order == SortOrder::Desc {
                    cmp.reverse()
                } else {
                    cmp
                }
            }),
        }
        self.rebuild_items();
    }

    /// Rebuild items and filter from current rows order.
    fn rebuild_items(&mut self) {
        self.widths = ColWidths::from_rows(&self.rows);
        self.items = self.rows.iter().map(|r| r.to_row(&self.widths)).collect();
        self.cursor = 0;
        self.update_filter();
    }

    // -----------------------------------------------------------------------
    // Apply multiplier/absolute to selected rows
    // -----------------------------------------------------------------------

    fn apply_multiplier_to_selected(&mut self, multiplier: i32) {
        for row in &mut self.rows {
            if row.selected {
                row.apply_multiplier(multiplier);
            }
        }
        self.preview_label = format!("x{multiplier}");
    }

    fn apply_absolute_to_selected(&mut self) -> bool {
        let min: i32 = match self.input_min.parse() {
            Ok(v) => v,
            Err(_) => return false,
        };
        let max: i32 = match self.input_max.parse() {
            Ok(v) => v,
            Err(_) => return false,
        };
        let desired: i32 = match self.input_desired.parse() {
            Ok(v) => v,
            Err(_) => return false,
        };

        if min < 0 || max < 0 || desired < 0 || min > max || desired < min || desired > max {
            return false;
        }

        for row in &mut self.rows {
            if row.selected {
                row.apply_absolute(min, max, desired);
            }
        }
        self.preview_label = "absolute".to_string();
        true
    }

    fn clear_selected_changes(&mut self) {
        for row in &mut self.rows {
            if row.selected {
                row.clear_changes();
            }
        }
    }

    // -----------------------------------------------------------------------
    // Key handling
    // -----------------------------------------------------------------------

    pub fn handle_key(&mut self, key: KeyEvent) -> AppAction {
        if key.kind != KeyEventKind::Press {
            return AppAction::None;
        }

        // Global Ctrl+C
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            return AppAction::Quit;
        }

        match &self.mode {
            AppMode::Scanning => self.handle_key_scanning(key),
            AppMode::Browse => self.handle_key_browse(key),
            AppMode::ScaleMenu => self.handle_key_scale_menu(key),
            AppMode::InputAbsolute => self.handle_key_input_absolute(key),
            AppMode::Preview => self.handle_key_preview(key),
            AppMode::Applying => AppAction::None,
            AppMode::Done | AppMode::Error(_) => self.handle_key_done(key),
        }
    }

    fn handle_key_scanning(&mut self, key: KeyEvent) -> AppAction {
        match key.code {
            KeyCode::Esc | KeyCode::Char('q') => AppAction::Quit,
            _ => AppAction::None,
        }
    }

    fn handle_key_browse(&mut self, key: KeyEvent) -> AppAction {
        match (key.code, key.modifiers) {
            (KeyCode::Esc, _) => {
                if !self.query.is_empty() {
                    self.query.clear();
                    self.cursor = 0;
                    self.update_filter();
                    AppAction::None
                } else {
                    AppAction::Quit
                }
            }
            (KeyCode::Char('q'), KeyModifiers::NONE) if self.query.is_empty() => AppAction::Quit,

            // Navigation
            (KeyCode::Up, _) | (KeyCode::Char('k'), KeyModifiers::NONE)
                if self.query.is_empty() =>
            {
                self.move_up();
                AppAction::None
            }
            (KeyCode::Down, _) | (KeyCode::Char('j'), KeyModifiers::NONE)
                if self.query.is_empty() =>
            {
                self.move_down();
                AppAction::None
            }
            (KeyCode::Char('p'), KeyModifiers::CONTROL) => {
                self.move_up();
                AppAction::None
            }
            (KeyCode::Char('n'), KeyModifiers::CONTROL) => {
                self.move_down();
                AppAction::None
            }
            (KeyCode::PageUp, _) | (KeyCode::Left, _) => {
                self.cursor = self.cursor.saturating_sub(10);
                AppAction::None
            }
            (KeyCode::PageDown, _) | (KeyCode::Right, _) => {
                let max = self.filtered_indices.len().saturating_sub(1);
                self.cursor = (self.cursor + 10).min(max);
                AppAction::None
            }
            (KeyCode::Home, _) => {
                self.cursor = 0;
                AppAction::None
            }
            (KeyCode::End, _) => {
                self.cursor = self.filtered_indices.len().saturating_sub(1);
                AppAction::None
            }

            // Selection
            (KeyCode::Char(' '), _) => {
                self.toggle_current();
                AppAction::None
            }
            (KeyCode::Char('a'), KeyModifiers::NONE) if self.query.is_empty() => {
                self.toggle_all();
                AppAction::None
            }

            // Sort
            (KeyCode::Char('o'), KeyModifiers::NONE) if self.query.is_empty() => {
                self.toggle_sort();
                AppAction::None
            }

            // Scale menu
            (KeyCode::Char('s'), KeyModifiers::NONE) if self.query.is_empty() => {
                if self.selected_count() > 0 {
                    self.mode = AppMode::ScaleMenu;
                }
                AppAction::None
            }

            // Search
            (KeyCode::Backspace, _) | (KeyCode::Char('h'), KeyModifiers::CONTROL) => {
                self.query.pop();
                self.cursor = 0;
                self.update_filter();
                AppAction::None
            }
            (KeyCode::Char('u'), KeyModifiers::CONTROL) => {
                self.query.clear();
                self.cursor = 0;
                self.update_filter();
                AppAction::None
            }
            (KeyCode::Char(c), KeyModifiers::NONE | KeyModifiers::SHIFT) => {
                self.query.push(c);
                self.cursor = 0;
                self.update_filter();
                AppAction::None
            }

            (KeyCode::Enter, _) => AppAction::None,
            _ => AppAction::None,
        }
    }

    fn handle_key_scale_menu(&mut self, key: KeyEvent) -> AppAction {
        match key.code {
            KeyCode::Esc => {
                self.mode = AppMode::Browse;
                AppAction::None
            }
            KeyCode::Char('2') => {
                self.apply_multiplier_to_selected(2);
                self.confirm_input.clear();
                self.confirm_error = false;
                self.mode = AppMode::Preview;
                AppAction::None
            }
            KeyCode::Char('3') => {
                self.apply_multiplier_to_selected(3);
                self.confirm_input.clear();
                self.confirm_error = false;
                self.mode = AppMode::Preview;
                AppAction::None
            }
            KeyCode::Char('v') => {
                self.input_field = InputField::Min;
                self.input_min.clear();
                self.input_max.clear();
                self.input_desired.clear();
                self.mode = AppMode::InputAbsolute;
                AppAction::None
            }
            _ => AppAction::None,
        }
    }

    fn handle_key_input_absolute(&mut self, key: KeyEvent) -> AppAction {
        match key.code {
            KeyCode::Esc => {
                self.mode = AppMode::ScaleMenu;
                AppAction::None
            }
            KeyCode::Tab => {
                self.input_field = self.input_field.next();
                AppAction::None
            }
            KeyCode::BackTab => {
                self.input_field = self.input_field.prev();
                AppAction::None
            }
            KeyCode::Backspace => {
                let buf = self.current_input_buf_mut();
                buf.pop();
                AppAction::None
            }
            KeyCode::Char(c) if c.is_ascii_digit() => {
                let buf = self.current_input_buf_mut();
                buf.push(c);
                AppAction::None
            }
            KeyCode::Enter => {
                if self.apply_absolute_to_selected() {
                    self.confirm_input.clear();
                    self.confirm_error = false;
                    self.mode = AppMode::Preview;
                }
                AppAction::None
            }
            _ => AppAction::None,
        }
    }

    fn handle_key_preview(&mut self, key: KeyEvent) -> AppAction {
        match key.code {
            KeyCode::Esc => {
                self.clear_selected_changes();
                self.mode = AppMode::Browse;
                AppAction::None
            }
            KeyCode::Backspace => {
                self.confirm_error = false;
                self.confirm_input.pop();
                AppAction::None
            }
            KeyCode::Char(c) => {
                self.confirm_error = false;
                self.confirm_input.push(c);
                AppAction::None
            }
            KeyCode::Enter => {
                if self.confirm_input.trim().eq_ignore_ascii_case("yes") {
                    self.mode = AppMode::Applying;
                    self.apply_logs.clear();
                    AppAction::Apply
                } else {
                    self.confirm_error = true;
                    self.confirm_input.clear();
                    AppAction::None
                }
            }
            _ => AppAction::None,
        }
    }

    fn handle_key_done(&mut self, key: KeyEvent) -> AppAction {
        match key.code {
            KeyCode::Esc | KeyCode::Char('q') | KeyCode::Enter => AppAction::Quit,
            _ => AppAction::None,
        }
    }

    // -----------------------------------------------------------------------
    // Navigation helpers
    // -----------------------------------------------------------------------

    fn move_up(&mut self) {
        if self.filtered_indices.is_empty() {
            return;
        }
        if self.cursor > 0 {
            self.cursor -= 1;
        } else {
            self.cursor = self.filtered_indices.len() - 1;
        }
    }

    fn move_down(&mut self) {
        if self.filtered_indices.is_empty() {
            return;
        }
        if self.cursor + 1 < self.filtered_indices.len() {
            self.cursor += 1;
        } else {
            self.cursor = 0;
        }
    }

    fn toggle_current(&mut self) {
        if let Some(&(idx, _)) = self.filtered_indices.get(self.cursor) {
            self.rows[idx].selected = !self.rows[idx].selected;
        }
    }

    fn toggle_all(&mut self) {
        let visible: Vec<usize> = self.filtered_indices.iter().map(|&(i, _)| i).collect();
        let all_selected = visible.iter().all(|&i| self.rows[i].selected);
        for &i in &visible {
            self.rows[i].selected = !all_selected;
        }
    }

    fn current_input_buf_mut(&mut self) -> &mut String {
        match self.input_field {
            InputField::Min => &mut self.input_min,
            InputField::Max => &mut self.input_max,
            InputField::Desired => &mut self.input_desired,
        }
    }

    /// Mark a row as applied.
    pub fn mark_applied(&mut self, name: &str) {
        if let Some(row) = self.rows.iter_mut().find(|r| r.info.name == name) {
            // Update the info to reflect new values
            if let Some(v) = row.new_min {
                row.info.min_size = v;
            }
            if let Some(v) = row.new_max {
                row.info.max_size = v;
            }
            if let Some(v) = row.new_desired {
                row.info.desired_capacity = v;
            }
            row.clear_changes();
            row.selected = false;
            row.status = RowStatus::Applied;
        }
    }

    /// Mark a row as failed.
    pub fn mark_failed(&mut self, name: &str, err: String) {
        if let Some(row) = self.rows.iter_mut().find(|r| r.info.name == name) {
            row.clear_changes();
            row.status = RowStatus::Failed(err);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_info(name: &str, min: i32, max: i32, desired: i32) -> AsgInfo {
        AsgInfo {
            name: name.into(),
            min_size: min,
            max_size: max,
            desired_capacity: desired,
            instances_count: desired as usize,
            region: "us-east-1".into(),
        }
    }

    fn make_app() -> App {
        let mut app = App::new_scanning("us-east-1".into());
        app.load_results(vec![
            make_info("web-asg", 2, 10, 4),
            make_info("api-asg", 1, 5, 2),
            make_info("worker-asg", 3, 20, 6),
        ]);
        app
    }

    // --- AsgRow ---

    #[test]
    fn asg_row_apply_multiplier() {
        let mut row = AsgRow::from_info(make_info("test", 2, 10, 4));
        row.apply_multiplier(2);
        assert_eq!(row.new_min, Some(4));
        assert_eq!(row.new_max, Some(20));
        assert_eq!(row.new_desired, Some(8));
        assert!(row.has_changes());
    }

    #[test]
    fn asg_row_apply_multiplier_x3() {
        let mut row = AsgRow::from_info(make_info("test", 1, 5, 3));
        row.apply_multiplier(3);
        assert_eq!(row.new_min, Some(3));
        assert_eq!(row.new_max, Some(15));
        assert_eq!(row.new_desired, Some(9));
    }

    #[test]
    fn asg_row_apply_absolute() {
        let mut row = AsgRow::from_info(make_info("test", 2, 10, 4));
        row.apply_absolute(5, 50, 25);
        assert_eq!(row.new_min, Some(5));
        assert_eq!(row.new_max, Some(50));
        assert_eq!(row.new_desired, Some(25));
    }

    #[test]
    fn asg_row_clear_changes() {
        let mut row = AsgRow::from_info(make_info("test", 2, 10, 4));
        row.apply_multiplier(2);
        assert!(row.has_changes());
        row.clear_changes();
        assert!(!row.has_changes());
    }

    // --- App loading ---

    #[test]
    fn load_results_sets_browse_mode() {
        let app = make_app();
        assert_eq!(app.mode, AppMode::Browse);
        assert_eq!(app.rows.len(), 3);
        assert_eq!(app.items.len(), 3);
        assert_eq!(app.filtered_indices.len(), 3);
    }

    // --- Selection ---

    #[test]
    fn toggle_current_selects_and_deselects() {
        let mut app = make_app();
        assert!(!app.rows[0].selected);
        app.toggle_current();
        assert!(app.rows[0].selected);
        app.toggle_current();
        assert!(!app.rows[0].selected);
    }

    #[test]
    fn toggle_all_selects_all_when_none_selected() {
        let mut app = make_app();
        app.toggle_all();
        assert!(app.rows.iter().all(|r| r.selected));
        assert_eq!(app.selected_count(), 3);
    }

    #[test]
    fn toggle_all_deselects_all_when_all_selected() {
        let mut app = make_app();
        app.toggle_all();
        app.toggle_all();
        assert!(app.rows.iter().all(|r| !r.selected));
    }

    // --- Navigation ---

    #[test]
    fn move_down_wraps() {
        let mut app = make_app();
        app.cursor = 2;
        app.move_down();
        assert_eq!(app.cursor, 0);
    }

    #[test]
    fn move_up_wraps() {
        let mut app = make_app();
        app.cursor = 0;
        app.move_up();
        assert_eq!(app.cursor, 2);
    }

    // --- Multiplier on selected ---

    #[test]
    fn apply_multiplier_to_selected_only() {
        let mut app = make_app();
        app.rows[0].selected = true;
        app.rows[2].selected = true;
        app.apply_multiplier_to_selected(2);

        assert!(app.rows[0].has_changes());
        assert!(!app.rows[1].has_changes());
        assert!(app.rows[2].has_changes());
        assert_eq!(app.rows[0].new_desired, Some(8)); // 4 * 2
        assert_eq!(app.rows[2].new_desired, Some(12)); // 6 * 2
    }

    // --- Mark applied/failed ---

    #[test]
    fn mark_applied_updates_info() {
        let mut app = make_app();
        app.rows[0].selected = true;
        app.rows[0].apply_multiplier(2);
        app.mark_applied("web-asg");

        assert_eq!(app.rows[0].info.min_size, 4);
        assert_eq!(app.rows[0].info.max_size, 20);
        assert_eq!(app.rows[0].info.desired_capacity, 8);
        assert_eq!(app.rows[0].status, RowStatus::Applied);
        assert!(!app.rows[0].selected);
    }

    #[test]
    fn mark_failed_sets_status() {
        let mut app = make_app();
        app.mark_failed("api-asg", "AccessDenied".into());
        assert!(matches!(app.rows[1].status, RowStatus::Failed(_)));
    }

    // --- Fuzzy filter ---

    #[test]
    fn update_filter_empty_query_shows_all() {
        let mut app = make_app();
        app.query.clear();
        app.update_filter();
        assert_eq!(app.filtered_indices.len(), 3);
    }

    #[test]
    fn update_filter_narrows_results() {
        let mut app = make_app();
        app.query = "web".into();
        app.update_filter();
        assert!(app.filtered_indices.len() >= 1);
        assert_eq!(app.filtered_indices[0].0, 0);
    }

    // --- ColWidths ---

    #[test]
    fn col_widths_from_empty() {
        let widths = ColWidths::from_rows(&[]);
        assert_eq!(widths.name, 4);
        assert_eq!(widths.min, 3);
    }

    // --- digit_width ---

    #[test]
    fn digit_width_values() {
        assert_eq!(digit_width(0), 1);
        assert_eq!(digit_width(1), 1);
        assert_eq!(digit_width(9), 1);
        assert_eq!(digit_width(10), 2);
        assert_eq!(digit_width(100), 3);
        assert_eq!(digit_width(1000), 4);
    }

    // --- InputField ---

    #[test]
    fn input_field_cycle() {
        assert_eq!(InputField::Min.next(), InputField::Max);
        assert_eq!(InputField::Max.next(), InputField::Desired);
        assert_eq!(InputField::Desired.next(), InputField::Min);
    }

    #[test]
    fn input_field_prev_cycle() {
        assert_eq!(InputField::Min.prev(), InputField::Desired);
        assert_eq!(InputField::Max.prev(), InputField::Min);
        assert_eq!(InputField::Desired.prev(), InputField::Max);
    }

    #[test]
    fn input_field_labels() {
        assert_eq!(InputField::Min.label(), "Min");
        assert_eq!(InputField::Max.label(), "Max");
        assert_eq!(InputField::Desired.label(), "Desired");
    }

    // -----------------------------------------------------------------------
    // Key handling: helper
    // -----------------------------------------------------------------------

    fn press(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn press_mod(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, modifiers)
    }

    // --- Scanning mode ---

    #[test]
    fn scanning_quit_on_esc() {
        let mut app = App::new_scanning("us-east-1".into());
        assert!(matches!(
            app.handle_key(press(KeyCode::Esc)),
            AppAction::Quit
        ));
    }

    #[test]
    fn scanning_quit_on_q() {
        let mut app = App::new_scanning("us-east-1".into());
        assert!(matches!(
            app.handle_key(press(KeyCode::Char('q'))),
            AppAction::Quit
        ));
    }

    #[test]
    fn scanning_ignores_other_keys() {
        let mut app = App::new_scanning("us-east-1".into());
        assert!(matches!(
            app.handle_key(press(KeyCode::Char('x'))),
            AppAction::None
        ));
    }

    // --- Browse mode ---

    #[test]
    fn browse_esc_clears_query_first() {
        let mut app = make_app();
        app.query = "web".into();
        assert!(matches!(
            app.handle_key(press(KeyCode::Esc)),
            AppAction::None
        ));
        assert!(app.query.is_empty());
    }

    #[test]
    fn browse_esc_quits_when_query_empty() {
        let mut app = make_app();
        assert!(matches!(
            app.handle_key(press(KeyCode::Esc)),
            AppAction::Quit
        ));
    }

    #[test]
    fn browse_q_quits_when_query_empty() {
        let mut app = make_app();
        assert!(matches!(
            app.handle_key(press(KeyCode::Char('q'))),
            AppAction::Quit
        ));
    }

    #[test]
    fn browse_navigation_j_k() {
        let mut app = make_app();
        app.handle_key(press(KeyCode::Char('j')));
        assert_eq!(app.cursor, 1);
        app.handle_key(press(KeyCode::Char('k')));
        assert_eq!(app.cursor, 0);
    }

    #[test]
    fn browse_navigation_arrows() {
        let mut app = make_app();
        app.handle_key(press(KeyCode::Down));
        assert_eq!(app.cursor, 1);
        app.handle_key(press(KeyCode::Up));
        assert_eq!(app.cursor, 0);
    }

    #[test]
    fn browse_navigation_ctrl_n_p() {
        let mut app = make_app();
        app.handle_key(press_mod(KeyCode::Char('n'), KeyModifiers::CONTROL));
        assert_eq!(app.cursor, 1);
        app.handle_key(press_mod(KeyCode::Char('p'), KeyModifiers::CONTROL));
        assert_eq!(app.cursor, 0);
    }

    #[test]
    fn browse_page_navigation() {
        let mut app = make_app();
        app.handle_key(press(KeyCode::End));
        assert_eq!(app.cursor, 2);
        app.handle_key(press(KeyCode::Home));
        assert_eq!(app.cursor, 0);
    }

    #[test]
    fn browse_space_toggles_without_moving() {
        let mut app = make_app();
        app.handle_key(press(KeyCode::Char(' ')));
        assert!(app.rows[0].selected);
        assert_eq!(app.cursor, 0);
    }

    #[test]
    fn browse_a_toggles_all() {
        let mut app = make_app();
        app.handle_key(press(KeyCode::Char('a')));
        assert_eq!(app.selected_count(), 3);
        app.handle_key(press(KeyCode::Char('a')));
        assert_eq!(app.selected_count(), 0);
    }

    #[test]
    fn browse_s_enters_scale_menu_when_selected() {
        let mut app = make_app();
        app.rows[0].selected = true;
        app.handle_key(press(KeyCode::Char('s')));
        assert_eq!(app.mode, AppMode::ScaleMenu);
    }

    #[test]
    fn browse_s_does_nothing_when_none_selected() {
        let mut app = make_app();
        app.handle_key(press(KeyCode::Char('s')));
        assert_eq!(app.mode, AppMode::Browse);
    }

    #[test]
    fn browse_backspace_deletes_query_char() {
        let mut app = make_app();
        app.query = "we".into();
        app.handle_key(press(KeyCode::Backspace));
        assert_eq!(app.query, "w");
    }

    #[test]
    fn browse_ctrl_u_clears_query() {
        let mut app = make_app();
        app.query = "test".into();
        app.handle_key(press_mod(KeyCode::Char('u'), KeyModifiers::CONTROL));
        assert!(app.query.is_empty());
    }

    #[test]
    fn browse_ctrl_c_quits() {
        let mut app = make_app();
        assert!(matches!(
            app.handle_key(press_mod(KeyCode::Char('c'), KeyModifiers::CONTROL)),
            AppAction::Quit
        ));
    }

    // --- ScaleMenu mode ---

    #[test]
    fn scale_menu_2_applies_x2_and_enters_preview() {
        let mut app = make_app();
        app.rows[0].selected = true;
        app.mode = AppMode::ScaleMenu;
        app.handle_key(press(KeyCode::Char('2')));
        assert_eq!(app.mode, AppMode::Preview);
        assert_eq!(app.rows[0].new_desired, Some(8));
        assert_eq!(app.preview_label, "x2");
    }

    #[test]
    fn scale_menu_3_applies_x3_and_enters_preview() {
        let mut app = make_app();
        app.rows[0].selected = true;
        app.mode = AppMode::ScaleMenu;
        app.handle_key(press(KeyCode::Char('3')));
        assert_eq!(app.mode, AppMode::Preview);
        assert_eq!(app.rows[0].new_desired, Some(12));
        assert_eq!(app.preview_label, "x3");
    }

    #[test]
    fn scale_menu_v_enters_input_absolute() {
        let mut app = make_app();
        app.mode = AppMode::ScaleMenu;
        app.handle_key(press(KeyCode::Char('v')));
        assert_eq!(app.mode, AppMode::InputAbsolute);
    }

    #[test]
    fn scale_menu_esc_returns_to_browse() {
        let mut app = make_app();
        app.mode = AppMode::ScaleMenu;
        app.handle_key(press(KeyCode::Esc));
        assert_eq!(app.mode, AppMode::Browse);
    }

    // --- InputAbsolute mode ---

    #[test]
    fn input_absolute_digit_input() {
        let mut app = make_app();
        app.mode = AppMode::InputAbsolute;
        app.input_field = InputField::Min;
        app.handle_key(press(KeyCode::Char('5')));
        assert_eq!(app.input_min, "5");
    }

    #[test]
    fn input_absolute_tab_cycles_fields() {
        let mut app = make_app();
        app.mode = AppMode::InputAbsolute;
        app.input_field = InputField::Min;
        app.handle_key(press(KeyCode::Tab));
        assert_eq!(app.input_field, InputField::Max);
        app.handle_key(press(KeyCode::Tab));
        assert_eq!(app.input_field, InputField::Desired);
    }

    #[test]
    fn input_absolute_backtab_cycles_reverse() {
        let mut app = make_app();
        app.mode = AppMode::InputAbsolute;
        app.input_field = InputField::Min;
        app.handle_key(press(KeyCode::BackTab));
        assert_eq!(app.input_field, InputField::Desired);
    }

    #[test]
    fn input_absolute_backspace_deletes() {
        let mut app = make_app();
        app.mode = AppMode::InputAbsolute;
        app.input_min = "12".into();
        app.input_field = InputField::Min;
        app.handle_key(press(KeyCode::Backspace));
        assert_eq!(app.input_min, "1");
    }

    #[test]
    fn input_absolute_enter_with_valid_values() {
        let mut app = make_app();
        app.rows[0].selected = true;
        app.mode = AppMode::InputAbsolute;
        app.input_min = "5".into();
        app.input_max = "50".into();
        app.input_desired = "25".into();
        app.handle_key(press(KeyCode::Enter));
        assert_eq!(app.mode, AppMode::Preview);
        assert_eq!(app.rows[0].new_min, Some(5));
        assert_eq!(app.rows[0].new_max, Some(50));
        assert_eq!(app.rows[0].new_desired, Some(25));
    }

    #[test]
    fn input_absolute_enter_with_invalid_values_stays() {
        let mut app = make_app();
        app.mode = AppMode::InputAbsolute;
        app.input_min = "abc".into();
        app.input_max = "50".into();
        app.input_desired = "25".into();
        app.handle_key(press(KeyCode::Enter));
        assert_eq!(app.mode, AppMode::InputAbsolute);
    }

    #[test]
    fn input_absolute_enter_with_invalid_range_stays() {
        let mut app = make_app();
        app.mode = AppMode::InputAbsolute;
        app.input_min = "50".into();
        app.input_max = "10".into(); // max < min
        app.input_desired = "25".into();
        app.handle_key(press(KeyCode::Enter));
        assert_eq!(app.mode, AppMode::InputAbsolute);
    }

    #[test]
    fn input_absolute_esc_returns_to_scale_menu() {
        let mut app = make_app();
        app.mode = AppMode::InputAbsolute;
        app.handle_key(press(KeyCode::Esc));
        assert_eq!(app.mode, AppMode::ScaleMenu);
    }

    // --- Preview mode ---

    #[test]
    fn preview_typing_yes_and_enter_triggers_apply() {
        let mut app = make_app();
        app.rows[0].selected = true;
        app.rows[0].apply_multiplier(2);
        app.mode = AppMode::Preview;
        app.confirm_input.clear();

        for c in "yes".chars() {
            app.handle_key(press(KeyCode::Char(c)));
        }
        assert_eq!(app.confirm_input, "yes");

        let action = app.handle_key(press(KeyCode::Enter));
        assert!(matches!(action, AppAction::Apply));
        assert_eq!(app.mode, AppMode::Applying);
    }

    #[test]
    fn preview_wrong_input_and_enter_clears() {
        let mut app = make_app();
        app.mode = AppMode::Preview;
        app.confirm_input = "no".into();
        let action = app.handle_key(press(KeyCode::Enter));
        assert!(matches!(action, AppAction::None));
        assert!(app.confirm_input.is_empty());
    }

    #[test]
    fn preview_esc_cancels_and_clears_changes() {
        let mut app = make_app();
        app.rows[0].selected = true;
        app.rows[0].apply_multiplier(2);
        app.mode = AppMode::Preview;
        app.handle_key(press(KeyCode::Esc));
        assert_eq!(app.mode, AppMode::Browse);
        assert!(!app.rows[0].has_changes());
    }

    #[test]
    fn preview_backspace_deletes_confirm_char() {
        let mut app = make_app();
        app.mode = AppMode::Preview;
        app.confirm_input = "ye".into();
        app.handle_key(press(KeyCode::Backspace));
        assert_eq!(app.confirm_input, "y");
    }

    // --- Done/Error mode ---

    #[test]
    fn done_mode_quits_on_enter() {
        let mut app = make_app();
        app.mode = AppMode::Done;
        assert!(matches!(
            app.handle_key(press(KeyCode::Enter)),
            AppAction::Quit
        ));
    }

    #[test]
    fn done_mode_quits_on_q() {
        let mut app = make_app();
        app.mode = AppMode::Done;
        assert!(matches!(
            app.handle_key(press(KeyCode::Char('q'))),
            AppAction::Quit
        ));
    }

    #[test]
    fn error_mode_quits_on_esc() {
        let mut app = make_app();
        app.mode = AppMode::Error("test".into());
        assert!(matches!(
            app.handle_key(press(KeyCode::Esc)),
            AppAction::Quit
        ));
    }

    // --- Misc ---

    #[test]
    fn spinner_char_cycles() {
        let mut app = App::new_scanning("test".into());
        let c1 = app.spinner_char();
        app.tick_spinner();
        let c2 = app.spinner_char();
        assert_ne!(c1, c2);
    }

    #[test]
    fn scan_elapsed_secs_returns_value() {
        let app = App::new_scanning("test".into());
        // Should be 0 or very small since we just created it
        assert!(app.scan_elapsed_secs() <= 1);
    }

    #[test]
    fn set_error_changes_mode() {
        let mut app = make_app();
        app.set_error("boom".into());
        assert_eq!(app.mode, AppMode::Error("boom".into()));
    }

    #[test]
    fn to_row_format_contains_fields() {
        let row = AsgRow::from_info(make_info("my-asg", 2, 10, 5));
        let widths = ColWidths::from_rows(&[row.clone()]);
        let formatted = row.to_row(&widths);
        assert!(formatted.contains("my-asg"));
        assert!(formatted.contains("us-east-1"));
    }

    #[test]
    fn col_widths_header_columns_contains_labels() {
        let widths = ColWidths::from_rows(&[]);
        let cols = widths.header_columns(SortField::Default, SortOrder::Desc);
        let all: String = cols
            .iter()
            .map(|(t, _)| t.as_str())
            .collect::<Vec<_>>()
            .join("  ");
        assert!(all.contains("NAME"));
        assert!(all.contains("INSTANCES"));
        assert!(all.contains("DESIRED"));
        assert!(all.contains("MIN"));
        assert!(all.contains("MAX"));
        assert!(all.contains("REGION"));
    }

    #[test]
    fn applying_mode_ignores_keys() {
        let mut app = make_app();
        app.mode = AppMode::Applying;
        assert!(matches!(
            app.handle_key(press(KeyCode::Esc)),
            AppAction::None
        ));
        assert!(matches!(
            app.handle_key(press(KeyCode::Char('q'))),
            AppAction::None
        ));
    }

    #[test]
    fn page_up_down_navigation() {
        let mut app = make_app();
        app.handle_key(press(KeyCode::PageDown));
        assert_eq!(app.cursor, 2); // min(0+10, 2)
        app.handle_key(press(KeyCode::PageUp));
        assert_eq!(app.cursor, 0); // max(2-10, 0)
    }

    #[test]
    fn browse_enter_does_nothing() {
        let mut app = make_app();
        assert!(matches!(
            app.handle_key(press(KeyCode::Enter)),
            AppAction::None
        ));
    }

    // --- Sort ---

    #[test]
    fn sort_field_cycle_full_loop() {
        let expected = vec![
            (SortField::Name, SortOrder::Asc),
            (SortField::Name, SortOrder::Desc),
            (SortField::Instances, SortOrder::Desc),
            (SortField::Instances, SortOrder::Asc),
            (SortField::Desired, SortOrder::Desc),
            (SortField::Desired, SortOrder::Asc),
            (SortField::Min, SortOrder::Desc),
            (SortField::Min, SortOrder::Asc),
            (SortField::Max, SortOrder::Desc),
            (SortField::Max, SortOrder::Asc),
            (SortField::Region, SortOrder::Asc),
            (SortField::Region, SortOrder::Desc),
            (SortField::Default, SortOrder::Desc),
        ];
        let mut field = SortField::Default;
        let mut order = SortOrder::Desc;
        for (exp_field, exp_order) in &expected {
            (field, order) = field.cycle(order);
            assert_eq!(field, *exp_field);
            assert_eq!(order, *exp_order);
        }
    }

    #[test]
    fn header_columns_default_no_arrow() {
        let widths = ColWidths::from_rows(&[]);
        let cols = widths.header_columns(SortField::Default, SortOrder::Desc);
        assert!(cols.iter().all(|(_, sorted)| !sorted));
        let all: String = cols
            .iter()
            .map(|(t, _)| t.as_str())
            .collect::<Vec<_>>()
            .join("");
        assert!(!all.contains('↑') && !all.contains('↓'));
    }

    #[test]
    fn header_columns_name_asc_shows_arrow_and_sorted_flag() {
        let widths = ColWidths::from_rows(&[]);
        let cols = widths.header_columns(SortField::Name, SortOrder::Asc);
        // First column (NAME) should be sorted
        assert!(cols[0].1);
        assert!(cols[0].0.contains("NAME↑"));
        // Other columns should not be sorted
        assert!(!cols[1].1);
    }

    #[test]
    fn header_columns_desired_desc_shows_arrow() {
        let widths = ColWidths::from_rows(&[]);
        let cols = widths.header_columns(SortField::Desired, SortOrder::Desc);
        // DESIRED is index 2 (NAME, INSTANCES, DESIRED, ...)
        assert!(cols[2].1);
        assert!(cols[2].0.contains("DESIRED↓"));
        assert!(!cols[0].1); // NAME not sorted
    }

    #[test]
    fn browse_o_toggles_sort() {
        let mut app = make_app();
        assert_eq!(app.sort_field, SortField::Default);
        app.handle_key(press(KeyCode::Char('o')));
        assert_eq!(app.sort_field, SortField::Name);
        assert_eq!(app.sort_order, SortOrder::Asc);
    }

    #[test]
    fn toggle_sort_sorts_by_name_asc() {
        let mut app = make_app();
        // Default order: api-asg, web-asg, worker-asg (sorted by region+name)
        app.toggle_sort(); // Name↑
        assert_eq!(app.rows[0].info.name, "api-asg");
        assert_eq!(app.rows[1].info.name, "web-asg");
        assert_eq!(app.rows[2].info.name, "worker-asg");
    }

    #[test]
    fn toggle_sort_sorts_by_name_desc() {
        let mut app = make_app();
        app.toggle_sort(); // Name↑
        app.toggle_sort(); // Name↓
        assert_eq!(app.rows[0].info.name, "worker-asg");
        assert_eq!(app.rows[2].info.name, "api-asg");
    }

    #[test]
    fn toggle_sort_sorts_by_desired_desc() {
        let mut app = make_app();
        // Cycle to Desired↓: Default → Name↑ → Name↓ → Instances↓ → Instances↑ → Desired↓
        for _ in 0..5 {
            app.toggle_sort();
        }
        assert_eq!(app.sort_field, SortField::Desired);
        assert_eq!(app.sort_order, SortOrder::Desc);
        // worker-asg(6) > web-asg(4) > api-asg(2)
        assert_eq!(app.rows[0].info.name, "worker-asg");
        assert_eq!(app.rows[1].info.name, "web-asg");
        assert_eq!(app.rows[2].info.name, "api-asg");
    }

    #[test]
    fn sort_preserves_selection() {
        let mut app = make_app();
        app.rows[0].selected = true; // web-asg (in default order)
        let selected_name = app.rows[0].info.name.clone();
        app.toggle_sort(); // Name↑
        let still_selected = app
            .rows
            .iter()
            .find(|r| r.info.name == selected_name)
            .unwrap();
        assert!(still_selected.selected);
    }

    #[test]
    fn sort_resets_cursor() {
        let mut app = make_app();
        app.cursor = 2;
        app.toggle_sort();
        assert_eq!(app.cursor, 0);
    }

    #[test]
    fn header_columns_sorted_after_toggle() {
        let mut app = make_app();
        app.toggle_sort(); // Name↑
        let cols = app.widths.header_columns(app.sort_field, app.sort_order);
        assert!(cols[0].1); // NAME is sorted
        assert!(cols[0].0.contains("NAME↑"));
    }
}
