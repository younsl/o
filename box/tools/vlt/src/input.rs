use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use crate::app::{
    App, FormFocus, FormMode, GenState, ListState, RenderRow, RowKind, Screen, SetupFocus,
    StatusKind,
};
use crate::crypto;

pub fn handle(app: &mut App, key: KeyEvent) {
    if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
        app.should_quit = true;
        return;
    }
    if app.show_help {
        if matches!(
            key.code,
            KeyCode::Esc | KeyCode::Char('?') | KeyCode::Char('q')
        ) {
            app.show_help = false;
        }
        return;
    }
    if let Screen::List(l) = &app.screen
        && l.confirm_delete_id.is_some()
    {
        return handle_confirm_delete(app, key);
    }
    if key.code == KeyCode::Char('?') && !typing_screen(app) {
        app.show_help = true;
        return;
    }
    match &app.screen {
        Screen::Setup(_) => handle_setup(app, key),
        Screen::Unlock(_) => handle_unlock(app, key),
        Screen::List(_) => handle_list(app, key),
        Screen::Detail(_) => handle_detail(app, key),
        Screen::Form(_) => handle_form(app, key),
        Screen::Generator(_) => handle_generator(app, key),
    }
}

fn typing_screen(app: &App) -> bool {
    matches!(
        app.screen,
        Screen::Setup(_) | Screen::Unlock(_) | Screen::Form(_)
    ) || matches!(&app.screen, Screen::List(l) if l.searching)
}

fn clone_list(l: &ListState) -> ListState {
    ListState {
        selected: l.selected,
        search: l.search.clone(),
        searching: l.searching,
        collapsed: l.collapsed.clone(),
        confirm_delete_id: l.confirm_delete_id.clone(),
    }
}

fn handle_setup(app: &mut App, key: KeyEvent) {
    let Screen::Setup(s) = &mut app.screen else {
        return;
    };
    match key.code {
        KeyCode::Esc => app.should_quit = true,
        KeyCode::Tab | KeyCode::Down | KeyCode::BackTab | KeyCode::Up => {
            s.focus = match s.focus {
                SetupFocus::Password => SetupFocus::Confirm,
                SetupFocus::Confirm => SetupFocus::Password,
            }
        }
        KeyCode::Enter => {
            if s.focus == SetupFocus::Password {
                s.focus = SetupFocus::Confirm;
            } else {
                app.try_setup();
            }
        }
        KeyCode::Char('r') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            s.reveal = !s.reveal;
        }
        KeyCode::Backspace => match s.focus {
            SetupFocus::Password => {
                s.password.pop();
            }
            SetupFocus::Confirm => {
                s.confirm.pop();
            }
        },
        KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => match s.focus {
            SetupFocus::Password => s.password.push(c),
            SetupFocus::Confirm => s.confirm.push(c),
        },
        _ => {}
    }
}

fn handle_unlock(app: &mut App, key: KeyEvent) {
    let Screen::Unlock(s) = &mut app.screen else {
        return;
    };
    match key.code {
        KeyCode::Esc => app.should_quit = true,
        KeyCode::Enter => app.try_unlock(),
        KeyCode::Backspace => {
            s.password.pop();
        }
        KeyCode::Char('r') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            s.reveal = !s.reveal;
        }
        KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => s.password.push(c),
        _ => {}
    }
}

