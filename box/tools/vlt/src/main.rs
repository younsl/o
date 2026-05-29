mod app;
mod crypto;
mod error;
mod input;
mod session;
mod ui;
mod vault;

use std::io::{self, Stdout};
use std::time::Duration;

use crossterm::event::{self, Event, KeyEventKind};
use crossterm::execute;
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;

use crate::app::App;

const TICK_RATE: Duration = Duration::from_millis(150);

type Term = Terminal<CrosstermBackend<Stdout>>;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut terminal = setup_terminal()?;
    let result = run_app(&mut terminal);
    let _ = restore_terminal(&mut terminal);
    if let Err(e) = &result {
        eprintln!("vlt: {e}");
    }
    result
}

fn setup_terminal() -> io::Result<Term> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    Terminal::new(backend)
}

fn restore_terminal(terminal: &mut Term) -> io::Result<()> {
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;
    Ok(())
}

fn run_app(terminal: &mut Term) -> Result<(), Box<dyn std::error::Error>> {
    let mut app = App::new()?;
    while !app.should_quit {
        terminal.draw(|f| ui::render(f, &app))?;
        if event::poll(TICK_RATE)?
            && let Event::Key(key) = event::read()?
            && key.kind == KeyEventKind::Press
        {
            input::handle(&mut app, key);
        }
        app.tick();
    }
    Ok(())
}
