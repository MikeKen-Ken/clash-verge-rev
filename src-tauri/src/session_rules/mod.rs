use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_yaml_ng::{Mapping, Sequence, Value};
use smartstring::alias::String;

static STORE: once_cell::sync::Lazy<Mutex<Vec<SessionRule>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(Vec::new()));

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRule {
    pub id: String,
    pub rule_type: String,
    pub payload: String,
    pub target: String,
    pub label: String,
    pub created_at: u64,
}

impl SessionRule {
    pub fn to_rule_string(&self) -> String {
        format!("{},{},{}", self.rule_type, self.payload, self.target).into()
    }
}

pub fn list_rules() -> Vec<SessionRule> {
    STORE.lock().clone()
}

pub fn add_rule(
    rule_type: String,
    payload: String,
    target: String,
    label: String,
) -> SessionRule {
    let mut store = STORE.lock();
    store.retain(|r| {
        !(r.rule_type == rule_type && r.payload == payload && r.target == target)
    });

    let rule = SessionRule {
        id: nanoid::nanoid!(8),
        rule_type,
        payload,
        target,
        label,
        created_at: chrono::Local::now().timestamp() as u64,
    };
    store.insert(0, rule.clone());
    rule
}

pub fn remove_rule(id: &str) -> bool {
    let mut store = STORE.lock();
    let before = store.len();
    store.retain(|r| r.id != id);
    store.len() < before
}

pub fn clear_rules() {
    STORE.lock().clear();
}

/// 将临时规则插入运行配置 rules 最前（仅 rule 模式生效）。
pub fn apply_to_config(mut config: Mapping) -> Mapping {
    let rules = STORE.lock();
    if rules.is_empty() {
        return config;
    }

    let mut new_seq = Sequence::new();
    for rule in rules.iter() {
        new_seq.push(Value::String(rule.to_rule_string()));
    }

    if let Some(Value::Sequence(origin)) = config.get("rules") {
        new_seq.extend(origin.iter().cloned());
    }

    config.insert(Value::String("rules".into()), Value::Sequence(new_seq));
    config
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_to_config_prepends_session_rules() {
        clear_rules();
        add_rule(
            "PROCESS-NAME".into(),
            "chrome.exe".into(),
            "DIRECT".into(),
            "chrome.exe".into(),
        );

        let mut config = Mapping::new();
        config.insert(
            "rules".into(),
            Value::Sequence(vec![Value::String("MATCH,DIRECT".into())]),
        );

        let result = apply_to_config(config);
        let seq = result
            .get("rules")
            .and_then(Value::as_sequence)
            .expect("rules should exist");
        assert_eq!(seq.len(), 2);
        assert_eq!(seq[0].as_str(), Some("PROCESS-NAME,chrome.exe,DIRECT"));
        assert_eq!(seq[1].as_str(), Some("MATCH,DIRECT"));
        clear_rules();
    }
}
