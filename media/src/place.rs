//! Puts a finished file at its path without ever replacing what is there.
//!
//! A hard link fails rather than replace a file, so it is the first choice. A filesystem without hard links, such
//! as FAT or exFAT, refuses the link; then the file is copied to `<path>.copying` beside it, synced, and renamed to
//! the path with a rename that refuses to replace a file, so nothing is ever at the path but a whole file. A process
//! killed during the copy leaves the `.copying` file, which `leftovers` lists and removes.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// How a file was put in place.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Placed {
    Link,
    Copy,
}

impl Placed {
    pub fn name(self) -> &'static str {
        match self {
            Placed::Link => "link",
            Placed::Copy => "copy",
        }
    }
}

/// The `.partial` file beside a path.
pub fn partial_path_of(path: &Path) -> PathBuf {
    let mut partial = path.as_os_str().to_owned();
    partial.push(".partial");
    PathBuf::from(partial)
}

/// The file a copy into place is written to before it is renamed to the path.
pub fn copying_path_of(path: &Path) -> PathBuf {
    let mut copying = path.as_os_str().to_owned();
    copying.push(".copying");
    PathBuf::from(copying)
}

/// Moves `partial` to `path`, never replacing a file at `path`. On failure `partial` is kept.
pub fn place(partial: &Path, path: &Path) -> io::Result<Placed> {
    let placed = retain_source(partial, path)?;
    let _ = fs::remove_file(partial);
    Ok(placed)
}

/// Publishes a complete file without removing its original partial.
pub fn retain_source(partial: &Path, path: &Path) -> io::Result<Placed> {
    delayed_if_a_test_asks();
    match link(partial, path) {
        Ok(()) => Ok(Placed::Link),
        Err(error) if links_unavailable(&error) => {
            copy_exclusively(partial, path)?;
            Ok(Placed::Copy)
        }
        Err(error) => Err(error),
    }
}

/// Private child-process result. Missing or empty encoder output is distinct from failed placement.
#[derive(Debug, Serialize, Deserialize)]
pub enum Finalization {
    Placed(Placed),
    Failed(String),
    Missing(String),
}

/// All potentially blocking file inspection, copying, syncing and publication runs in the supervised child.
pub fn finalize_file(partial: &Path, path: &Path) -> Finalization {
    match fs::metadata(partial) {
        Ok(metadata) if metadata.len() > 0 => {}
        Ok(_) => {
            return Finalization::Missing(
                "the encoder exited successfully but wrote an empty file".to_owned(),
            );
        }
        Err(error) => {
            return Finalization::Missing(format!(
                "the encoder exited successfully but its file is missing: {error}"
            ));
        }
    }
    match retain_source(partial, path) {
        Ok(placed) => match fs::remove_file(partial) {
            Ok(()) => Finalization::Placed(placed),
            Err(error) => Finalization::Failed(format!(
                "the video was placed at {}, but its source at {} could not be removed: {error}",
                path.display(),
                partial.display()
            )),
        },
        Err(error) => Finalization::Failed(format!(
            "the video could not be put at {}: {error}; it is kept at {}",
            path.display(),
            partial.display()
        )),
    }
}

// Slow or stuck filesystem finalization, isolated to the process under test. Release builds have no hook.
#[cfg(debug_assertions)]
fn delayed_if_a_test_asks() {
    if let Ok(value) = std::env::var("RETEST_MEDIA_TEST_FINALIZE_DELAY_MS")
        && let Ok(delay) = value.parse::<u64>()
    {
        std::thread::sleep(std::time::Duration::from_millis(delay));
    }
}

#[cfg(not(debug_assertions))]
fn delayed_if_a_test_asks() {}

// A test sets this to prove the copy path on a filesystem that has hard links. Release builds have no hook.
#[cfg(debug_assertions)]
fn link(partial: &Path, path: &Path) -> io::Result<()> {
    if std::env::var_os("RETEST_MEDIA_TEST_NO_HARD_LINKS").is_some() {
        return Err(io::Error::from_raw_os_error(libc::ENOTSUP));
    }
    fs::hard_link(partial, path)
}

#[cfg(not(debug_assertions))]
fn link(partial: &Path, path: &Path) -> io::Result<()> {
    fs::hard_link(partial, path)
}

