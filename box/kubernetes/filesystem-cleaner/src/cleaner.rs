use anyhow::Result;
use bytesize::ByteSize;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use sysinfo::Disks;
use tokio::time;
use tracing::{error, info, warn};

use crate::config::{Args, CleanupMode};
use crate::matcher::PatternMatcher;
use crate::scanner::FileScanner;

/// Filesystem cleaner orchestrator
///
/// Responsible for:
/// - Monitoring disk usage
/// - Scheduling cleanup operations (once or interval)
/// - Coordinating file scanning and deletion
/// - Logging cleanup results
pub struct Cleaner {
    config: Args,
    matcher: PatternMatcher,
    stopped: Arc<AtomicBool>,
}

impl Cleaner {
    /// Create a new cleaner with the given configuration
    pub fn new(config: Args) -> Result<Self> {
        let matcher = PatternMatcher::new(&config.include_patterns, &config.exclude_patterns)?;

        Ok(Self {
            config,
            matcher,
            stopped: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Run the cleaner based on configured mode (once or interval)
    pub async fn run(&self) -> Result<()> {
        match self.config.cleanup_mode {
            CleanupMode::Once => {
                info!("Running in 'once' mode - single cleanup execution");
                self.perform_cleanup().await;
                info!("Cleanup completed, exiting");
                Ok(())
            }
            CleanupMode::Interval => {
                info!(
                    interval_minutes = self.config.check_interval_minutes,
                    "Running in 'interval' mode - periodic cleanup"
                );

                // Run initial cleanup
                self.perform_cleanup().await;

                // Run periodic cleanup
                let mut interval =
                    time::interval(Duration::from_secs(self.config.check_interval_minutes * 60));

                loop {
                    interval.tick().await;

                    if self.stopped.load(Ordering::Relaxed) {
                        info!("Cleaner stopped");
                        break;
                    }

                    self.perform_cleanup().await;
                }

                Ok(())
            }
        }
    }

    /// Stop the cleaner (for graceful shutdown)
    pub async fn stop(&self) {
        self.stopped.store(true, Ordering::Relaxed);
    }

    /// Perform a single cleanup cycle
    async fn perform_cleanup(&self) {
        info!("Starting cleanup cycle");
        let start_time = std::time::Instant::now();

        for path in &self.config.target_paths {
            let usage = self.get_disk_usage_percent(path);

            if usage > self.config.usage_threshold_percent as f64 {
                warn!(
                    path = %path.display(),
                    usage = usage,
                    threshold = self.config.usage_threshold_percent,
                    cleanup_mode = %self.config.cleanup_mode,
                    dry_run = self.config.dry_run,
                    "Disk usage exceeds threshold, starting cleanup"
                );
                self.clean_path(path).await;
            } else {
                info!(
                    path = %path.display(),
                    usage = usage,
                    threshold = self.config.usage_threshold_percent,
                    cleanup_mode = %self.config.cleanup_mode,
                    "Disk usage is below threshold, skipping cleanup"
                );
            }
        }

        info!(
            duration_secs = start_time.elapsed().as_secs(),
            "Cleanup cycle completed"
        );
    }

    /// Get disk usage percentage for a given path
    fn get_disk_usage_percent(&self, path: &Path) -> f64 {
        let disks = Disks::new_with_refreshed_list();

        // Find the disk that contains this path
        let mut best_match: Option<&sysinfo::Disk> = None;
        let mut best_match_len = 0;

        for disk in &disks {
            let mount_point = disk.mount_point();
            if path.starts_with(mount_point) {
                let mount_len = mount_point.as_os_str().len();
                if mount_len > best_match_len {
                    best_match = Some(disk);
                    best_match_len = mount_len;
                }
            }
        }

        if let Some(disk) = best_match {
            let total = disk.total_space();
            let available = disk.available_space();

            if total == 0 {
                return 0.0;
            }

            let used = total - available;
            (used as f64 / total as f64) * 100.0
        } else {
            error!(path = %path.display(), "Failed to get disk usage - no matching disk found");
            0.0
        }
    }

    /// Clean files in the given path
    async fn clean_path(&self, base_path: &Path) {
        if !base_path.exists() {
            error!(path = %base_path.display(), "Path does not exist");
            return;
        }

        let initial_usage = self.get_disk_usage_percent(base_path);

        // Use FileScanner to collect files
        let scanner = FileScanner::new(&self.matcher);
        let files = scanner.scan(base_path);

        if files.is_empty() {
            info!(
                path = %base_path.display(),
                initial_usage_percent = initial_usage,
                "No files to clean"
            );
            return;
        }

        let total_size: u64 = files.iter().map(|f| f.size).sum();

        info!(
            path = %base_path.display(),
            initial_usage_percent = initial_usage,
            file_count = files.len(),
            total_size = %ByteSize::b(total_size),
            "Starting cleanup operation"
        );

        let mut deleted_count = 0;
        let mut freed_space = 0u64;
        let file_count = files.len();

        for file in &files {
            if self.stopped.load(Ordering::Relaxed) {
                info!("Cleanup interrupted by shutdown");
                break;
            }

            if self.config.dry_run {
                info!(
                    file = %file.path.display(),
                    size = %ByteSize::b(file.size),
                    "[DRY-RUN] Would delete file"
                );
            } else {
                match fs::remove_file(&file.path) {
                    Ok(_) => {
                        info!(
                            file = %file.path.display(),
                            size = %ByteSize::b(file.size),
                            "File deleted successfully"
                        );
                        deleted_count += 1;
                        freed_space += file.size;
                    }
                    Err(e) => {
                        error!(
                            file = %file.path.display(),
                            error = %e,
                            "Failed to delete file"
                        );
                    }
                }
            }
        }

        let final_usage = self.get_disk_usage_percent(base_path);
        let usage_reduction = initial_usage - final_usage;

        if self.config.dry_run {
            info!(
                path = %base_path.display(),
                initial_usage_percent = initial_usage,
                final_usage_percent = final_usage,
                usage_reduction = usage_reduction,
                would_delete = file_count,
                "Cleanup completed (DRY-RUN)"
            );
        } else {
            info!(
                path = %base_path.display(),
                initial_usage_percent = initial_usage,
                final_usage_percent = final_usage,
                usage_reduction = usage_reduction,
                deleted_count = deleted_count,
                freed_space = %ByteSize::b(freed_space),
                "Cleanup completed successfully"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Args, CleanupMode};
    use std::fs::File;
    use std::io::Write;
    use std::path::PathBuf;
    use tempfile::TempDir;

    fn make_args(
        target_paths: Vec<PathBuf>,
        threshold: u8,
        mode: CleanupMode,
        dry_run: bool,
    ) -> Args {
        Args {
            target_paths,
            usage_threshold_percent: threshold,
            check_interval_minutes: 1,
            include_patterns: vec!["*".to_string()],
            exclude_patterns: vec![],
            cleanup_mode: mode,
            dry_run,
            log_level: "info".to_string(),
        }
    }

    fn create_file(dir: &Path, name: &str, content: &[u8]) {
        let path = dir.join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        File::create(path).unwrap().write_all(content).unwrap();
    }

    #[test]
    fn test_cleaner_new_success() {
        let args = make_args(vec![PathBuf::from("/tmp")], 80, CleanupMode::Once, true);
        assert!(Cleaner::new(args).is_ok());
    }

    #[test]
    fn test_cleaner_new_invalid_include_pattern() {
        let mut args = make_args(vec![PathBuf::from("/tmp")], 80, CleanupMode::Once, true);
        args.include_patterns = vec!["[invalid".to_string()];
        assert!(Cleaner::new(args).is_err());
    }

    #[test]
    fn test_cleaner_new_invalid_exclude_pattern() {
        let mut args = make_args(vec![PathBuf::from("/tmp")], 80, CleanupMode::Once, true);
        args.exclude_patterns = vec!["[invalid".to_string()];
        assert!(Cleaner::new(args).is_err());
    }

    #[tokio::test]
    async fn test_stop_sets_flag() {
        let args = make_args(vec![PathBuf::from("/tmp")], 80, CleanupMode::Once, true);
        let cleaner = Cleaner::new(args).unwrap();
        assert!(!cleaner.stopped.load(Ordering::Relaxed));
        cleaner.stop().await;
        assert!(cleaner.stopped.load(Ordering::Relaxed));
    }

    #[test]
    fn test_get_disk_usage_percent_absolute_path() {
        let temp = TempDir::new().unwrap();
        let args = make_args(vec![temp.path().to_path_buf()], 80, CleanupMode::Once, true);
        let cleaner = Cleaner::new(args).unwrap();
        let usage = cleaner.get_disk_usage_percent(temp.path());
        assert!((0.0..=100.0).contains(&usage));
    }

    #[test]
    fn test_get_disk_usage_percent_relative_path_no_match() {
        let args = make_args(vec![PathBuf::from("/tmp")], 80, CleanupMode::Once, true);
        let cleaner = Cleaner::new(args).unwrap();
        // Relative paths cannot match any mount point (mount points are absolute)
        let usage = cleaner.get_disk_usage_percent(Path::new("relative/nonexistent"));
        assert_eq!(usage, 0.0);
    }

    #[tokio::test]
    async fn test_clean_path_nonexistent() {
        let args = make_args(
            vec![PathBuf::from("/does/not/exist/zzzz-test")],
            0,
            CleanupMode::Once,
            true,
        );
        let cleaner = Cleaner::new(args).unwrap();
        cleaner
            .clean_path(Path::new("/does/not/exist/zzzz-test"))
            .await;
    }

    #[tokio::test]
    async fn test_clean_path_empty_directory() {
        let temp = TempDir::new().unwrap();
        let args = make_args(vec![temp.path().to_path_buf()], 0, CleanupMode::Once, false);
        let cleaner = Cleaner::new(args).unwrap();
        cleaner.clean_path(temp.path()).await;
        assert!(temp.path().exists());
    }

    #[tokio::test]
    async fn test_clean_path_dry_run_preserves_files() {
        let temp = TempDir::new().unwrap();
        create_file(temp.path(), "keep1.txt", b"hello");
        create_file(temp.path(), "keep2.txt", b"world");

        let args = make_args(vec![temp.path().to_path_buf()], 0, CleanupMode::Once, true);
        let cleaner = Cleaner::new(args).unwrap();
        cleaner.clean_path(temp.path()).await;

        assert!(temp.path().join("keep1.txt").exists());
        assert!(temp.path().join("keep2.txt").exists());
    }

    #[tokio::test]
    async fn test_clean_path_deletes_files() {
        let temp = TempDir::new().unwrap();
        create_file(temp.path(), "delete1.txt", b"hello");
        create_file(temp.path(), "delete2.txt", b"world");
        create_file(temp.path(), "sub/delete3.txt", b"nested");

        let args = make_args(vec![temp.path().to_path_buf()], 0, CleanupMode::Once, false);
        let cleaner = Cleaner::new(args).unwrap();
        cleaner.clean_path(temp.path()).await;

        assert!(!temp.path().join("delete1.txt").exists());
        assert!(!temp.path().join("delete2.txt").exists());
        assert!(!temp.path().join("sub/delete3.txt").exists());
    }

    #[tokio::test]
    async fn test_clean_path_respects_stop_flag() {
        let temp = TempDir::new().unwrap();
        create_file(temp.path(), "file1.txt", b"a");
        create_file(temp.path(), "file2.txt", b"b");

        let args = make_args(vec![temp.path().to_path_buf()], 0, CleanupMode::Once, false);
        let cleaner = Cleaner::new(args).unwrap();
        cleaner.stop().await;
        cleaner.clean_path(temp.path()).await;

        // Deletion loop bails at the stop check before touching the files
        assert!(temp.path().join("file1.txt").exists());
        assert!(temp.path().join("file2.txt").exists());
    }

    #[tokio::test]
    async fn test_perform_cleanup_below_threshold_skips() {
        let temp = TempDir::new().unwrap();
        create_file(temp.path(), "keep.txt", b"data");

        let args = make_args(
            vec![temp.path().to_path_buf()],
            100,
            CleanupMode::Once,
            false,
        );
        let cleaner = Cleaner::new(args).unwrap();
        cleaner.perform_cleanup().await;

        assert!(temp.path().join("keep.txt").exists());
    }

    #[tokio::test]
    async fn test_perform_cleanup_exceeds_threshold_cleans() {
        let temp = TempDir::new().unwrap();
        create_file(temp.path(), "to-delete.txt", b"bytes");

        let args = make_args(vec![temp.path().to_path_buf()], 0, CleanupMode::Once, false);
        let cleaner = Cleaner::new(args).unwrap();
        cleaner.perform_cleanup().await;

        assert!(!temp.path().join("to-delete.txt").exists());
    }

    #[tokio::test]
    async fn test_run_once_mode_executes_and_returns() {
        let temp = TempDir::new().unwrap();
        create_file(temp.path(), "once.txt", b"x");

        let args = make_args(vec![temp.path().to_path_buf()], 0, CleanupMode::Once, false);
        let cleaner = Cleaner::new(args).unwrap();
        cleaner.run().await.unwrap();

        assert!(!temp.path().join("once.txt").exists());
    }

    #[tokio::test]
    async fn test_run_interval_mode_breaks_on_stop() {
        let temp = TempDir::new().unwrap();
        let args = make_args(
            vec![temp.path().to_path_buf()],
            100,
            CleanupMode::Interval,
            true,
        );
        let cleaner = Cleaner::new(args).unwrap();
        // Pre-set stop so the loop breaks at the first post-tick check
        cleaner.stop().await;

        let result = tokio::time::timeout(Duration::from_secs(5), cleaner.run()).await;
        assert!(result.is_ok(), "run() did not exit within 5s after stop");
        assert!(result.unwrap().is_ok());
    }
}
