//! PTY-based session handling with escape sequence detection.

use anyhow::{Context, Result};
use colored::Colorize;
use nix::poll::{PollFd, PollFlags, PollTimeout, poll};
use nix::sys::signal::{self, Signal};
use nix::sys::termios::{self, SetArg};
use nix::unistd;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, BorrowedFd, FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use tracing::{debug, info};

mod escape;

/// Flag to indicate SIGWINCH was received
static WINCH_RECEIVED: AtomicBool = AtomicBool::new(false);

/// Signal handler for SIGWINCH
extern "C" fn handle_sigwinch(_: libc::c_int) {
    WINCH_RECEIVED.store(true, Ordering::SeqCst);
}

/// Connect to SSM session with PTY and escape sequence detection.
pub fn connect_with_pty(mut cmd: Command) -> Result<()> {
    let (master, slave) = open_pty()?;

    let stdin = std::io::stdin();
    let stdin_fd = stdin.as_raw_fd();
    let original_termios = termios::tcgetattr(&stdin).ok();

    // Set raw mode
    if let Some(ref orig) = original_termios {
        let mut raw = orig.clone();
        termios::cfmakeraw(&mut raw);
        termios::tcsetattr(&stdin, SetArg::TCSANOW, &raw).context("Failed to set raw mode")?;
    }

    // Configure child process
    let slave_fd = slave.as_raw_fd();
    unsafe {
        cmd.pre_exec(move || {
            unistd::setsid().map_err(std::io::Error::other)?;
            libc::ioctl(slave_fd, libc::TIOCSCTTY as libc::c_ulong, 0);
            libc::dup2(slave_fd, 0);
            libc::dup2(slave_fd, 1);
            libc::dup2(slave_fd, 2);
            Ok(())
        });
    }

    let mut child = cmd
        .spawn()
        .context("Failed to spawn aws ssm start-session")?;
    drop(slave);

    // Ignore signals in parent (except SIGWINCH)
    unsafe {
        signal::signal(Signal::SIGINT, signal::SigHandler::SigIgn).ok();
        signal::signal(Signal::SIGTSTP, signal::SigHandler::SigIgn).ok();
        signal::signal(
            Signal::SIGWINCH,
            signal::SigHandler::Handler(handle_sigwinch),
        )
        .ok();
    }

    // Reset WINCH flag before starting
    WINCH_RECEIVED.store(false, Ordering::SeqCst);

    let result = run_io_loop(&master, &mut child, stdin_fd);

    // Restore terminal
    if let Some(ref orig) = original_termios {
        let _ = termios::tcsetattr(&stdin, SetArg::TCSANOW, orig);
    }

    // Restore signal handlers
    unsafe {
        signal::signal(Signal::SIGINT, signal::SigHandler::SigDfl).ok();
        signal::signal(Signal::SIGTSTP, signal::SigHandler::SigDfl).ok();
        signal::signal(Signal::SIGWINCH, signal::SigHandler::SigDfl).ok();
    }

    result
}

fn open_pty() -> Result<(OwnedFd, OwnedFd)> {
    unsafe {
        let master_fd = libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY);
        if master_fd < 0 {
            anyhow::bail!("Failed to open PTY master");
        }

        if libc::grantpt(master_fd) != 0 {
            libc::close(master_fd);
            anyhow::bail!("Failed to grant PTY");
        }

        if libc::unlockpt(master_fd) != 0 {
            libc::close(master_fd);
            anyhow::bail!("Failed to unlock PTY");
        }

        let slave_name = libc::ptsname(master_fd);
        if slave_name.is_null() {
            libc::close(master_fd);
            anyhow::bail!("Failed to get PTY slave name");
        }

        let slave_fd = libc::open(slave_name, libc::O_RDWR | libc::O_NOCTTY);
        if slave_fd < 0 {
            libc::close(master_fd);
            anyhow::bail!("Failed to open PTY slave");
        }

        // Copy terminal window size to PTY
        let mut ws: libc::winsize = std::mem::zeroed();
        if libc::ioctl(libc::STDIN_FILENO, libc::TIOCGWINSZ, &mut ws) == 0 {
            libc::ioctl(slave_fd, libc::TIOCSWINSZ, &ws);
        }

        Ok((
            OwnedFd::from_raw_fd(master_fd),
            OwnedFd::from_raw_fd(slave_fd),
        ))
    }
}

fn run_io_loop(master: &OwnedFd, child: &mut std::process::Child, stdin_fd: i32) -> Result<()> {
    let master_fd = master.as_raw_fd();
    let mut detector = escape::EscapeDetector::new();

    let mut stdin_buf = [0u8; 8192];
    let mut master_buf = [0u8; 8192];

    let mut master_read = unsafe { std::fs::File::from_raw_fd(master_fd) };
    let mut master_write = master_read.try_clone()?;

    let stdin_borrow = unsafe { BorrowedFd::borrow_raw(stdin_fd) };
    let master_borrow = unsafe { BorrowedFd::borrow_raw(master_fd) };

    let result = (|| -> Result<()> {
        loop {
            if let Some(status) = child.try_wait()? {
                debug!("Session ended with status: {}", status);
                break;
            }

            // Handle SIGWINCH - update PTY window size
            if WINCH_RECEIVED.swap(false, Ordering::SeqCst) {
                unsafe {
                    let mut ws: libc::winsize = std::mem::zeroed();
                    if libc::ioctl(libc::STDIN_FILENO, libc::TIOCGWINSZ, &mut ws) == 0 {
                        libc::ioctl(master_fd, libc::TIOCSWINSZ, &ws);
                        debug!("Window size updated: {}x{}", ws.ws_col, ws.ws_row);
                    }
                }
            }

            let mut poll_fds = [
                PollFd::new(stdin_borrow, PollFlags::POLLIN),
                PollFd::new(master_borrow, PollFlags::POLLIN),
            ];

            match poll(&mut poll_fds, PollTimeout::from(100u16)) {
                Ok(0) => continue,
                Err(nix::errno::Errno::EINTR) => continue,
                Err(e) => return Err(e.into()),
                Ok(_) => {}
            }

            // Handle stdin -> master
            if let Some(revents) = poll_fds[0].revents() {
                if revents.intersects(PollFlags::POLLERR | PollFlags::POLLHUP) {
                    break;
                }
                if revents.contains(PollFlags::POLLIN) {
                    match std::io::stdin().read(&mut stdin_buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            for &byte in &stdin_buf[..n] {
                                if detector.process(byte) {
                                    info!("Escape sequence detected, disconnecting...");
                                    eprintln!(
                                        "\r\n{}",
                                        "Connection closed by escape sequence.".yellow()
                                    );
                                    let _ = child.kill();
                                    let _ = child.wait();
                                    return Ok(());
                                }
                            }
                            let _ = master_write.write_all(&stdin_buf[..n]);
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
            }

            // Handle master -> stdout
            if let Some(revents) = poll_fds[1].revents() {
                if revents.intersects(PollFlags::POLLERR | PollFlags::POLLHUP) {
                    break;
                }
                if revents.contains(PollFlags::POLLIN) {
                    match master_read.read(&mut master_buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let _ = std::io::stdout().write_all(&master_buf[..n]);
                            let _ = std::io::stdout().flush();
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
            }
        }
        Ok(())
    })();

    std::mem::forget(master_read);
    result
}
