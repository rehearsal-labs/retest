//! Ctrl+C typed in the console the media process shares with its runner, on Windows.
//!
//! A test binary of its own: it gives itself a console of its own and sends Ctrl+C to every process attached to it,
//! which no other test should hear. On an interactive desktop the console opens a window while the test runs.

#![cfg(windows)]

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;
use windows_sys::Win32::System::Console::{
    AllocConsole, CTRL_C_EVENT, FreeConsole, GenerateConsoleCtrlEvent, SetConsoleCtrlHandler,
};

// Keeps this test process alive through the Ctrl+C it sends. A handler routine, unlike the ignore flag, is not
// inherited, so the media process starts with the console's default behaviour.
unsafe extern "system" fn handled(_: u32) -> i32 {
    1
}

fn envelope(header: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&(header.len() as u32).to_be_bytes());
    bytes.extend_from_slice(&0u32.to_be_bytes());
    bytes.extend_from_slice(header);
    bytes
}

fn reply(stdout: &mut impl Read) -> Value {
    let mut prefix = [0u8; 8];
    stdout.read_exact(&mut prefix).expect("a reply prefix");
    let header_length = u32::from_be_bytes([prefix[0], prefix[1], prefix[2], prefix[3]]) as usize;
    let payload_length = u32::from_be_bytes([prefix[4], prefix[5], prefix[6], prefix[7]]) as usize;
    let mut header = vec![0u8; header_length];
    stdout.read_exact(&mut header).expect("a reply header");
    let mut payload = vec![0u8; payload_length];
    stdout.read_exact(&mut payload).expect("a reply payload");
    serde_json::from_slice(&header).expect("a reply is JSON")
}

#[test]
fn ctrl_c_in_the_shared_console_leaves_the_media_process_to_its_client() {
    // SAFETY: these change only this process's console and its own Ctrl+C handling.
    unsafe {
        FreeConsole();
        assert_ne!(AllocConsole(), 0, "a console of this test's own");
        // A process started in a new process group, as a remote shell or a CI runner may start this one, inherits
        // Ctrl+C turned off, and would pass it on to the media process; it is turned on again, as in a console a
        // person types in.
        assert_ne!(SetConsoleCtrlHandler(None, 0), 0, "Ctrl+C is turned on");
        assert_ne!(
            SetConsoleCtrlHandler(Some(handled), 1),
            0,
            "this test survives its Ctrl+C"
        );
    }
    let missing = std::env::temp_dir().join("retest-media-console-no-ffmpeg.exe");
    let mut media = Command::new(env!("CARGO_BIN_EXE_retest-media"))
        .arg("--ffmpeg")
        .arg(&missing)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("the media process starts in this console");
    let mut stdout = media.stdout.take().expect("stdout is piped");
    assert_eq!(reply(&mut stdout)["type"], "hello");
    // SAFETY: group 0 is every process attached to this console: this test, whose handler keeps it, and the media process.
    let sent = unsafe { GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0) };
    assert_ne!(sent, 0, "Ctrl+C was sent to the console");
    thread::sleep(Duration::from_millis(500));
    assert!(
        media.try_wait().expect("its state reads").is_none(),
        "the media process ended at Ctrl+C"
    );
    let stdin = media.stdin.as_mut().expect("stdin is piped");
    stdin
        .write_all(&envelope(br#"{"type":"shutdown"}"#))
        .expect("the process reads its input");
    stdin.flush().expect("flushes");
    assert_eq!(reply(&mut stdout)["type"], "bye");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = media.try_wait().expect("its state reads") {
            assert!(status.success(), "{status:?}");
            break;
        }
        assert!(Instant::now() < deadline, "the media process did not exit");
        thread::sleep(Duration::from_millis(10));
    }
}
