use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::crypto;
use crate::error::{VltError, VltResult};
use crate::session;
use crate::vault::{Item, ItemSummary, Link, NewItem, UpdateItem, Vault};

pub const STATUS_TTL: Duration = Duration::from_secs(3);
pub const CLIPBOARD_CLEAR: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum StatusKind {
    Info,
    Error,
}

pub struct App {
    pub vault_path: PathBuf,
    pub vault: Option<Vault>,
    pub screen: Screen,
    pub status: Option<(String, Instant, StatusKind)>,
    pub clipboard: Option<arboard::Clipboard>,
    pub clipboard_clear_at: Option<Instant>,
    pub should_quit: bool,
    pub show_help: bool,
}

pub enum Screen {
    Setup(SetupState),
    Unlock(UnlockState),
    List(ListState),
    Detail(DetailState),
    Form(FormState),
    Generator(GenState),
}

pub struct SetupState {
    pub password: String,
    pub confirm: String,
    pub focus: SetupFocus,
    pub error: Option<String>,
    pub reveal: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SetupFocus {
    Password,
    Confirm,
}

pub struct UnlockState {
    pub password: String,
    pub error: Option<String>,
    pub reveal: bool,
}

pub struct ListState {
    pub selected: usize,
    pub search: String,
    pub searching: bool,
    pub collapsed: BTreeSet<String>,
    pub confirm_delete_id: Option<String>,
}

pub struct DetailState {
    pub id: String,
    pub reveal: bool,
    pub pending_g: bool,
}

#[derive(Clone)]
pub enum FormMode {
    Create,
    Edit(String),
}

pub struct FormState {
    pub mode: FormMode,
    pub focus: FormFocus,
    pub title: String,
    pub username: String,
    pub password: String,
    pub url: String,
    pub group: String,
    pub notes: String,
    pub links: Vec<Link>,
    pub reveal: bool,
    pub error: Option<String>,
}

/// Where the cursor lives inside a Form: one of the six main fields, a
/// sub-field of an existing link, or the trailing `+ add link` row.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FormFocus {
    Title,
    Username,
    Password,
    Url,
    Group,
    Notes,
    LinkName(usize),
    LinkDescription(usize),
    LinkUrl(usize),
    AddLink,
}

impl FormState {
    pub fn focus_next(&mut self) {
        self.focus = match self.focus {
            FormFocus::Title => FormFocus::Username,
            FormFocus::Username => FormFocus::Password,
            FormFocus::Password => FormFocus::Url,
            FormFocus::Url => FormFocus::Group,
            FormFocus::Group => FormFocus::Notes,
            FormFocus::Notes => self.first_link_focus(),
            FormFocus::LinkName(i) => FormFocus::LinkDescription(i),
            FormFocus::LinkDescription(i) => FormFocus::LinkUrl(i),
            FormFocus::LinkUrl(i) => {
                if i + 1 < self.links.len() {
                    FormFocus::LinkName(i + 1)
                } else {
                    FormFocus::AddLink
                }
            }
            FormFocus::AddLink => FormFocus::Title,
        };
    }

    pub fn focus_prev(&mut self) {
        self.focus = match self.focus {
            FormFocus::Title => FormFocus::AddLink,
            FormFocus::Username => FormFocus::Title,
            FormFocus::Password => FormFocus::Username,
            FormFocus::Url => FormFocus::Password,
            FormFocus::Group => FormFocus::Url,
            FormFocus::Notes => FormFocus::Group,
            FormFocus::LinkName(0) => FormFocus::Notes,
            FormFocus::LinkName(i) => FormFocus::LinkUrl(i - 1),
            FormFocus::LinkDescription(i) => FormFocus::LinkName(i),
            FormFocus::LinkUrl(i) => FormFocus::LinkDescription(i),
            FormFocus::AddLink => {
                if self.links.is_empty() {
                    FormFocus::Notes
                } else {
                    FormFocus::LinkUrl(self.links.len() - 1)
                }
            }
        };
    }