/// Whether a failed link means the filesystem cannot link, rather than that something is at the path.
fn links_unavailable(error: &io::Error) -> bool {
    if error.kind() == io::ErrorKind::Unsupported {
        return true;
    }
    matches!(
        error.raw_os_error(),
        Some(code) if [libc::EPERM, libc::ENOTSUP, libc::EOPNOTSUPP, libc::EXDEV, libc::EMLINK, libc::ENOSYS].contains(&code)
    )
}

fn copy_exclusively(partial: &Path, path: &Path) -> io::Result<()> {
    if path.symlink_metadata().is_ok() {
        return Err(io::Error::from(io::ErrorKind::AlreadyExists));
    }
    let copying = copying_path_of(path);
    let mut source = File::open(partial)?;
    let mut target = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&copying)?;
    let placed = copy_in_chunks(&mut source, &mut target)
        .and_then(|()| target.sync_all())
        .and_then(|()| rename_without_replacing(&copying, path));
    if let Err(error) = placed {
        drop(target);
        // The `.copying` file is the one this call created, never anyone else's: `create_new` made it.
        let _ = fs::remove_file(&copying);
        return Err(error);
    }
    Ok(())
}

// Renames `from` to `to` exclusively, or publishes it through a hard link and unlinks the old name. If neither
// operation is supported, placement fails with the destination named and keeps the source. Ordinary rename is
// never used because it can replace a foreign file between a check and publication.
fn rename_without_replacing(from: &Path, to: &Path) -> io::Result<()> {
    rename_using(from, to, exclusive_rename, || {})
}

fn rename_using(
    from: &Path,
    to: &Path,
    rename: impl FnOnce(&Path, &Path) -> io::Result<()>,
    before_fallback: impl FnOnce(),
) -> io::Result<()> {
    match rename(from, to) {
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(code) if [libc::ENOTSUP, libc::EOPNOTSUPP, libc::EINVAL, libc::ENOSYS].contains(&code)
            ) =>
        {
            if to.symlink_metadata().is_ok() {
                return Err(io::Error::from(io::ErrorKind::AlreadyExists));
            }
            before_fallback();
            fs::hard_link(from, to)
                .and_then(|()| fs::remove_file(from))
                .map_err(|error| {
                    io::Error::new(
                        error.kind(),
                        format!(
                            "cannot place the file at {} without replacing: {error}",
                            to.display()
                        ),
                    )
                })
        }
        renamed => renamed,
    }
}