fn handle_list(app: &mut App, key: KeyEvent) {
    if matches!(&app.screen, Screen::List(l) if l.searching) {
        return handle_search_input(app, key);
    }

    // Snapshot what we need from the list state and the visible rows so we can
    // mutate `app` later without borrow conflicts.
    let (rows_len, cur_row, all_rows): (usize, Option<RenderRow>, Vec<RenderRow>) = {
        let Screen::List(l) = &app.screen else {
            return;
        };
        let snap = clone_list(l);
        let rows = app.visible_rows(&snap);
        let cur = rows.get(snap.selected).cloned();
        (rows.len(), cur, rows)
    };

    match key.code {
        KeyCode::Char('q') | KeyCode::Esc => {
            if let Screen::List(l) = &mut app.screen {
                if !l.search.is_empty() {
                    l.search.clear();
                    l.selected = 0;
                } else {
                    app.should_quit = true;
                }
            }
        }
        KeyCode::Char('j') | KeyCode::Down => {
            if rows_len > 0
                && let Screen::List(l) = &mut app.screen
            {
                l.selected = (l.selected + 1).min(rows_len - 1);
            }
        }
        KeyCode::Char('k') | KeyCode::Up => {
            if let Screen::List(l) = &mut app.screen {
                l.selected = l.selected.saturating_sub(1);
            }
        }
        KeyCode::PageDown => {
            if rows_len > 0
                && let Screen::List(l) = &mut app.screen
            {
                l.selected = (l.selected + 10).min(rows_len - 1);
            }
        }
        KeyCode::PageUp => {
            if let Screen::List(l) = &mut app.screen {
                l.selected = l.selected.saturating_sub(10);
            }
        }
        KeyCode::Char('g') | KeyCode::Home => {
            if let Screen::List(l) = &mut app.screen {
                l.selected = 0;
            }
        }
        KeyCode::Char('G') | KeyCode::End => {
            if rows_len > 0
                && let Screen::List(l) = &mut app.screen
            {
                l.selected = rows_len - 1;
            }
        }
        KeyCode::Right => {
            // Expand current group, or no-op on item.
            if let Some(row) = &cur_row
                && let RowKind::Group { path, .. } = &row.kind
                && let Screen::List(l) = &mut app.screen
            {
                l.collapsed.remove(path);
            }
        }
        KeyCode::Left => {
            // Collapse current group, or jump cursor up to its parent group on item rows.
            match cur_row.as_ref().map(|r| &r.kind) {
                Some(RowKind::Group { path, .. }) => {
                    if let Screen::List(l) = &mut app.screen {
                        l.collapsed.insert(path.clone());
                    }
                }
                Some(RowKind::Item(_)) => {
                    if let Screen::List(l) = &mut app.screen {
                        let cur = l.selected;
                        for i in (0..cur).rev() {
                            if matches!(
                                all_rows.get(i).map(|r| &r.kind),
                                Some(RowKind::Group { .. })
                            ) {
                                l.selected = i;
                                break;
                            }
                        }
                    }
                }
                None => {}
            }
        }
        KeyCode::Char(':') => {
            if let Screen::List(l) = &mut app.screen {
                l.searching = true;
            }
        }
        KeyCode::Char('n') => app.start_new(),
        KeyCode::Char('p') => app.screen = Screen::Generator(GenState::new()),
        KeyCode::Char('L') => {
            app.lock_vault();
            app.set_status("locked", StatusKind::Info);
        }
        KeyCode::Char(' ') | KeyCode::Tab => {
            if let Some(row) = &cur_row
                && let RowKind::Group { path, .. } = &row.kind
                && let Screen::List(l) = &mut app.screen
            {
                if l.collapsed.contains(path) {
                    l.collapsed.remove(path);
                } else {
                    l.collapsed.insert(path.clone());
                }
            }
        }
        KeyCode::Enter => match cur_row.as_ref().map(|r| &r.kind) {
            Some(RowKind::Item(it)) => {
                let id = it.id.clone();
                app.open_detail(id);
            }
            Some(RowKind::Group { path, .. }) => {
                if let Screen::List(l) = &mut app.screen {
                    if l.collapsed.contains(path) {
                        l.collapsed.remove(path);
                    } else {
                        l.collapsed.insert(path.clone());
                    }
                }
            }
            None => {}
        },
        KeyCode::Char('e') => {
            if let Some(row) = &cur_row
                && let RowKind::Item(it) = &row.kind
            {
                let id = it.id.clone();
                if let Err(e) = app.start_edit(&id) {
                    app.set_status(e.to_string(), StatusKind::Error);
                }
            }
        }
        KeyCode::Char('d') => {
            if let Some(row) = &cur_row
                && let RowKind::Item(it) = &row.kind
            {
                let id = it.id.clone();
                if let Screen::List(l) = &mut app.screen {
                    l.confirm_delete_id = Some(id);
                }
            }
        }
        KeyCode::Char('c') => {
            if let Some(row) = &cur_row
                && let RowKind::Item(it) = &row.kind
            {
                let id = it.id.clone();
                let pwd = app
                    .vault
                    .as_ref()
                    .and_then(|v| v.find_item(&id).ok().map(|i| i.password.clone()));
                if let Some(p) = pwd {
                    app.copy_value(&p, "password");
                }
            }
        }
        KeyCode::Char('y') => {
            if let Some(row) = &cur_row
                && let RowKind::Item(it) = &row.kind
            {
                let user = it.username.clone();
                app.copy_value(&user, "username");
            }
        }
        _ => {}
    }
}