    fn first_link_focus(&self) -> FormFocus {
        if self.links.is_empty() {
            FormFocus::AddLink
        } else {
            FormFocus::LinkName(0)
        }
    }

    pub fn add_link(&mut self) {
        let i = self.links.len();
        self.links.push(Link::default());
        self.focus = FormFocus::LinkName(i);
    }

    /// Delete the link the cursor is currently inside. No-op outside link
    /// rows.
    pub fn delete_focused_link(&mut self) {
        let i = match self.focus {
            FormFocus::LinkName(i) | FormFocus::LinkDescription(i) | FormFocus::LinkUrl(i) => i,
            _ => return,
        };
        if i >= self.links.len() {
            return;
        }
        self.links.remove(i);
        if self.links.is_empty() {
            self.focus = FormFocus::AddLink;
        } else if i >= self.links.len() {
            self.focus = FormFocus::LinkName(self.links.len() - 1);
        } else {
            self.focus = FormFocus::LinkName(i);
        }
    }

    pub fn current_value_mut(&mut self) -> Option<&mut String> {
        match self.focus {
            FormFocus::Title => Some(&mut self.title),
            FormFocus::Username => Some(&mut self.username),
            FormFocus::Password => Some(&mut self.password),
            FormFocus::Url => Some(&mut self.url),
            FormFocus::Group => Some(&mut self.group),
            FormFocus::Notes => Some(&mut self.notes),
            FormFocus::LinkName(i) => self.links.get_mut(i).map(|l| &mut l.name),
            FormFocus::LinkDescription(i) => self.links.get_mut(i).map(|l| &mut l.description),
            FormFocus::LinkUrl(i) => self.links.get_mut(i).map(|l| &mut l.url),
            FormFocus::AddLink => None,
        }
    }
}

pub struct GenState {
    pub length: usize,
    pub symbols: bool,
    pub numbers: bool,
    pub output: String,
}

impl Default for GenState {
    fn default() -> Self {
        Self::new()
    }
}

impl GenState {
    pub fn new() -> Self {
        let mut s = Self {
            length: 24,
            symbols: true,
            numbers: true,
            output: String::new(),
        };
        s.regenerate();
        s
    }

    pub fn regenerate(&mut self) {
        self.output = crypto::generate_password(self.length, self.symbols, self.numbers);
    }
}

#[derive(Clone)]
pub struct RenderRow {
    pub depth: usize,
    pub kind: RowKind,
}

#[derive(Clone)]
pub enum RowKind {
    Group {
        path: String,
        name: String,
        count: usize,
        expanded: bool,
    },
    Item(ItemSummary),
}

/// Resolve the vault file path following the XDG Base Directory Specification:
///   1. `$VLT_VAULT_PATH` overrides everything.
///   2. `$XDG_DATA_HOME/vlt/vault.json` if `XDG_DATA_HOME` is set and non-empty.
///   3. Fallback `$HOME/.local/share/vlt/vault.json`.
fn resolve_vault_path() -> VltResult<PathBuf> {
    if let Some(p) = std::env::var_os("VLT_VAULT_PATH").filter(|s| !s.is_empty()) {
        return Ok(PathBuf::from(p));
    }
    let base = std::env::var_os("XDG_DATA_HOME")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .filter(|s| !s.is_empty())
                .map(|h| PathBuf::from(h).join(".local").join("share"))
        })
        .ok_or(VltError::NoConfigDir)?;
    Ok(base.join("vlt").join("vault.json"))
}

