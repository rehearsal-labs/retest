//! `retest-media`: Retest's media process.
//!
//! A client starts it, reads its greeting, and streams captured frames to it over standard input; each
//! recording becomes a video written by an ffmpeg the host provides. It also makes thumbnails, returns a
//! recording's kept frames for an interval, and sends a live view of a recording's newest frame. The protocol is in
//! `protocol.rs`.

#[cfg(not(unix))]
compile_error!("retest-media runs on Unix: it verifies each encoder process before stopping it");

#[cfg(feature = "allocation-counts")]
mod allocations;
mod encoder;
mod frame;
mod jobs;
mod ledger;
mod live;
mod place;
mod process_ownership;
mod protocol;
mod queue;
mod recording;
mod replies;
mod server;
mod store;
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
        Ok(Command::Finalize(partial, path)) => {
            let result = place::finalize_file(&partial, &path);
            return match serde_json::to_writer(io::stdout().lock(), &result) {
                Ok(()) => ExitCode::SUCCESS,
                Err(_) => ExitCode::from(2),
            };
        }
        Ok(Command::Version) => {
            println!("{}", version_line());
            return ExitCode::SUCCESS;
        }
        Err(message) => {
            eprintln!("retest-media: {message}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let replies = match replies::stdout_pipe().and_then(|output| Replies::new(Box::new(output))) {
        Ok(replies) => replies,
        Err(error) => {
            eprintln!("retest-media: the reply writer could not start: {error}");
            return ExitCode::from(2);
        }
    };
    let input = BufReader::with_capacity(256 * 1024, io::stdin());
    let outcome = server::serve(input, replies.clone(), &config);
    let delivery = replies.close();
    if delivery.replies_dropped > 0 || delivery.writer_blocked || delivery.in_flight_unknown > 0 {
        eprintln!(
            "{}",
            serde_json::json!({
                "schemaVersion": 1, "type": "mediaReplyFailure",
                "reason": if delivery.writer_blocked { "stdout_blocked" } else { "replies_dropped" },
                "repliesDropped": delivery.replies_dropped,
                "inFlightUnknown": delivery.in_flight_unknown,
            })
        );
        return ExitCode::from(2);
    }
    #[cfg(feature = "allocation-counts")]
    if let Err(error) = allocations::report() {
        eprintln!("retest-media: allocation counts could not be written: {error}");
        return ExitCode::from(2);
    }
    ExitCode::from(outcome.exit_code())
}

// `retest-media 0.1.0 (protocol 2, aarch64-apple-darwin, release, revision 1a2b3c4 with local changes)`.
fn version_line() -> String {
    let build = server::build_identity();
    let revision = match (&build.revision, build.dirty) {
        (Some(revision), Some(true)) => format!(", revision {revision} with local changes"),
        (Some(revision), _) => format!(", revision {revision}"),
        (None, _) => String::new(),
    };
    format!(
        "retest-media {} (protocol {}, {}, {}{revision})",
        env!("CARGO_PKG_VERSION"),
        protocol::PROTOCOL_VERSION,
        build.target,
        build.profile
    )
}

enum Command {
    Serve(Config),
    Version,
    /// Internal worker, launched only by the recording supervisor with an empty environment.
    Finalize(PathBuf, PathBuf),
}

fn parse_arguments(mut arguments: impl Iterator<Item = OsString>) -> Result<Command, String> {
    let mut ffmpeg = PathBuf::from("ffmpeg");
    while let Some(argument) = arguments.next() {
        match argument.to_str() {
            Some("--ffmpeg") => {
                ffmpeg = arguments
                    .next()
                    .map(PathBuf::from)
                    .ok_or("--ffmpeg needs a path")?;
                // The path is named in replies, which stay under the header limit.
                if ffmpeg.as_os_str().len() > protocol::MAX_PATH_BYTES {
                    return Err(format!(
                        "--ffmpeg takes a path of at most {} bytes",
                        protocol::MAX_PATH_BYTES
                    ));
                }
            }
            Some("--finalize-file") => {
                let partial = arguments
                    .next()
                    .map(PathBuf::from)
                    .ok_or("finalization needs its partial")?;
                let path = arguments
                    .next()
                    .map(PathBuf::from)
                    .ok_or("finalization needs its path")?;
                if arguments.next().is_some() {
                    return Err("finalization takes only its two paths".to_owned());
                }
                return Ok(Command::Finalize(partial, path));
            }
            Some("--version") => return Ok(Command::Version),
            _ => return Err(format!("unknown argument {}", argument.to_string_lossy())),
        }
    }
    Ok(Command::Serve(Config { ffmpeg }))
}
