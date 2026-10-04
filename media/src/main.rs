//! `retest-media`: Retest's media process.
//!
//! A client starts it, reads its greeting, and streams captured frames to it over standard input; each
//! recording becomes a video written by an ffmpeg the host provides. The protocol is in `protocol.rs`.

#[cfg(not(unix))]
compile_error!("retest-media runs on Unix: it verifies each encoder process before stopping it");

mod encoder;
mod frame;
mod process_ownership;
mod protocol;
mod queue;
mod recording;
mod replies;
mod server;
mod timeline;

use std::ffi::OsString;
use std::io::{self, BufReader};
use std::path::PathBuf;
use std::process::ExitCode;

use crate::replies::Replies;
use crate::server::Config;

const USAGE: &str = "usage: retest-media [--ffmpeg <path>]\n       retest-media --version\n\nSpeaks Retest's media protocol on standard input and output.";

fn main() -> ExitCode {
    let config = match parse_arguments(std::env::args_os().skip(1)) {
        Ok(Command::Serve(config)) => config,
        Ok(Command::Version) => {
            println!(
                "retest-media {} (protocol {})",
                env!("CARGO_PKG_VERSION"),
                protocol::PROTOCOL_VERSION
            );
            return ExitCode::SUCCESS;
        }
        Err(message) => {
            eprintln!("retest-media: {message}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let input = BufReader::with_capacity(256 * 1024, io::stdin());
    let outcome = server::serve(input, Replies::new(Box::new(io::stdout())), &config);
    ExitCode::from(outcome.exit_code())
}

enum Command {
    Serve(Config),
    Version,
}

fn parse_arguments(mut arguments: impl Iterator<Item = OsString>) -> Result<Command, String> {
    let mut ffmpeg = PathBuf::from("ffmpeg");
    while let Some(argument) = arguments.next() {
        match argument.to_str() {
            Some("--ffmpeg") => {
                ffmpeg = arguments
                    .next()
                    .map(PathBuf::from)
                    .ok_or("--ffmpeg needs a path")?
            }
            Some("--version") => return Ok(Command::Version),
            _ => return Err(format!("unknown argument {}", argument.to_string_lossy())),
        }
    }
    Ok(Command::Serve(Config { ffmpeg }))
}
