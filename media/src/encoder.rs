//! The encoder: an ffmpeg the host provides, run as a child process the way Playwright runs it.
//!
//! The process asks the encoder once what it can do, then picks H.264 in MP4 when libx264 is there and VP8 in
//! WebM otherwise. Each recording runs its own encoder, reading frames on standard input: raw RGB on the decoded
//! route, which needs ffmpeg's `rawvideo` demuxer, or the images as they came on the encoded route, which needs its
//! `image2pipe` demuxer and the image's decoder. Either needs the container's muxer; a minimal ffmpeg build can lack
//! any of them.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::io::{self, Read};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::process_ownership::Ownership;
use crate::protocol::{EncoderExit, FrameFormat};

/// How many of the encoder's last lines a failure carries, and how long each may be.
const TAIL_LINES: usize = 20;
const TAIL_LINE_CHARACTERS: usize = 300;
// A line is kept to this many bytes as it is read, enough for `TAIL_LINE_CHARACTERS` of any UTF-8 text.
const LINE_BYTES: usize = TAIL_LINE_CHARACTERS * 4;
/// How long the encoder may take to answer each question about what it can do. The three questions are asked at
/// once, so the whole probe ends within this plus `READER_GRACE` and the time cleanup takes to confirm.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// How much of a listing is kept. ffmpeg's encoder list is about 25 kB; the rest of a longer one is read and
/// thrown away, so the encoder never blocks on a full pipe.
const LISTING_BYTES: usize = 1024 * 1024;
/// How long an encoder or its output reader gets to finish after cleanup.
pub const READER_GRACE: Duration = Duration::from_secs(2);

/// What the encoder can do, as it told us.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Capabilities {
    /// The encoder's first version line, such as `ffmpeg version 9.0.2`.
    pub version: String,
    pub libx264: bool,
    pub libvpx: bool,
    /// Whether it reads raw frames: the `rawvideo` demuxer.
    pub reads_raw_video: bool,
    pub writes_mp4: bool,
    pub writes_webm: bool,
    /// Whether it reads images one after another from a pipe: the `image2pipe` demuxer.
    pub reads_image_pipe: bool,
    pub decodes_png: bool,
    pub decodes_jpeg: bool,
}

impl Capabilities {
    /// The image formats the encoded route can hand it undecoded.
    pub fn encoded_input(&self) -> Vec<FrameFormat> {
        let mut formats = Vec::new();
        if self.reads_image_pipe && self.decodes_png {
            formats.push(FrameFormat::Png);
        }
        if self.reads_image_pipe && self.decodes_jpeg {
            formats.push(FrameFormat::Jpeg);
        }
        formats
    }

    /// Why no route is complete, for an `encoder_unavailable` message.
    pub fn missing(&self) -> String {
        let mut missing = Vec::new();
        if !self.reads_raw_video {
            missing.push("the rawvideo demuxer");
        }
        if !(self.libx264 && self.writes_mp4) && !(self.libvpx && self.writes_webm) {
            missing.push("H.264 (libx264 and the mp4 muxer) or VP8 (libvpx and the webm muxer)");
        }
        missing.join(", and ")
    }
}

/// Why the encoder could not be used, with how it exited when it ran.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncoderFailure {
    pub message: String,
    pub exit: Option<EncoderExit>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Codec {
    H264,
    Vp8,
}

impl Codec {
    /// H.264 when the encoder can write it, then VP8, or none. Either needs raw frames read in.
    pub fn choose(capabilities: &Capabilities) -> Option<Codec> {
        if !capabilities.reads_raw_video {
            None
        } else if capabilities.libx264 && capabilities.writes_mp4 {
            Some(Codec::H264)
        } else if capabilities.libvpx && capabilities.writes_webm {
            Some(Codec::Vp8)
        } else {
            None
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Codec::H264 => "h264",
            Codec::Vp8 => "vp8",
        }
    }

    pub fn container(self) -> &'static str {
        match self {
            Codec::H264 => "mp4",
            Codec::Vp8 => "webm",
        }
    }

    pub fn encoder(self) -> &'static str {
        match self {
            Codec::H264 => "libx264",
            Codec::Vp8 => "libvpx",
        }
    }

    // The VP8 settings are Playwright's. H.264 uses x264's veryfast preset at its default quality, with 4:2:0
    // chroma so every browser and player can show it.
    fn codec_arguments(self) -> &'static [&'static str] {
        match self {
            Codec::H264 => &[
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
                "-f", "mp4",
            ],
            Codec::Vp8 => &[
                "-c:v",
                "libvpx",
                "-qmin",
                "0",
                "-qmax",
                "50",
                "-crf",
                "8",
                "-deadline",
                "realtime",
                "-speed",
                "8",
                "-b:v",
                "1M",
                "-threads",
                "1",
                "-pix_fmt",
                "yuv420p",
                "-f",
                "webm",
            ],
        }
    }
}