/// One-time migration of a vault file from the previous macOS-native location
/// (`~/Library/Application Support/io.younsl.vlt/vault.json`) to the XDG path.
/// Runs only when the new path does not exist and the legacy file does. Failures
/// are silent — vlt will simply offer to create a fresh vault.
fn migrate_legacy(new_path: &Path) {
    if new_path.exists() {
        return;
    }
    if !cfg!(target_os = "macos") {
        return;
    }
    let Some(home) = std::env::var_os("HOME") else {
        return;
    };
    let legacy = PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("io.younsl.vlt")
        .join("vault.json");
    if !legacy.exists() {
        return;
    }
    if let Some(parent) = new_path.parent()
        && std::fs::create_dir_all(parent).is_err()
    {
        return;
    }
    let _ = std::fs::rename(&legacy, new_path);
}

impl App {
    pub fn new() -> VltResult<Self> {
        let vault_path = resolve_vault_path()?;
        migrate_legacy(&vault_path);

        // Try to silently unlock from a non-expired cached session.
        let mut vault: Option<Vault> = None;
        let mut cache_status: Option<String> = None;
        if vault_path.exists()
            && let session::LoadResult::Hit { master, encrypted } = session::load(&vault_path)
        {
            match Vault::open_vault(&vault_path, &master) {
                Ok(v) => {
                    vault = Some(v);
                    cache_status = Some(if encrypted {
                        "session restored (encrypted via keyring)".to_string()
                    } else {
                        "session restored (plaintext fallback)".to_string()
                    });
                }
                Err(_) => {
                    // Stale cache (password changed, vault rotated, etc.)
                    session::clear();
                }
            }
        }

        let screen = if vault.is_some() {
            Screen::List(default_list())
        } else if vault_path.exists() {
            Screen::Unlock(UnlockState {
                password: String::new(),
                error: None,
                reveal: false,
            })
        } else {
            Screen::Setup(SetupState {
                password: String::new(),
                confirm: String::new(),
                focus: SetupFocus::Password,
                error: None,
                reveal: false,
            })
        };

        let mut app = Self {
            vault_path,
            vault,
            screen,
            status: None,
            clipboard: arboard::Clipboard::new().ok(),
            clipboard_clear_at: None,
            should_quit: false,
            show_help: false,
        };
        if let Some(msg) = cache_status {
            app.set_status(msg, StatusKind::Info);
        }
        Ok(app)
    }

    pub fn set_status<S: Into<String>>(&mut self, msg: S, kind: StatusKind) {
        self.status = Some((msg.into(), Instant::now(), kind));
    }

    pub fn tick(&mut self) {
        if let Some((_, t, _)) = &self.status
            && t.elapsed() > STATUS_TTL
        {
            self.status = None;
        }
        if let Some(at) = self.clipboard_clear_at
            && Instant::now() >= at
        {
            if let Some(cb) = self.clipboard.as_mut() {
                let _ = cb.set_text(String::new());
            }
            self.clipboard_clear_at = None;
        }
    }

    pub fn try_setup(&mut self) {
        let Screen::Setup(s) = &mut self.screen else {
            return;
        };
        if s.password.len() < 8 {
            s.error = Some("vault password must be at least 8 characters".into());
            return;
        }
        if s.password != s.confirm {
            s.error = Some("passwords do not match".into());
            return;
        }
        let pwd = s.password.clone();
        match Vault::create(&self.vault_path, &pwd) {
            Ok(v) => {
                self.vault = Some(v);
                let outcome = session::save(&pwd, &self.vault_path);
                self.screen = Screen::List(default_list());
                self.set_status(
                    format!("vault created · {}", session_outcome_label(outcome)),
                    StatusKind::Info,
                );
            }
            Err(e) => s.error = Some(e.to_string()),
        }
    }

    pub fn try_unlock(&mut self) {
        let Screen::Unlock(s) = &mut self.screen else {
            return;
        };
        let pwd = s.password.clone();
        match Vault::open_vault(&self.vault_path, &pwd) {
            Ok(v) => {
                self.vault = Some(v);
                let outcome = session::save(&pwd, &self.vault_path);
                self.screen = Screen::List(default_list());
                self.set_status(
                    format!("unlocked · {}", session_outcome_label(outcome)),
                    StatusKind::Info,
                );
            }
            Err(e) => s.error = Some(e.to_string()),
        }
    }