fn handle_search_input(app: &mut App, key: KeyEvent) {
    let Screen::List(l) = &mut app.screen else {
        return;
    };
    match key.code {
        KeyCode::Esc => {
            l.searching = false;
            l.search.clear();
            l.selected = 0;
        }
        KeyCode::Enter | KeyCode::Down => {
            l.searching = false;
            l.selected = 0;
        }
        KeyCode::Backspace => {
            l.search.pop();
            l.selected = 0;
        }
        KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
            l.search.push(c);
            l.selected = 0;
        }
        _ => {}
    }
}

fn handle_confirm_delete(app: &mut App, key: KeyEvent) {
    let id = match &app.screen {
        Screen::List(l) => l.confirm_delete_id.clone(),
        _ => return,
    };
    let Some(id) = id else { return };
    match key.code {
        KeyCode::Char('y') | KeyCode::Char('Y') | KeyCode::Enter => {
            match app.delete_item(&id) {
                Ok(()) => app.set_status("deleted", StatusKind::Info),
                Err(e) => app.set_status(e.to_string(), StatusKind::Error),
            }
            if let Screen::List(l) = &mut app.screen {
                l.confirm_delete_id = None;
                l.selected = 0;
            }
        }
        _ => {
            if let Screen::List(l) = &mut app.screen {
                l.confirm_delete_id = None;
            }
        }
    }
}

fn handle_detail(app: &mut App, key: KeyEvent) {
    let Screen::Detail(d) = &app.screen else {
        return;
    };
    let id = d.id.clone();
    let pending_g = d.pending_g;
    let item = match app
        .vault
        .as_ref()
        .and_then(|v| v.find_item(&id).ok().cloned())
    {
        Some(it) => it,
        None => {
            app.back_to_list();
            return;
        }
    };

    // Always clear the pending `g` prefix; specific handlers below set it again.
    if let Screen::Detail(d) = &mut app.screen {
        d.pending_g = false;
    }

    // `g`-prefix chords (vim convention).
    //   `gx`        → open the primary URL
    //   `g{1..=9}`  → open the Nth registered link
    if pending_g {
        match key.code {
            KeyCode::Char('x') => app.open_url(&item.url),
            KeyCode::Char(c) if c.is_ascii_digit() => {
                let n = c.to_digit(10).unwrap_or(0) as usize;
                if (1..=9).contains(&n)
                    && let Some(link) = item.links.get(n - 1)
                {
                    let url = link.url.clone();
                    app.open_url(&url);
                }
            }
            _ => {}
        }
        return;
    }

    match key.code {
        KeyCode::Esc | KeyCode::Char('q') | KeyCode::Backspace => app.back_to_list(),
        KeyCode::Char('r') => {
            if let Screen::Detail(d) = &mut app.screen {
                d.reveal = !d.reveal;
            }
        }
        KeyCode::Char('g') => {
            if let Screen::Detail(d) = &mut app.screen {
                d.pending_g = true;
            }
        }
        KeyCode::Char('c') => app.copy_value(&item.password, "password"),
        KeyCode::Char('y') => app.copy_value(&item.username, "username"),
        KeyCode::Char('u') => app.copy_value(&item.url, "url"),
        KeyCode::Char(c) if c.is_ascii_digit() => {
            let n = c.to_digit(10).unwrap_or(0) as usize;
            if (1..=9).contains(&n)
                && let Some(link) = item.links.get(n - 1)
            {
                let url = link.url.clone();
                app.copy_value(&url, &format!("link {n} url"));
            }
        }
        KeyCode::Char('e') => {
            if let Err(e) = app.start_edit(&id) {
                app.set_status(e.to_string(), StatusKind::Error);
            }
        }
        KeyCode::Char('d') => {
            app.back_to_list();
            if let Screen::List(l) = &mut app.screen {
                l.confirm_delete_id = Some(id);
            }
        }
        KeyCode::Char('L') => {
            app.lock_vault();
            app.set_status("locked", StatusKind::Info);
        }
        _ => {}
    }
}