/// What a recording's encoder reads on standard input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Input {
    /// Raw RGB frames of the recording's size.
    Raw,
    /// Images of one format, one after another, each read as one frame.
    Images(FrameFormat),
}

/// The encoder's arguments for one recording: frames of `width` by `height` at `fps` on standard input, the video
/// to `output`. Images are timed by their order at `fps`, and the output keeps a constant rate, so an image the
/// decoder cannot read leaves the frame before it on screen rather than moving every later frame earlier.
pub fn encode_arguments(
    codec: Codec,
    input: Input,
    width: u32,
    height: u32,
    fps: u32,
    output: &Path,
) -> Vec<OsString> {
    let size = format!("{width}x{height}");
    let rate = fps.to_string();
    let mut arguments: Vec<OsString> = ["-hide_banner", "-loglevel", "error", "-nostats"]
        .iter()
        .map(OsString::from)
        .collect();
    let reading: Vec<&str> = match input {
        Input::Raw => vec!["-f", "rawvideo", "-pix_fmt", "rgb24", "-video_size", &size],
        Input::Images(FrameFormat::Png) => vec!["-f", "image2pipe", "-c:v", "png"],
        Input::Images(FrameFormat::Jpeg) => vec!["-f", "image2pipe", "-c:v", "mjpeg"],
    };
    arguments.extend(reading.into_iter().map(OsString::from));
    arguments.extend(
        ["-framerate", &rate, "-i", "pipe:0", "-an"]
            .iter()
            .map(OsString::from),
    );
    if let Input::Images(_) = input {
        arguments.extend(["-fps_mode", "cfr"].iter().map(OsString::from));
    }
    arguments.extend(codec.codec_arguments().iter().map(OsString::from));
    // Never overwrite: the server checked nothing is there, and a file that appears since is not ours to replace.
    arguments.push(OsString::from("-n"));
    arguments.push(output.as_os_str().to_owned());
    arguments
}

/// Starts the encoder in its own process group. Ownership is recorded separately before any cleanup signal.
pub fn spawn_in_group(
    ffmpeg: &Path,
    arguments: &[OsString],
    stdin: Stdio,
    stdout: Stdio,
) -> io::Result<Child> {
    // Some launch implementations return a child exiting 127 for an absent explicit path. Refuse a path already
    // known absent before dispatch, so it cannot acquire a made-up encoder exit. Spawn still decides races.
    if ffmpeg.components().count() > 1 {
        std::fs::metadata(ffmpeg)?;
    }
    Command::new(ffmpeg)
        .env_clear()
        .envs(
            ["PATH", "TMPDIR"]
                .into_iter()
                .filter_map(|name| std::env::var_os(name).map(|value| (name, value))),
        )
        .env("LC_ALL", "C")
        .args(arguments)
        .process_group(0)
        .stdin(stdin)
        .stdout(stdout)
        .stderr(Stdio::piped())
        .spawn()
}

/// Waits up to `limit` for a thread to finish, and joins it if it did. A thread still running is left to end
/// on its own, which a reader does once the last process holding its pipe is gone.
pub fn join_within<T>(thread: JoinHandle<T>, limit: Duration) -> Option<T> {
    let start = Instant::now();
    while !thread.is_finished() {
        if start.elapsed() >= limit {
            return None;
        }
        thread::sleep(Duration::from_millis(5));
    }
    thread.join().ok()
}