    pub fn lock_vault(&mut self) {
        self.vault = None;
        session::clear();
        self.screen = Screen::Unlock(UnlockState {
            password: String::new(),
            error: None,
            reveal: false,
        });
    }

    pub fn open_url(&mut self, url: &str) {
        if url.is_empty() {
            self.set_status("no URL", StatusKind::Error);
            return;
        }
        match open::that_detached(url) {
            Ok(()) => self.set_status(format!("opened {url}"), StatusKind::Info),
            Err(e) => self.set_status(format!("open failed: {e}"), StatusKind::Error),
        }
    }

    pub fn copy_value(&mut self, value: &str, label: &str) {
        let Some(cb) = self.clipboard.as_mut() else {
            self.set_status("clipboard unavailable", StatusKind::Error);
            return;
        };
        match cb.set_text(value.to_string()) {
            Ok(()) => {
                self.clipboard_clear_at = Some(Instant::now() + CLIPBOARD_CLEAR);
                self.set_status(
                    format!("{label} copied (clears in {}s)", CLIPBOARD_CLEAR.as_secs()),
                    StatusKind::Info,
                );
            }
            Err(e) => self.set_status(format!("clipboard: {e}"), StatusKind::Error),
        }
    }

    pub fn open_detail(&mut self, id: String) {
        self.screen = Screen::Detail(DetailState {
            id,
            reveal: false,
            pending_g: false,
        });
    }

    pub fn back_to_list(&mut self) {
        self.screen = Screen::List(default_list());
    }

    pub fn start_new(&mut self) {
        self.screen = Screen::Form(FormState {
            mode: FormMode::Create,
            focus: FormFocus::Title,
            title: String::new(),
            username: String::new(),
            password: String::new(),
            url: String::new(),
            group: String::new(),
            notes: String::new(),
            links: Vec::new(),
            reveal: false,
            error: None,
        });
    }

    pub fn start_edit(&mut self, id: &str) -> VltResult<()> {
        let v = self.vault.as_ref().ok_or(VltError::NotInitialized)?;
        let it = v.find_item(id)?.clone();
        self.screen = Screen::Form(FormState {
            mode: FormMode::Edit(it.id),
            focus: FormFocus::Title,
            title: it.title,
            username: it.username,
            password: it.password,
            url: it.url,
            group: it.group,
            notes: it.notes,
            links: it.links,
            reveal: false,
            error: None,
        });
        Ok(())
    }

    pub fn save_form(&mut self) {
        let Screen::Form(f) = &mut self.screen else {
            return;
        };
        if f.title.trim().is_empty() {
            f.error = Some("title is required".into());
            return;
        }
        if f.password.is_empty() {
            f.error = Some("password is required".into());
            return;
        }
        let mode = f.mode.clone();
        let title = f.title.clone();
        let username = f.username.clone();
        let password = f.password.clone();
        let url = f.url.clone();
        let group = f.group.clone();
        let notes = f.notes.clone();
        let links = f.links.clone();
        let result: VltResult<String> = (|| {
            let v = self.vault.as_mut().ok_or(VltError::NotInitialized)?;
            match mode {
                FormMode::Create => {
                    let item = Item::from_new(NewItem {
                        title,
                        username,
                        password,
                        url,
                        notes,
                        group,
                        links,
                    });
                    let id = item.id.clone();
                    v.add_item(item);
                    v.persist()?;
                    Ok(id)
                }
                FormMode::Edit(id) => {
                    v.update_item(&id, |it| {
                        it.apply_update(UpdateItem {
                            title: Some(title),
                            username: Some(username),
                            password: Some(password),
                            url: Some(url),
                            notes: Some(notes),
                            group: Some(group),
                            links: Some(links),
                        });
                    })?;
                    v.persist()?;
                    Ok(id)
                }
            }
        })();
        match result {
            Ok(id) => {
                self.set_status("saved", StatusKind::Info);
                self.open_detail(id);
            }
            Err(e) => {
                if let Screen::Form(f) = &mut self.screen {
                    f.error = Some(e.to_string());
                }
            }
        }
    }

