//! A recording's kept frames: the bytes of every frame the encoder thread took, as they arrived, one after another
//! in one file beside the output, so frame sequences can be read back while the recording runs and after it ends.
//!
//! Only the encoder thread appends, and it records a frame's place in the ledger after its bytes are written, so a
//! reader never sees a place whose bytes are not there yet. The file is the process's own working file: it is
//! removed when the recording is released, when the process shuts down, or, after the process was killed, by the
//! client or by a `leftovers` request.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The default and largest size of a recording's kept frames.
pub const DEFAULT_STORE_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_STORE_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// The kept-frames file beside an output path without its extension.
pub fn store_path_of(output: &Path) -> PathBuf {
    let mut path = output.as_os_str().to_owned();
    path.push(".frames");
    PathBuf::from(path)
}

#[derive(Debug)]
struct Writer {
    file: Option<File>,
    written: u64,
    /// Why the store stopped taking frames, when a write failed.
    failure: Option<String>,
}

/// Why a frame was not kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotKept {
    /// Keeping it would pass the store's size.
    Full,
    /// The store could not be written, or is gone.
    Failed(String),
}

#[derive(Debug)]
pub struct FrameStore {
    path: PathBuf,
    max_bytes: u64,
    writer: Mutex<Writer>,
}

impl FrameStore {
    /// Creates the file, refusing one that is already there.
    pub fn create(path: PathBuf, max_bytes: u64) -> io::Result<FrameStore> {
        // Readable too, so readers take this very file rather than whatever its path names later.
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)?;
        Ok(FrameStore {
            path,
            max_bytes,
            writer: Mutex::new(Writer {
                file: Some(file),
                written: 0,
                failure: None,
            }),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn max_bytes(&self) -> u64 {
        self.max_bytes
    }

    /// Appends one frame's bytes and returns where they start.
    pub fn append(&self, bytes: &[u8]) -> Result<u64, NotKept> {
        let mut writer = self.lock();
        if let Some(failure) = &writer.failure {
            return Err(NotKept::Failed(failure.clone()));
        }
        let length = bytes.len() as u64;
        if writer.written.saturating_add(length) > self.max_bytes {
            return Err(NotKept::Full);
        }
        let offset = writer.written;
        let written = match writer.file.as_mut() {
            Some(file) => file.write_all(bytes),
            None => Err(io::Error::from(io::ErrorKind::NotFound)),
        };
        match written {
            Ok(()) => {
                writer.written += length;
                Ok(offset)
            }
            Err(error) => {
                let failure = format!("the kept frames could not be written: {error}");
                writer.failure = Some(failure.clone());
                Err(NotKept::Failed(failure))
            }
        }
    }

    /// Why the store stopped keeping frames, if it did.
    pub fn failure(&self) -> Option<String> {
        self.lock().failure.clone()
    }

    /// A handle on the store's own file for reading frames back. Fails once the store is removed. The path is never
    /// opened again: after a release, a new recording at the same output may have a file of its own there.
    pub fn reader(&self) -> io::Result<StoreReader> {
        let writer = self.lock();
        let file = writer
            .file
            .as_ref()
            .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
        Ok(StoreReader {
            file: file.try_clone()?,
        })
    }

    /// Removes the file, and says whether there was one to remove. Later appends fail.
    pub fn remove(&self) -> bool {
        let mut writer = self.lock();
        let had = writer.file.take().is_some();
        writer
            .failure
            .get_or_insert_with(|| "the kept frames were removed".to_owned());
        had && fs::remove_file(&self.path).is_ok()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Writer> {
        self.writer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// An open handle on a store's file; it reads frames whose places the ledger recorded.
pub struct StoreReader {
    file: File,
}

impl StoreReader {
    pub fn read(&self, offset: u64, length: u32) -> io::Result<Vec<u8>> {
        let mut bytes = vec![0u8; length as usize];
        self.file.read_exact_at(&mut bytes, offset)?;
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "retest-media-store-{}-{name}.frames",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);
        path
    }

    #[test]
    fn frames_are_read_back_where_they_were_appended() {
        let store = FrameStore::create(path("read"), 1024).expect("created");
        assert_eq!(store.append(b"first"), Ok(0));
        assert_eq!(store.append(b"second"), Ok(5));
        let reader = store.reader().expect("opens");
        assert_eq!(reader.read(5, 6).expect("reads"), b"second");
        assert_eq!(reader.read(0, 5).expect("reads"), b"first");
        assert!(store.remove());
        assert!(!store.path().exists());
    }

    #[test]
    fn a_reader_reads_the_store_s_own_file_even_after_its_path_names_another() {
        let target = path("reopen");
        let store = FrameStore::create(target.clone(), 1024).expect("created");
        assert_eq!(store.append(b"mine"), Ok(0));
        // Another file now answers to the store's path, as after a release and a new start at the same output.
        fs::remove_file(&target).expect("removed");
        fs::write(&target, b"theirs").expect("written");
        let reader = store.reader().expect("opens");
        assert_eq!(reader.read(0, 4).expect("reads"), b"mine");
        let _ = fs::remove_file(&target);
    }

    #[test]
    fn an_existing_file_is_refused_and_a_full_store_says_so() {
        let target = path("full");
        fs::write(&target, b"someone else's").expect("written");
        assert!(FrameStore::create(target.clone(), 10).is_err());
        assert_eq!(fs::read(&target).expect("kept"), b"someone else's");
        fs::remove_file(&target).expect("removed");
        let store = FrameStore::create(target, 10).expect("created");
        assert_eq!(store.append(b"123456"), Ok(0));
        assert_eq!(store.append(b"12345"), Err(NotKept::Full));
        assert_eq!(store.append(b"1234"), Ok(6), "a smaller frame still fits");
        assert!(store.remove());
        assert!(matches!(store.append(b"1"), Err(NotKept::Failed(_))));
        assert!(store.reader().is_err());
        assert!(!store.remove(), "removing twice removes nothing");
    }
}
