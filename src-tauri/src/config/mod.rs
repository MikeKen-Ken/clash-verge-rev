mod clash;
#[allow(clippy::module_inception)]
mod config;
mod encrypt;
mod prfitem;
mod profile_pins;
mod proxy_mode;
pub mod profiles;
pub mod runtime;
mod verge;

pub use self::{
    clash::*, config::*, encrypt::*, prfitem::*, profile_pins::*, profiles::*, proxy_mode::*, verge::*,
};

pub const DEFAULT_PAC: &str = r#"function FindProxyForURL(url, host) {
  return "PROXY 127.0.0.1:%mixed-port%; SOCKS5 127.0.0.1:%mixed-port%; DIRECT;";
}
"#;