    pub fn delete_item(&mut self, id: &str) -> VltResult<()> {
        let v = self.vault.as_mut().ok_or(VltError::NotInitialized)?;
        v.delete_item(id)?;
        v.persist()?;
        Ok(())
    }

    pub fn visible_rows(&self, list: &ListState) -> Vec<RenderRow> {
        let Some(vault) = self.vault.as_ref() else {
            return Vec::new();
        };
        let q = list.search.trim().to_lowercase();
        let force_expand = !q.is_empty();
        let items: Vec<ItemSummary> = vault
            .items()
            .iter()
            .filter(|i| {
                if q.is_empty() {
                    true
                } else {
                    i.title.to_lowercase().contains(&q)
                        || i.username.to_lowercase().contains(&q)
                        || i.url.to_lowercase().contains(&q)
                        || i.group.to_lowercase().contains(&q)
                }
            })
            .map(ItemSummary::from)
            .collect();
        let tree = build_tree(&items);
        let mut rows = Vec::new();
        emit_rows(&tree, 0, &list.collapsed, force_expand, &mut rows);
        rows
    }
}

fn session_outcome_label(o: session::SaveOutcome) -> &'static str {
    match o {
        session::SaveOutcome::Encrypted => "cached for 1h (encrypted via keyring)",
        session::SaveOutcome::Plaintext => "cached for 1h (plaintext, keyring unavailable)",
        session::SaveOutcome::Failed => "session caching failed",
    }
}

fn default_list() -> ListState {
    ListState {
        selected: 0,
        search: String::new(),
        searching: false,
        collapsed: BTreeSet::new(),
        confirm_delete_id: None,
    }
}

struct TreeNode {
    name: String,
    path: String,
    children: std::collections::BTreeMap<String, TreeNode>,
    items: Vec<ItemSummary>,
}

fn build_tree(items: &[ItemSummary]) -> TreeNode {
    let mut root = TreeNode {
        name: String::new(),
        path: String::new(),
        children: Default::default(),
        items: Vec::new(),
    };
    for it in items {
        let path = it.group.trim();
        if path.is_empty() {
            root.items.push(it.clone());
            continue;
        }
        let mut node = &mut root;
        for part in path.split('/').map(str::trim).filter(|p| !p.is_empty()) {
            let parent_path = node.path.clone();
            node = node.children.entry(part.to_string()).or_insert_with(|| {
                let p = if parent_path.is_empty() {
                    part.to_string()
                } else {
                    format!("{parent_path}/{part}")
                };
                TreeNode {
                    name: part.to_string(),
                    path: p,
                    children: Default::default(),
                    items: Vec::new(),
                }
            });
        }
        node.items.push(it.clone());
    }
    root
}

fn count_tree(node: &TreeNode) -> usize {
    let mut n = node.items.len();
    for c in node.children.values() {
        n += count_tree(c);
    }
    n
}

fn emit_rows(
    node: &TreeNode,
    depth: usize,
    collapsed: &BTreeSet<String>,
    force_expand: bool,
    out: &mut Vec<RenderRow>,
) {
    for child in node.children.values() {
        let expanded = force_expand || !collapsed.contains(&child.path);
        out.push(RenderRow {
            depth,
            kind: RowKind::Group {
                path: child.path.clone(),
                name: child.name.clone(),
                count: count_tree(child),
                expanded,
            },
        });
        if expanded {
            emit_rows(child, depth + 1, collapsed, force_expand, out);
        }
    }
    let mut items: Vec<ItemSummary> = node.items.clone();
    items.sort_by_key(|i| i.title.to_lowercase());
    for it in items {
        out.push(RenderRow {
            depth: depth + 1,
            kind: RowKind::Item(it),
        });
    }
}