/// Asks the encoder for its encoders, which also prints its version, its formats and its decoders, all three at
/// once. Its standard input is empty, so a program that is not ffmpeg cannot wait for input, and one that never
/// answers is stopped after `PROBE_TIMEOUT`.
pub fn probe(ffmpeg: &Path) -> Result<Capabilities, EncoderFailure> {
    let ask = |arguments: &'static [&'static str], asked: &'static str| {
        let ffmpeg = ffmpeg.to_path_buf();
        thread::Builder::new()
            .name("probe listing".to_owned())
            .spawn(move || listing(&ffmpeg, arguments, asked))
    };
    let spawned = [
        ask(&["-encoders"], "its encoders"),
        ask(&["-hide_banner", "-formats"], "its formats"),
        ask(&["-hide_banner", "-decoders"], "its decoders"),
    ];
    // Every listing that started is joined before any answer is used, so none is left running.
    let answers: Vec<Result<Listing, EncoderFailure>> = spawned
        .into_iter()
        .map(|thread| match thread {
            Ok(thread) => thread.join().unwrap_or_else(|_| {
                Err(EncoderFailure {
                    message: "asking the encoder failed inside the media process".to_owned(),
                    exit: None,
                })
            }),
            Err(error) => Err(EncoderFailure {
                message: format!("the encoder could not be asked what it can do: {error}"),
                exit: None,
            }),
        })
        .collect();
    let mut answers = answers.into_iter();
    let (Some(encoders), Some(formats), Some(decoders)) =
        (answers.next(), answers.next(), answers.next())
    else {
        return Err(EncoderFailure {
            message: "the encoder could not be asked what it can do".to_owned(),
            exit: None,
        });
    };
    let encoders = encoders?;
    let version = encoders
        .stderr
        .lines()
        .find(|line| line.starts_with("ffmpeg version"))
        .map(version_line);
    let Some(version) = version else {
        let message = format!(
            "{} did not answer as ffmpeg: it printed no ffmpeg version",
            ffmpeg.display()
        );
        return Err(EncoderFailure {
            message,
            exit: Some(encoders.exit),
        });
    };
    let formats = formats?;
    // Decoders matter only for the encoded route; a build that cannot list them still records decoded.
    let decoders = decoders.map(|listing| listing.stdout).unwrap_or_default();
    Ok(Capabilities {
        version,
        libx264: lists_encoder(&encoders.stdout, "libx264"),
        libvpx: lists_encoder(&encoders.stdout, "libvpx"),
        reads_raw_video: lists_format(&formats.stdout, "rawvideo").demuxes,
        writes_mp4: lists_format(&formats.stdout, "mp4").muxes,
        writes_webm: lists_format(&formats.stdout, "webm").muxes,
        reads_image_pipe: lists_format(&formats.stdout, "image2pipe").demuxes,
        decodes_png: lists_encoder(&decoders, "png"),
        decodes_jpeg: lists_encoder(&decoders, "mjpeg"),
    })
}

struct Listing {
    stdout: String,
    stderr: String,
    exit: EncoderExit,
}

// Runs the encoder with `arguments` and reads what it prints. Anything but a clean exit is a failure that says
// what was asked: `asked` names it, such as "its encoders".
fn listing(ffmpeg: &Path, arguments: &[&str], asked: &str) -> Result<Listing, EncoderFailure> {
    let arguments: Vec<OsString> = arguments.iter().map(OsString::from).collect();
    let mut child =
        spawn_in_group(ffmpeg, &arguments, Stdio::null(), Stdio::piped()).map_err(|error| {
            EncoderFailure {
                message: format!("{} could not be started: {error}", ffmpeg.display()),
                exit: None,
            }
        })?;
    let mut ownership = Ownership::new(child.id());
    let mut problems = ownership.capture();
    let stdout = child.stdout.take().map(read_bounded);
    let stderr = child.stderr.take().map(read_bounded);
    let status = wait_until(
        &mut child,
        &mut ownership,
        Instant::now() + PROBE_TIMEOUT,
        &mut problems,
    );
    problems.extend(ownership.cleanup(&mut child, READER_GRACE));
    let stdout = read_listing(stdout, "standard output", &mut problems);
    let stderr = read_listing(stderr, "standard error", &mut problems);
    let exit = EncoderExit {
        exit_code: status.and_then(|status| status.code()),
        signal: status.and_then(signal_of),
        stderr: last_lines(&stderr),
        lines: stderr
            .lines()
            .filter(|line| !line.trim().is_empty())
            .count() as u64,
    };
    if !problems.is_empty() {
        return Err(EncoderFailure {
            message: format!(
                "{} could not safely answer for {asked}: cleanup or output was unknown: {}",
                ffmpeg.display(),
                problems.join("; ")
            ),
            exit: Some(exit),
        });
    }
    match status {
        Some(status) if status.success() => Ok(Listing {
            stdout,
            stderr,
            exit,
        }),
        Some(status) => Err(EncoderFailure {
            message: format!(
                "{} did not answer as ffmpeg: asking for {asked} ended with {}",
                ffmpeg.display(),
                describe_status(status)
            ),
            exit: Some(exit),
        }),
        None => Err(EncoderFailure {
            message: format!(
                "{} did not list {asked} within {} s",
                ffmpeg.display(),
                PROBE_TIMEOUT.as_secs()
            ),
            exit: Some(exit),
        }),
    }
}

