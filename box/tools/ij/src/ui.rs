//! Interactive instance selection UI.

use colored::Colorize;
use console::{Style, Term};
use dialoguer::{theme::ColorfulTheme, Select};

use crate::ec2::{ColumnWidths, Instance};
use crate::error::{Error, Result};

/// Instance selector with interactive UI.
pub struct Selector<'a> {
    instances: &'a [Instance],
    widths: ColumnWidths,
}

impl<'a> Selector<'a> {
    /// Create a new selector for the given instances.
    pub fn new(instances: &'a [Instance]) -> Self {
        Self {
            widths: ColumnWidths::from_instances(instances),
            instances,
        }
    }

    /// Show selection UI and return the selected instance.
    pub fn select(&self) -> Result<&'a Instance> {
        let term = Term::stderr();

        // Print header
        println!("  {}", self.widths.header().bright_white().bold());

        // Build items
        let items: Vec<String> = self
            .instances
            .iter()
            .map(|i| i.to_row(&self.widths))
            .collect();

        let theme = ColorfulTheme {
            active_item_style: Style::new().cyan(),
            active_item_prefix: Style::new().cyan().apply_to(">".to_string()),
            inactive_item_prefix: Style::new().apply_to(" ".to_string()),
            ..ColorfulTheme::default()
        };

        let selection = Select::with_theme(&theme)
            .items(&items)
            .default(0)
            .interact_on_opt(&term)
            .map_err(|e| Error::Other(e.into()))?;

        // Clear UI
        let _ = term.clear_last_lines(items.len().min(10) + 1);

        match selection {
            Some(index) => Ok(&self.instances[index]),
            None => Err(Error::Cancelled),
        }
    }
}
