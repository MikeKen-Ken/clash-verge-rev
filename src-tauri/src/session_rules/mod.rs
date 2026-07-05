use crate::utils::dirs;
use clash_verge_logging::{Type, logging};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_yaml_ng::{Mapping, Sequence, Value};
use smartstring::alias::String;
use std::path::PathBuf;

const RULES_FILE: &str = "session-rules.json";

struct StoreState {
    rules: Vec<SessionRule>,
    loaded: bool,
}

static STORE: once_cell::sync::Lazy<Mutex<StoreState>> =
    once_cell::sync::Lazy::new(|| Mutex::new(StoreState {
        rules: Vec::new(),
        loaded: false,
    }));

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

#[derive(Debug, Serialize, Deserialize)]
struct RulesFile {
    #[serde(default = "default_version")]
    v: u32,
    #[serde(default)]
    rules: Vec<SessionRule>,
}

fn default_version() -> u32 {
    1
}

impl SessionRule {
    pub fn to_rule_string(&self) -> String {
        format!("{},{},{}", self.rule_type, self.payload, self.target).into()
    }
}

fn storage_path() -> Result<PathBuf, String> {
    dirs::app_home_dir()
        .map(|dir| dir.join(RULES_FILE))
        .map_err(|e| e.to_string())
}

fn load_from_disk() -> Vec<SessionRule> {
    let path = match storage_path() {
        Ok(path) => path,
        Err(err) => {
            logging!(error, Type::File, "读取临时规则路径失败: {err}");
            return Vec::new();
        }
    };

    if !path.exists() {
        return Vec::new();
    }

    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) => {
            logging!(error, Type::File, "读取临时规则文件失败: {err}");
            return Vec::new();
        }
    };

    match serde_json::from_str::<RulesFile>(&raw) {
        Ok(file) => file.rules,
        Err(err) => {
            logging!(error, Type::File, "解析临时规则文件失败: {err}");
            Vec::new()
        }
    }
}

fn persist_rules(rules: &[SessionRule]) {
    #[cfg(test)]
    {
        return;
    }

    let path = match storage_path() {
        Ok(path) => path,
        Err(err) => {
            logging!(error, Type::File, "保存临时规则路径失败: {err}");
            return;
        }
    };

    let payload = RulesFile {
        v: default_version(),
        rules: rules.to_vec(),
    };

    let raw = match serde_json::to_string_pretty(&payload) {
        Ok(raw) => raw,
        Err(err) => {
            logging!(error, Type::File, "序列化临时规则失败: {err}");
            return;
        }
    };

    if let Err(err) = std::fs::write(path, raw) {
        logging!(error, Type::File, "写入临时规则文件失败: {err}");
    }
}

fn with_store<R>(mut f: impl FnMut(&mut StoreState) -> R) -> R {
    let mut store = STORE.lock();
    if !store.loaded {
        store.rules = load_from_disk();
        store.loaded = true;
    }
    f(&mut store)
}

pub fn list_rules() -> Vec<SessionRule> {
    with_store(|store| store.rules.clone())
}

pub fn add_rule(
    rule_type: String,
    payload: String,
    target: String,
    label: String,
) -> SessionRule {
    with_store(|store| {
        store.rules.retain(|r| {
            !(r.rule_type == rule_type && r.payload == payload && r.target == target)
        });

        let rule = SessionRule {
            id: nanoid::nanoid!(8).into(),
            rule_type,
            payload,
            target,
            label,
            created_at: chrono::Local::now().timestamp() as u64,
        };
        store.rules.insert(0, rule.clone());
        persist_rules(&store.rules);
        rule
    })
}

pub fn remove_rule(id: &str) -> bool {
    with_store(|store| {
        let before = store.rules.len();
        store.rules.retain(|r| r.id != id);
        let removed = store.rules.len() < before;
        if removed {
            persist_rules(&store.rules);
        }
        removed
    })
}

pub fn clear_rules() {
    with_store(|store| {
        store.rules.clear();
        persist_rules(&store.rules);
    });
}

/// 将临时规则插入运行配置 rules 最前（仅 rule 模式生效）。
pub fn apply_to_config(mut config: Mapping) -> Mapping {
    let rules = list_rules();
    if rules.is_empty() {
        return config;
    }

    let mut new_seq = Sequence::new();
    for rule in rules.iter() {
        new_seq.push(Value::String(rule.to_rule_string().to_string()));
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

    fn reset_store(rules: Vec<SessionRule>) {
        let mut store = STORE.lock();
        store.rules = rules;
        store.loaded = true;
    }

    #[test]
    fn apply_to_config_prepends_session_rules() {
        reset_store(vec![SessionRule {
            id: "test-id".into(),
            rule_type: "PROCESS-NAME".into(),
            payload: "chrome.exe".into(),
            target: "DIRECT".into(),
            label: "chrome.exe".into(),
            created_at: 0,
        }]);

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
        reset_store(Vec::new());
    }
}