fn handle_form(app: &mut App, key: KeyEvent) {
    let Screen::Form(f) = &mut app.screen else {
        return;
    };
    if key.modifiers.contains(KeyModifiers::CONTROL) {
        match key.code {
            KeyCode::Char('s') => {
                app.save_form();
                return;
            }
            KeyCode::Char('r') => {
                f.reveal = !f.reveal;
                return;
            }
            KeyCode::Char('g') => {
                f.password = crypto::generate_password(24, true, true);
                return;
            }
            KeyCode::Char('n') => {
                f.add_link();
                return;
            }
            KeyCode::Char('x') => {
                f.delete_focused_link();
                return;
            }
            _ => {}
        }
    }
    match key.code {
        KeyCode::Esc => match &f.mode {
            FormMode::Create => app.back_to_list(),
            FormMode::Edit(id) => {
                let id = id.clone();
                app.open_detail(id);
            }
        },
        KeyCode::Tab | KeyCode::Down => f.focus_next(),
        KeyCode::BackTab | KeyCode::Up => f.focus_prev(),
        KeyCode::Enter => match f.focus {
            FormFocus::Notes => f.notes.push('\n'),
            FormFocus::AddLink => f.add_link(),
            _ => f.focus_next(),
        },
        KeyCode::Backspace => {
            if let Some(v) = f.current_value_mut() {
                v.pop();
            }
        }
        KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
            if let Some(v) = f.current_value_mut() {
                v.push(c);
            }
        }
        _ => {}
    }
}

fn handle_generator(app: &mut App, key: KeyEvent) {
    let Screen::Generator(g) = &mut app.screen else {
        return;
    };
    match key.code {
        KeyCode::Esc | KeyCode::Char('q') => app.back_to_list(),
        KeyCode::Char('+') | KeyCode::Char('=') | KeyCode::Right | KeyCode::Char('l') => {
            g.length = (g.length + 1).min(128);
            g.regenerate();
        }
        KeyCode::Char('-') | KeyCode::Left | KeyCode::Char('h') => {
            g.length = g.length.saturating_sub(1).max(4);
            g.regenerate();
        }
        KeyCode::Char('s') => {
            g.symbols = !g.symbols;
            g.regenerate();
        }
        KeyCode::Char('n') => {
            g.numbers = !g.numbers;
            g.regenerate();
        }
        KeyCode::Char('g') | KeyCode::Enter => g.regenerate(),
        KeyCode::Char('c') | KeyCode::Char('y') => {
            let out = g.output.clone();
            app.copy_value(&out, "password");
        }
        _ => {}
    }
}
