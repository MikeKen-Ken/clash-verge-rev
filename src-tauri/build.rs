fn main() {
    #[cfg(feature = "clippy")]
    {
        println!("cargo:warning=Skipping tauri_build during Clippy");
    }

    #[cfg(not(feature = "clippy"))]
    {
        ensure_frontend_dist();
        tauri_build::build();
    }
}

/// `tauri::generate_context!()` panics if `frontendDist` is missing.
/// CI `cargo test --lib` does not run the frontend build, so create a placeholder.
#[cfg(not(feature = "clippy"))]
fn ensure_frontend_dist() {
    let manifest_dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let dist = manifest_dir.join("..").join("dist");
    if dist.exists() {
        return;
    }
    std::fs::create_dir_all(&dist).expect("create frontend dist placeholder");
    std::fs::write(dist.join("index.html"), "<!doctype html><title>clash-verge</title>\n")
        .expect("write frontend dist placeholder");
}