#[cfg(target_os = "macos")]
fn exclusive_rename(from: &Path, to: &Path) -> io::Result<()> {
    let (from, to) = (c_path(from)?, c_path(to)?);
    // SAFETY: renamex_np(2) takes two NUL-terminated paths that live across the call, and a flag.
    let renamed = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    if renamed == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
fn exclusive_rename(from: &Path, to: &Path) -> io::Result<()> {
    let (from, to) = (c_path(from)?, c_path(to)?);
    // SAFETY: renameat2(2) takes two NUL-terminated paths that live across the call, relative to the working folder.
    let renamed = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if renamed == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn exclusive_rename(_: &Path, _: &Path) -> io::Result<()> {
    Err(io::Error::from_raw_os_error(libc::ENOTSUP))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn c_path(path: &Path) -> io::Result<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
}

const COPY_CHUNK: usize = 256 * 1024;

fn copy_in_chunks(source: &mut File, target: &mut File) -> io::Result<()> {
    let mut chunk = vec![0u8; COPY_CHUNK];
    loop {
        let read = source.read(&mut chunk)?;
        if read == 0 {
            return Ok(());
        }
        target.write_all(&chunk[..read])?;
        killed_if_a_test_asks();
    }
}

// A test sets this to prove what a process killed in the middle of a copy leaves behind. Release builds have no hook.
#[cfg(debug_assertions)]
fn killed_if_a_test_asks() {
    if std::env::var_os("RETEST_MEDIA_TEST_KILL_DURING_COPY").is_some() {
        // SAFETY: kill(2) on this process's own pid; SIGKILL leaves exactly what a kill from outside would.
        unsafe {
            libc::kill(libc::getpid(), libc::SIGKILL);
        }
    }
}

#[cfg(not(debug_assertions))]
fn killed_if_a_test_asks() {}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> PathBuf {
        let folder =
            std::env::temp_dir().join(format!("retest-media-place-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(&folder).expect("created");
        folder
    }

    #[test]
    fn a_link_puts_the_file_in_place_and_removes_the_partial() {
        let folder = folder("link");
        let path = folder.join("video.mp4");
        let partial = partial_path_of(&path);
        fs::write(&partial, b"video").expect("written");
        assert_eq!(place(&partial, &path).expect("placed"), Placed::Link);
        assert_eq!(fs::read(&path).expect("there"), b"video");
        assert!(!partial.exists());
        let _ = fs::remove_dir_all(folder);
    }

    #[test]
    fn nothing_at_the_path_is_replaced_and_the_partial_is_kept() {
        let folder = folder("taken");
        let path = folder.join("video.mp4");
        let partial = partial_path_of(&path);
        fs::write(&partial, b"video").expect("written");
        fs::write(&path, b"someone else's").expect("written");
        assert!(place(&partial, &path).is_err());
        assert!(
            copy_exclusively(&partial, &path).is_err(),
            "the copy refuses a taken path too"
        );
        assert_eq!(fs::read(&path).expect("there"), b"someone else's");
        assert_eq!(fs::read(&partial).expect("kept"), b"video");
        let _ = fs::remove_dir_all(folder);
    }

    #[test]
    fn the_copy_is_renamed_into_place_and_never_replaces_a_file() {
        let folder = folder("rename");
        let path = folder.join("video.mp4");
        let copying = copying_path_of(&path);
        fs::write(&copying, b"whole").expect("written");
        fs::write(&path, b"someone else's").expect("written");
        assert!(rename_without_replacing(&copying, &path).is_err());
        assert_eq!(fs::read(&path).expect("there"), b"someone else's");
        fs::remove_file(&path).expect("removed");
        rename_without_replacing(&copying, &path).expect("renamed");
        assert_eq!(fs::read(&path).expect("there"), b"whole");
        assert!(!copying.exists());
        let _ = fs::remove_dir_all(folder);
    }

    #[test]
    fn a_foreign_writer_at_the_unsupported_rename_boundary_is_never_replaced() {
        let folder = folder("foreign-race");
        let path = folder.join("video.mp4");
        let copying = copying_path_of(&path);
        fs::write(&copying, b"our complete video").expect("written");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let other = {
            let path = path.clone();
            let barrier = std::sync::Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                fs::write(&path, b"foreign complete video").expect("foreign writer");
                barrier.wait();
            })
        };
        let result = rename_using(
            &copying,
            &path,
            |_, _| Err(io::Error::from_raw_os_error(libc::ENOTSUP)),
            || {
                barrier.wait();
                barrier.wait();
            },
        );
        other.join().expect("writer ends");
        assert!(
            result.is_err(),
            "a foreign completed video must make this producer fail"
        );
        let error = result.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert!(
            error
                .to_string()
                .contains(&path.to_string_lossy().to_string()),
            "the conflict must name its path: {error}"
        );
        assert_eq!(
            fs::read(&path).expect("foreign retained"),
            b"foreign complete video"
        );
        assert_eq!(
            fs::read(&copying).expect("ours retained"),
            b"our complete video"
        );
        let _ = fs::remove_dir_all(folder);
    }

    #[test]
    fn the_copy_path_writes_the_same_bytes() {
        let folder = folder("copy");
        let path = folder.join("video.mp4");
        let partial = partial_path_of(&path);
        let bytes: Vec<u8> = (0..200_000u32).map(|value| value as u8).collect();
        fs::write(&partial, &bytes).expect("written");
        copy_exclusively(&partial, &path).expect("copied");
        assert_eq!(fs::read(&path).expect("there"), bytes);
        let _ = fs::remove_dir_all(folder);
    }

    #[test]
    fn only_link_refusals_choose_the_copy() {
        for code in [libc::EPERM, libc::ENOTSUP, libc::EXDEV, libc::EMLINK] {
            assert!(
                links_unavailable(&io::Error::from_raw_os_error(code)),
                "{code}"
            );
        }
        for code in [libc::EEXIST, libc::ENOENT, libc::EACCES, libc::ENOSPC] {
            assert!(
                !links_unavailable(&io::Error::from_raw_os_error(code)),
                "{code}"
            );
        }
    }
}
