use super::cleanup_proxy_groups;

#[test]
fn pass_rule_survives_proxy_group_cleanup() {
    let config = serde_yaml_ng::from_str(
        "proxy-groups:\n  - name: test\n    type: select\n    proxies: [PASS-RULE, DIRECT, missing]\n",
    )
    .unwrap();
    let result = cleanup_proxy_groups(config);
    let proxies = result["proxy-groups"][0]["proxies"].as_sequence().unwrap();
    assert_eq!(proxies.len(), 2);
    assert!(proxies.iter().any(|p| p.as_str() == Some("PASS-RULE")));
    assert!(proxies.iter().any(|p| p.as_str() == Some("DIRECT")));
}
