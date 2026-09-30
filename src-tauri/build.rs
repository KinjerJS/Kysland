//! Tauri's build, and llama.cpp's libraries for Kys's smart brain (brain.rs): gathered in `llama/`,
//! installed with Kysland. They're delay-loaded: Kysland starts without them, and only loads them
//! when the smart brain is used.
use std::path::{Path, PathBuf};

fn main() {
    llama_libraries();
    tauri_build::build()
}

/// llama.dll, ggml*.dll, and ggml's CPU variants (the best one for the PC is picked at run time:
/// SSE4.2, AVX2, AVX-512...), copied to `llama/`.
fn llama_libraries() {
    let backends = PathBuf::from(std::env::var("DEP_LLAMA_BACKENDS_DIR").expect("llama-cpp-sys-2 without dynamic-backends"));
    let out = backends.parent().expect("llama-cpp-sys-2's output folder");
    let dest = Path::new("llama");
    std::fs::create_dir_all(dest).expect("llama/");
    let mut wanted = Vec::new();
    for name in ["llama.dll", "ggml.dll", "ggml-base.dll"] { wanted.push(out.join("bin").join(name)); }
    for name in ["llama.dll", "ggml.dll"] { println!("cargo:rustc-link-arg=/DELAYLOAD:{name}"); } // what Kysland calls
    for entry in std::fs::read_dir(&backends).expect("backends").flatten() {
        if entry.path().extension().is_some_and(|e| e == "dll") { wanted.push(entry.path()); }
    }
    for src in &wanted {
        let to = dest.join(src.file_name().unwrap());
        let same = std::fs::metadata(&to).ok().zip(std::fs::metadata(src).ok())
            .is_some_and(|(a, b)| a.len() == b.len() && a.modified().ok() >= b.modified().ok());
        if !same { std::fs::copy(src, &to).unwrap_or_else(|e| panic!("{}: {e}", src.display())); }
    }
    // Leftovers of another llama.cpp version.
    for entry in std::fs::read_dir(dest).expect("llama/").flatten() {
        if !wanted.iter().any(|w| w.file_name() == Some(&entry.file_name())) { let _ = std::fs::remove_file(entry.path()); }
    }
    println!("cargo:rustc-link-lib=delayimp");
    println!("cargo:rerun-if-changed={}", backends.display());
}
