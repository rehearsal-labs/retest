//! `retest-supervisor`: how Retest keeps its promise on Windows that nothing it starts outlives a run.
//!
//! Windows has no process groups to signal and no `ps` to read, so Retest holds what it starts in job objects, which
//! only Win32 can make. Each invocation does one thing and prints one JSON line on standard output: `hold` puts the
//! runner in a job that ends every process in it once the runner's handle closes, as it does when the runner ends,
//! however it ends; `adopt` puts one launched child, and anything it already started, in a job of its own; `members`,
//! `process`, `end`, `terminate` and `release` read and end those jobs; `strays` names what the runner's job holds that no
//! launch's job does; `interrupt` sends Ctrl+C or Ctrl+Break to a launch's console. The runner holds every job's handle itself, so no
//! supervisor process needs to stay alive. The command line is in `command.rs` and the replies in `reply.rs`.
//!
//! On macOS and Linux the program builds and refuses to run: Retest holds its processes in process groups there.

#[cfg_attr(not(windows), allow(dead_code))]
mod command;
#[cfg(windows)]
mod jobs;
#[cfg_attr(not(windows), allow(dead_code))]
mod reply;

use std::process::ExitCode;

#[cfg(windows)]
const USAGE: &str = "usage: retest-supervisor hold --runner <pid> --job <name>\n       retest-supervisor adopt --runner <pid> --within <name> --job <name> --pid <pid>\n       retest-supervisor members --job <name>\n       retest-supervisor process --pid <pid> [--job <name>]\n       retest-supervisor end --runner <pid> --job <name>\n       retest-supervisor terminate --runner <pid> --job <name> --pid <pid> --started <ticks>\n       retest-supervisor release --runner <pid> --job <name> --handle <value>\n       retest-supervisor strays --runner <pid> --job <name> [--launches <name>,<name>...]\n       retest-supervisor interrupt --runner <pid> --job <name> [--pid <pid>] [--key c|break]\n       retest-supervisor --version";

#[cfg(not(windows))]
fn main() -> ExitCode {
    eprintln!(
        "retest-supervisor runs on Windows only; on macOS and Linux Retest holds its processes in process groups."
    );
    ExitCode::from(2)
}

#[cfg(windows)]
fn main() -> ExitCode {
    use std::io::Write;

    let command = match command::parse(std::env::args_os().skip(1)) {
        Ok(command) => command,
        Err(message) => {
            eprintln!("retest-supervisor: {message}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let line = match command {
        command::Command::Version => format!("{}\n", version_line()),
        other => jobs::answer(other).line(),
    };
    let mut output = std::io::stdout().lock();
    // A reply that could not be written in full is no answer; the reader sees the exit status, not half a line.
    match output
        .write_all(line.as_bytes())
        .and_then(|()| output.flush())
    {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => ExitCode::from(2),
    }
}

// `retest-supervisor 0.1.0 (x86_64-pc-windows-msvc, release, revision 1a2b3c4)`.
#[cfg(windows)]
fn version_line() -> String {
    let revision = option_env!("RETEST_SUPERVISOR_REVISION")
        .map(|revision| format!(", revision {revision}"))
        .unwrap_or_default();
    format!(
        "retest-supervisor {} ({}, {}{revision})",
        env!("CARGO_PKG_VERSION"),
        env!("RETEST_SUPERVISOR_TARGET"),
        env!("RETEST_SUPERVISOR_PROFILE")
    )
}
