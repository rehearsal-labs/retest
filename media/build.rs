//! Records how the binary is built, for the greeting and `--version`: the target triple, the profile, and the
//! source revision when it can be told. `RETEST_MEDIA_SOURCE_REVISION` names the revision for a build from sources
//! without git history; otherwise git is asked, and a build without git, or outside a repository, has none. Nothing
//! here downloads or links anything.

use std::path::Path;
use std::process::Command;

fn main() {
    let target = std::env::var("TARGET").unwrap_or_else(|_| "unknown".to_owned());
    let profile = std::env::var("PROFILE").unwrap_or_else(|_| "unknown".to_owned());
    println!("cargo:rustc-env=RETEST_MEDIA_TARGET={target}");
    println!("cargo:rustc-env=RETEST_MEDIA_PROFILE={profile}");
    println!("cargo:rerun-if-env-changed=RETEST_MEDIA_SOURCE_REVISION");
    for path in ["build.rs", "Cargo.toml", "Cargo.lock", "src"] {
        println!("cargo:rerun-if-changed={path}");
    }
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_owned());
    let named = std::env::var("RETEST_MEDIA_SOURCE_REVISION")
        .ok()
        .filter(|revision| is_revision(revision));
    let revision = named.clone().or_else(|| {
        git(&manifest, &["rev-parse", "HEAD"]).filter(|revision| is_revision(revision))
    });
    if let Some(revision) = revision {
        println!("cargo:rustc-env=RETEST_MEDIA_REVISION={revision}");
    }
    // Local changes are read only from git, and only for the crate's own sources.
    if named.is_none()
        && let Some(status) = git(&manifest, &["status", "--porcelain", "--", "."])
    {
        println!("cargo:rustc-env=RETEST_MEDIA_DIRTY={}", !status.is_empty());
    }
    if let Some(git_dir) = git(&manifest, &["rev-parse", "--absolute-git-dir"]) {
        for name in ["HEAD", "index"] {
            let path = Path::new(&git_dir).join(name);
            if path.exists() {
                println!("cargo:rerun-if-changed={}", path.display());
            }
        }
    }
}

fn git(folder: &str, arguments: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(arguments)
        .current_dir(folder)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

// A revision is a hexadecimal object name, so nothing else can travel in the greeting under its name.
fn is_revision(revision: &str) -> bool {
    (7..=64).contains(&revision.len()) && revision.bytes().all(|byte| byte.is_ascii_hexdigit())
}