// `ffmpeg version 9.0.2 Copyright (c) ...` becomes `ffmpeg version 9.0.2`.
fn version_line(line: &str) -> String {
    line.split_whitespace()
        .take(3)
        .collect::<Vec<_>>()
        .join(" ")
}

/// Whether ffmpeg's encoder or decoder list names the video codec `encoder`. Each entry is a line of capability
/// flags, the name, then a description, such as ` V....D libx264  libx264 H.264 / AVC`.
pub fn lists_encoder(listing: &str, encoder: &str) -> bool {
    listing.lines().any(|line| {
        let mut words = line.split_whitespace();
        let flags = words.next().unwrap_or_default();
        flags.len() == 6 && flags.starts_with('V') && words.next() == Some(encoder)
    })
}

/// Whether a format can be read and written, as ffmpeg's format list says.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct FormatSupport {
    pub demuxes: bool,
    pub muxes: bool,
}

/// Reads ffmpeg's format list for `format`. Each entry is a space, three flag columns (`D` demuxing, `E` muxing,
/// `d` a device), then names joined by commas, such as ` DE  rawvideo  raw video` or ` D   matroska,webm`.
pub fn lists_format(listing: &str, format: &str) -> FormatSupport {
    let mut support = FormatSupport::default();
    for line in listing.lines() {
        let (Some(flags), Some(rest)) = (line.get(1..4), line.get(4..)) else {
            continue;
        };
        if !line.starts_with(' ') || !flags.chars().all(|flag| " .DEd".contains(flag)) {
            continue;
        }
        let names = rest.split_whitespace().next().unwrap_or_default();
        if names.split(',').any(|name| name == format) {
            support.demuxes |= flags.starts_with('D');
            support.muxes |= flags.get(1..2) == Some("E");
        }
    }
    support
}

// Reads a stream to its end, keeping its first `LISTING_BYTES`; a failed reading is never a complete answer.
fn read_bounded(mut stream: impl Read + Send + 'static) -> JoinHandle<Result<String, String>> {
    thread::spawn(move || {
        let mut kept = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => {
                    let room = LISTING_BYTES - kept.len();
                    kept.extend_from_slice(&chunk[..read.min(room)]);
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => return Err("the encoder output could not be read to its end".to_owned()),
            }
        }
        Ok(String::from_utf8_lossy(&kept).into_owned())
    })
}

fn read_listing(
    reader: Option<JoinHandle<Result<String, String>>>,
    stream: &str,
    problems: &mut Vec<String>,
) -> String {
    match reader.and_then(|reader| join_within(reader, READER_GRACE)) {
        Some(Ok(text)) => text,
        Some(Err(error)) => {
            problems.push(error);
            String::new()
        }
        None => {
            problems.push(format!(
                "the encoder's {stream} did not close; completion is unknown"
            ));
            String::new()
        }
    }
}

/// Waits until the deadline, then stops only recorded processes and gives them a bounded exit grace.
pub fn wait_until(
    child: &mut Child,
    ownership: &mut Ownership,
    deadline: Instant,
    problems: &mut Vec<String>,
) -> Option<ExitStatus> {
    let mut stop_deadline = None;
    let mut captured = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Err(_) => {
                problems.push("the encoder exit could not be read".to_owned());
                return None;
            }
            Ok(None) => {}
        }
        if captured.elapsed() >= Duration::from_millis(100) {
            problems.extend(ownership.capture());
            captured = Instant::now();
        }
        if let Some(stop_deadline) = stop_deadline {
            if Instant::now() >= stop_deadline {
                problems.push("the encoder did not confirm an exit after cleanup".to_owned());
                return None;
            }
        } else if Instant::now() >= deadline {
            problems.extend(ownership.stop(child));
            stop_deadline = Some(Instant::now() + READER_GRACE);
        }
        thread::sleep(Duration::from_millis(5));
    }
}

#[cfg(unix)]
pub fn signal_of(status: ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
pub fn signal_of(_status: ExitStatus) -> Option<i32> {
    None
}

pub fn describe_status(status: ExitStatus) -> String {
    match (status.code(), signal_of(status)) {
        (Some(code), _) => format!("exit code {code}"),
        (None, Some(signal)) => format!("signal {signal}"),
        (None, None) => "an unknown status".to_owned(),
    }
}

fn last_lines(text: &str) -> Vec<String> {
    let mut tail = VecDeque::with_capacity(TAIL_LINES);
    for line in text
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty())
    {
        if tail.len() == TAIL_LINES {
            tail.pop_front();
        }
        tail.push_back(clip(line));
    }
    tail.into_iter().collect()
}

