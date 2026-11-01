//! Persisted pins (`PrfItem::selected`) of the current profile.
//!
//! Every pin edit goes through [`profiles_set_current_group_pin_safe`], which
//! reads and writes under the profiles lock. A frontend read-modify-write on a
//! cached copy could otherwise overwrite another group's newer pin.

use super::{PrfSelected, profiles::IProfiles};
use crate::config::Config;
use anyhow::{Result, bail};
use clash_verge_logging::{Type, logging};
use smartstring::alias::String;
use std::time::Duration;

impl IProfiles {
    /// Set (`Some`) or remove (`None`) the pin of one group on the current
    /// profile. Returns whether anything changed.
    pub fn set_current_group_pin(&mut self, group: &str, now: Option<&str>) -> Result<bool> {
        let Some(uid) = self.current.clone() else {
            bail!("no current profile");
        };
        let Some(item) = self
            .items
            .as_mut()
            .and_then(|items| items.iter_mut().find(|item| item.uid.as_ref() == Some(&uid)))
        else {
            bail!("current profile \"{uid}\" not found");
        };

        let selected = item.selected.get_or_insert_with(Vec::new);
        let before = selected.clone();
        selected.retain(|s| s.name.as_deref() != Some(group));
        if let Some(now) = now.filter(|n| !n.is_empty()) {
            selected.push(PrfSelected {
                name: Some(String::from(group)),
                now: Some(String::from(now)),
            });
        }
        Ok(selected.len() != before.len()
            || selected.iter().zip(before.iter()).any(|(a, b)| a.name != b.name || a.now != b.now))
    }
}

const PIN_SAVE_ATTEMPTS: u32 = 8;

/// Save one group's pin. The profiles draft uses an optimistic lock that fails
/// when another writer (a subscription update, for instance) commits first, so
/// a lost race is retried instead of silently dropping the pin.
pub async fn profiles_set_current_group_pin_safe(group: &str, now: Option<&str>) -> Result<()> {
    let mut attempt = 1;
    loop {
        let result = Config::profiles()
            .await
            .with_data_modify(|mut profiles| async move {
                let changed = profiles.set_current_group_pin(group, now)?;
                if changed {
                    profiles.save_file().await?;
                }
                Ok((profiles, ()))
            })
            .await;
        match result {
            Ok(()) => return Ok(()),
            Err(err) if attempt < PIN_SAVE_ATTEMPTS && err.to_string().contains("Optimistic lock") => {
                logging!(
                    warn,
                    Type::Config,
                    "Saving pin for group {group} lost a write race (attempt {attempt}); retrying"
                );
                tokio::time::sleep(Duration::from_millis(50 * u64::from(attempt))).await;
                attempt += 1;
            }
            Err(err) => return Err(err),
        }
    }
}
