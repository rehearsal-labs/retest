//! Counts the process's heap allocations, for measuring one route against another. Built only with the
//! `allocation-counts` feature, which the shipped binary leaves out; the counts go to standard error at exit,
//! the stream a client keeps for the process's own diagnostics, and never into a reply. An explicit
//! `RETEST_MEDIA_ALLOCATION_LOG` writes that line to a new file instead, only in this measuring build.

use std::alloc::{GlobalAlloc, Layout, System};
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::sync::atomic::{AtomicU64, Ordering};

struct Counting;

static ALLOCATIONS: AtomicU64 = AtomicU64::new(0);
static ALLOCATED_BYTES: AtomicU64 = AtomicU64::new(0);
static LIVE_BYTES: AtomicU64 = AtomicU64::new(0);
static PEAK_LIVE_BYTES: AtomicU64 = AtomicU64::new(0);

// SAFETY: every call is passed to the system allocator unchanged; the counters only observe sizes.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: the caller's layout contract is the system allocator's.
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            note_allocation(layout.size());
        }
        pointer
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        // SAFETY: `pointer` came from `alloc` or `realloc` with this layout.
        unsafe { System.dealloc(pointer, layout) };
        LIVE_BYTES.fetch_sub(layout.size() as u64, Ordering::Relaxed);
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // SAFETY: the caller's contract for `realloc` is the system allocator's.
        let moved = unsafe { System.realloc(pointer, layout, new_size) };
        if !moved.is_null() {
            LIVE_BYTES.fetch_sub(layout.size() as u64, Ordering::Relaxed);
            note_allocation(new_size);
        }
        moved
    }
}

fn note_allocation(size: usize) {
    ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
    ALLOCATED_BYTES.fetch_add(size as u64, Ordering::Relaxed);
    let live = LIVE_BYTES.fetch_add(size as u64, Ordering::Relaxed) + size as u64;
    PEAK_LIVE_BYTES.fetch_max(live, Ordering::Relaxed);
}

#[global_allocator]
static COUNTING: Counting = Counting;

/// Writes the counts to standard error, as one line a measuring script reads.
pub fn report() -> io::Result<()> {
    let line = format!(
        "retest-media allocations: {} allocations, {} bytes allocated, {} bytes live at peak",
        ALLOCATIONS.load(Ordering::Relaxed),
        ALLOCATED_BYTES.load(Ordering::Relaxed),
        PEAK_LIVE_BYTES.load(Ordering::Relaxed)
    );
    if let Some(path) = std::env::var_os("RETEST_MEDIA_ALLOCATION_LOG") {
        let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
        writeln!(file, "{line}")?;
    } else {
        eprintln!("{line}");
    }
    Ok(())
}