fn clip(line: &str) -> String {
    line.chars().take(TAIL_LINE_CHARACTERS).collect()
}

/// The last lines an encoder printed, kept while it runs, and how many it printed in all.
#[derive(Debug, Clone, Default)]
pub struct StderrTail {
    lines: Arc<Mutex<VecDeque<String>>>,
    printed: Arc<std::sync::atomic::AtomicU64>,
}

impl StderrTail {
    /// Reads `stream` until it ends, keeping its last lines. A line longer than the clip is cut as it arrives,
    /// so a stream with no line breaks costs no more memory than one line.
    pub fn follow(&self, mut stream: impl Read + Send + 'static) -> JoinHandle<Result<(), String>> {
        let lines = Arc::clone(&self.lines);
        let printed = Arc::clone(&self.printed);
        thread::spawn(move || {
            let keep = |line: &[u8]| {
                let text = String::from_utf8_lossy(line);
                let text = text.trim_end();
                if text.is_empty() {
                    return;
                }
                printed.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let mut lines = lines
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if lines.len() == TAIL_LINES {
                    lines.pop_front();
                }
                lines.push_back(clip(text));
            };
            let mut line = Vec::with_capacity(LINE_BYTES);
            let mut chunk = [0u8; 8192];
            loop {
                let read = match stream.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(read) => read,
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(_) => {
                        return Err("the encoder stderr could not be read to its end".to_owned());
                    }
                };
                for &byte in &chunk[..read] {
                    if byte == b'\n' || byte == b'\r' {
                        keep(&line);
                        line.clear();
                    } else if line.len() < LINE_BYTES {
                        line.push(byte);
                    }
                }
            }
            keep(&line);
            Ok(())
        })
    }

    pub fn lines(&self) -> Vec<String> {
        self.lines
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .cloned()
            .collect()
    }

    /// How many lines the encoder printed, kept or not.
    pub fn printed(&self) -> u64 {
        self.printed.load(std::sync::atomic::Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LISTING: &str = "Encoders:\n V..... = Video\n ------\n V....D libx264              libx264 H.264\n V....D libx264rgb           libx264 H.264 RGB\n A....D aac                  AAC\n";

    #[test]
    fn the_listing_is_read_by_encoder_name() {
        assert!(lists_encoder(LISTING, "libx264"));
        assert!(!lists_encoder(LISTING, "libvpx"));
        assert!(
            !lists_encoder(LISTING, "aac"),
            "an audio encoder is not a video encoder"
        );
        assert!(!lists_encoder("libx264 is mentioned in prose", "libx264"));
    }

    const FORMATS: &str = "Formats:\n D.. = Demuxing supported\n .E. = Muxing supported\n ---\n D   matroska,webm   Matroska / WebM\n  E  mp4             MP4\n DE  rawvideo        raw video\n  E  webm            WebM\n";

    fn everything() -> Capabilities {
        Capabilities {
            version: String::new(),
            libx264: true,
            libvpx: true,
            reads_raw_video: true,
            writes_mp4: true,
            writes_webm: true,
            reads_image_pipe: true,
            decodes_png: true,
            decodes_jpeg: true,
        }
    }

    #[test]
    fn h264_is_chosen_before_vp8() {
        let vp8 = Capabilities {
            libx264: false,
            ..everything()
        };
        let neither = Capabilities {
            libvpx: false,
            ..vp8.clone()
        };
        assert_eq!(Codec::choose(&everything()), Some(Codec::H264));
        assert_eq!(Codec::choose(&vp8), Some(Codec::Vp8));
        assert_eq!(Codec::choose(&neither), None);
    }

    #[test]
    fn a_codec_without_its_muxer_or_raw_input_is_no_route() {
        let no_mp4 = Capabilities {
            writes_mp4: false,
            ..everything()
        };
        assert_eq!(Codec::choose(&no_mp4), Some(Codec::Vp8));
        let no_raw = Capabilities {
            reads_raw_video: false,
            ..everything()
        };
        assert_eq!(Codec::choose(&no_raw), None);
        assert_eq!(no_raw.missing(), "the rawvideo demuxer");
        let no_muxers = Capabilities {
            writes_mp4: false,
            writes_webm: false,
            ..everything()
        };
        assert!(
            no_muxers
                .missing()
                .starts_with("H.264 (libx264 and the mp4 muxer)")
        );
    }

    #[test]
    fn the_format_list_is_read_by_flag_column() {
        assert_eq!(
            lists_format(FORMATS, "rawvideo"),
            FormatSupport {
                demuxes: true,
                muxes: true
            }
        );
        assert_eq!(
            lists_format(FORMATS, "mp4"),
            FormatSupport {
                demuxes: false,
                muxes: true
            }
        );
        assert_eq!(
            lists_format(FORMATS, "webm"),
            FormatSupport {
                demuxes: true,
                muxes: true
            },
            "demuxed as matroska,webm"
        );
        assert_eq!(
            lists_format(FORMATS, "image2pipe"),
            FormatSupport::default()
        );
        assert_eq!(
            lists_format(" D.. = Demuxing supported", "Demuxing"),
            FormatSupport::default(),
            "the legend is not a format"
        );
    }

    fn joined(arguments: &[OsString]) -> String {
        arguments
            .iter()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ")
    }

    #[test]
    fn the_arguments_read_raw_frames_and_name_the_container() {
        let raw = joined(&encode_arguments(
            Codec::H264,
            Input::Raw,
            800,
            600,
            30,
            Path::new("/tmp/out.mp4.partial"),
        ));
        assert!(
            raw.contains("-f rawvideo -pix_fmt rgb24 -video_size 800x600 -framerate 30 -i pipe:0")
        );
        assert!(raw.contains("-c:v libx264"));
        assert!(!raw.contains("-fps_mode"));
        assert!(raw.ends_with("-f mp4 -n /tmp/out.mp4.partial"));
        let jpeg = joined(&encode_arguments(
            Codec::Vp8,
            Input::Images(FrameFormat::Jpeg),
            800,
            600,
            10,
            Path::new("/tmp/out.webm.partial"),
        ));
        assert!(
            jpeg.contains(
                "-f image2pipe -c:v mjpeg -framerate 10 -i pipe:0 -an -fps_mode cfr -c:v libvpx"
            ),
            "{jpeg}"
        );
        let png = joined(&encode_arguments(
            Codec::H264,
            Input::Images(FrameFormat::Png),
            8,
            6,
            10,
            Path::new("/tmp/o.mp4.partial"),
        ));
        assert!(
            png.contains("-f image2pipe -c:v png -framerate 10"),
            "{png}"
        );
    }

    #[test]
    fn the_encoded_route_needs_the_image_pipe_and_the_decoder() {
        assert_eq!(
            everything().encoded_input(),
            vec![FrameFormat::Png, FrameFormat::Jpeg]
        );
        let no_pipe = Capabilities {
            reads_image_pipe: false,
            ..everything()
        };
        assert!(no_pipe.encoded_input().is_empty());
        let no_mjpeg = Capabilities {
            decodes_jpeg: false,
            ..everything()
        };
        assert_eq!(no_mjpeg.encoded_input(), vec![FrameFormat::Png]);
        let decoders =
            "Decoders:\n V....D png                  PNG\n VFS..D mjpeg                MJPEG\n";
        assert!(lists_encoder(decoders, "mjpeg") && lists_encoder(decoders, "png"));
    }

    #[test]
    fn a_line_without_an_end_is_clipped_as_it_arrives() {
        let tail = StderrTail::default();
        let endless = std::io::repeat(b'x').take(10 * 1024 * 1024);
        tail.follow(endless.chain(&b"\nlast line\n"[..]))
            .join()
            .expect("the reader ends")
            .expect("the output is complete");
        let lines = tail.lines();
        assert_eq!(lines.len(), 2);
        assert_eq!(tail.printed(), 2);
        assert_eq!(lines[0].chars().count(), TAIL_LINE_CHARACTERS);
        assert_eq!(lines[1], "last line");
    }

    #[test]
    fn the_tail_keeps_the_last_lines() {
        let text: String = (0..30).map(|index| format!("line {index}\n")).collect();
        let tail = last_lines(&text);
        assert_eq!(tail.len(), TAIL_LINES);
        assert_eq!(tail.last().map(String::as_str), Some("line 29"));
    }

    #[test]
    fn a_version_line_keeps_its_first_three_words() {
        assert_eq!(
            version_line("ffmpeg version 9.0.2 Copyright (c) 2000-2026"),
            "ffmpeg version 9.0.2"
        );
    }
}
