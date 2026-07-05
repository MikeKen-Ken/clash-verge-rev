use super::CmdResult;
use crate::{feat, session_rules::{self, SessionRule}};
use smartstring::alias::String;

#[tauri::command]
pub fn get_session_rules() -> Vec<SessionRule> {
    session_rules::list_rules()
}

#[tauri::command]
pub async fn add_session_rule(
    rule_type: String,
    payload: String,
    target: String,
    label: String,
) -> CmdResult<SessionRule> {
    let rule = session_rules::add_rule(rule_type, payload, target, label);
    feat::enhance_profiles()
        .await
        .map_err(|e| e.to_string())?;
    Ok(rule)
}

#[tauri::command]
pub async fn remove_session_rule(id: String) -> CmdResult {
    if !session_rules::remove_rule(&id) {
        return Err("临时规则不存在".into());
    }
    feat::enhance_profiles()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn clear_session_rules() -> CmdResult {
    session_rules::clear_rules();
    feat::enhance_profiles()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
