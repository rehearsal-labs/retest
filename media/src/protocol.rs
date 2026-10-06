//! The wire format between a client and the media process.
//!
//! Every message, in either direction, is a prefix of two big-endian `u32`s, the header's length and the
//! payload's length, then the header, one JSON object, then the payload. A frame and a thumbnail request carry an
//! image as their payload, exactly as the capture produced it, never re-encoded as text; an ending carries its frame
//! map, a frame sequence its images and a live frame its image. The lengths travel outside the JSON, so a header
//! that cannot be read costs one message and never the stream's framing.

use std::io::{self, Read};

use serde::{Deserialize, Serialize};

/// The version a client must speak. A change to any message below is a new version.
pub const PROTOCOL_VERSION: u32 = 2;
/// The longest header the process reads or writes. A longer one means the stream is not this protocol.
pub const MAX_HEADER_BYTES: u32 = 64 * 1024;
/// The largest payload the process reads or writes. A 4K PNG screenshot is well under it.
pub const MAX_PAYLOAD_BYTES: u32 = 64 * 1024 * 1024;
/// The longest recording id, in characters.
pub const MAX_ID_CHARACTERS: usize = 200;
/// The longest run, attempt, test, app or session id, in characters.
pub const MAX_IDENTITY_CHARACTERS: usize = 512;
/// The longest frame, action, observation or request id, in characters.
pub const MAX_FRAME_ID_CHARACTERS: usize = 128;
/// The longest output path, in bytes, so every reply that names one stays far below the header limit.
pub const MAX_PATH_BYTES: usize = 4096;
/// How many shortened gaps an `ended` lists; `gaps_shortened` counts them all.
pub const MAX_LISTED_GAPS: usize = 64;

const PREFIX_BYTES: usize = 8;

/// One message as it crossed the pipe, before its header is read.
#[derive(Debug, PartialEq, Eq)]
pub struct Envelope {
    pub header: Vec<u8>,
    pub payload: Vec<u8>,
}

/// Why no message could be read.
#[derive(Debug)]
pub enum ReadError {
    /// The stream ended between messages: the client is gone or done.
    Closed,
    /// The stream ended inside a message.
    Truncated,
    HeaderTooLarge(u32),
    PayloadTooLarge(u32),
    Io(io::Error),
}

impl std::fmt::Display for ReadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReadError::Closed => write!(formatter, "the input ended"),
            ReadError::Truncated => write!(formatter, "the input ended inside a message"),
            ReadError::HeaderTooLarge(length) => {
                write!(
                    formatter,
                    "a header of {length} bytes is longer than the {MAX_HEADER_BYTES} allowed"
                )
            }
            ReadError::PayloadTooLarge(length) => {
                write!(
                    formatter,
                    "a payload of {length} bytes is larger than the {MAX_PAYLOAD_BYTES} allowed"
                )
            }
            ReadError::Io(error) => write!(formatter, "the input could not be read: {error}"),
        }
    }
}

/// Reads one whole message, or says why there is none.
pub fn read_envelope(reader: &mut impl Read) -> Result<Envelope, ReadError> {
    let mut prefix = [0u8; PREFIX_BYTES];
    let filled = fill(reader, &mut prefix).map_err(ReadError::Io)?;
    if filled == 0 {
        return Err(ReadError::Closed);
    }
    if filled < PREFIX_BYTES {
        return Err(ReadError::Truncated);
    }
    let header_length = u32::from_be_bytes([prefix[0], prefix[1], prefix[2], prefix[3]]);
    let payload_length = u32::from_be_bytes([prefix[4], prefix[5], prefix[6], prefix[7]]);
    if header_length > MAX_HEADER_BYTES {
        return Err(ReadError::HeaderTooLarge(header_length));
    }
    if payload_length > MAX_PAYLOAD_BYTES {
        return Err(ReadError::PayloadTooLarge(payload_length));
    }
    let header = read_exactly(reader, header_length as usize)?;
    let payload = read_exactly(reader, payload_length as usize)?;
    Ok(Envelope { header, payload })
}

fn read_exactly(reader: &mut impl Read, length: usize) -> Result<Vec<u8>, ReadError> {
    let mut bytes = vec![0u8; length];
    let filled = fill(reader, &mut bytes).map_err(ReadError::Io)?;
    if filled < length {
        return Err(ReadError::Truncated);
    }
    Ok(bytes)
}

// Reads until `buffer` is full or the stream ends, and says how much arrived. `read_exact` cannot tell an end
// between messages from one inside a message.
fn fill(reader: &mut impl Read, buffer: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        match reader.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(filled)
}

/// Frames a header and payload as one message.
pub fn encode_envelope(header: &[u8], payload: &[u8]) -> Vec<u8> {
    let mut message = Vec::with_capacity(PREFIX_BYTES + header.len() + payload.len());
    message.extend_from_slice(&length_of(header).to_be_bytes());
    message.extend_from_slice(&length_of(payload).to_be_bytes());
    message.extend_from_slice(header);
    message.extend_from_slice(payload);
    message
}

fn length_of(bytes: &[u8]) -> u32 {
    // Replies are kept under the limits by `encode_reply`, so this never truncates.
    u32::try_from(bytes.len()).unwrap_or(u32::MAX)
}

/// A reply framed as one message, its header kept under the header limit by shortening the lists in it that can
/// be shortened, each with a count that still says how many there were.
pub fn encode_reply(reply: &Reply, payload: &[u8]) -> Vec<u8> {
    let mut header = serde_json::to_vec(reply).unwrap_or_default();
    if header.len() > MAX_HEADER_BYTES as usize {
        let mut shortened = reply.clone();
        shortened.shorten();
        header = serde_json::to_vec(&shortened).unwrap_or_default();
        if header.len() > MAX_HEADER_BYTES as usize {
            shortened.clip_message();
            header = serde_json::to_vec(&shortened).unwrap_or_default();
        }
    }
    encode_envelope(&header, payload)
}

/// The format of an image's bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FrameFormat {
    Png,
    Jpeg,
}

impl FrameFormat {
    /// The file extension a thumbnail in this format gets.
    pub fn extension(self) -> &'static str {
        match self {
            FrameFormat::Png => "png",
            FrameFormat::Jpeg => "jpg",
        }
    }
}

/// Whose recording it is. Every id is Retest's own bounded string; no secret and no app text belongs in one.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordingIdentity {
    pub run_id: String,
    pub attempt_id: String,
    pub test_id: String,
    pub app: String,
    pub session_id: String,
}

/// Begins a recording. The process adds the container's extension to `output` and names the file in its replies.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartRecording {
    pub recording_id: String,
    pub identity: RecordingIdentity,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub output: String,
    /// How long finishing may take, from the finish message until the container is written.
    pub deadline_ms: u64,
    pub queue_frames: Option<usize>,
    pub queue_bytes: Option<usize>,
    /// The longest pause between frames the video shows in full; a longer one is shortened to this.
    pub max_gap_ms: Option<u64>,
    /// The most capture time a recording covers, from its first frame; later frames are refused.
    pub max_duration_ms: Option<u64>,
    /// How long the encoder may take to accept one frame before it is stopped as stalled.
    pub stall_ms: Option<u64>,
    /// Whether the frames the encoder takes are kept for frame sequences; on unless `false`.
    pub keep_frames: Option<bool>,
    /// The most bytes of kept frames.
    pub frame_store_bytes: Option<u64>,
    /// Frames of this format at the recording's size go to the encoder undecoded.
    pub encoded_format: Option<FrameFormat>,
}

/// Announces a frame. Its byte length is the prefix's payload length, and the bytes follow the header.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrameHeader {
    pub recording_id: String,
    pub frame_id: String,
    pub action_id: Option<String>,
    pub observation_id: Option<String>,
    /// When the frame was captured, in microseconds on any monotonic clock the client keeps for the recording.
    pub timestamp_us: u64,
    pub format: FrameFormat,
}

/// Says capture delivered no frames from `from_us` to `to_us`, and why, as a code.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureGap {
    pub from_us: u64,
    pub to_us: u64,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureGapRequest {
    pub recording_id: String,
    pub from_us: u64,
    pub to_us: u64,
    pub reason: String,
}

/// Ends a recording. With `end_timestamp_us` the last frame stays on screen until then.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FinishRecording {
    pub recording_id: String,
    pub end_timestamp_us: Option<u64>,
}

/// Asks for a thumbnail of the image in the payload, written beside `output` with the format's extension.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThumbnailRequest {
    pub request_id: String,
    pub source_format: FrameFormat,
    pub output: String,
    pub max_width: u32,
    pub max_height: u32,
    pub format: FrameFormat,
    pub quality: Option<u8>,
}

/// Asks for a recording's kept frames inside an interval of capture time.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FramesRequest {
    pub request_id: String,
    pub recording_id: String,
    pub from_us: u64,
    pub to_us: u64,
    pub max_frames: usize,
    pub max_width: u32,
    pub max_height: u32,
    pub max_bytes: Option<usize>,
    pub format: Option<FrameFormat>,
    pub quality: Option<u8>,
    pub min_gap_us: Option<u64>,
}

/// Asks for a live view of a recording's newest frame.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatchRequest {
    pub recording_id: String,
    pub max_width: u32,
    pub max_height: u32,
    pub max_fps: u32,
    pub quality: Option<u8>,
}

/// A request that names one recording and nothing else.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordingRequest {
    pub recording_id: String,
}

/// Asks what a lost recording or thumbnail left beside `output`, and to remove it when `remove` is true.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LeftoversRequest {
    pub request_id: String,
    pub output: String,
    pub remove: bool,
}

/// A request with no fields; one with any is refused like any other unknown field.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyRequest {}

/// A message from the client, read from its header.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Request {
    Ready(EmptyRequest),
    Start(StartRecording),
    Frame(FrameHeader),
    CaptureGap(CaptureGapRequest),
    Finish(FinishRecording),
    Thumbnail(ThumbnailRequest),
    Frames(FramesRequest),
    Watch(WatchRequest),
    Unwatch(RecordingRequest),
    Release(RecordingRequest),
    Leftovers(LeftoversRequest),
    Shutdown(EmptyRequest),
}

/// The request types, as an error names the one it refuses.
pub const REQUEST_TYPES: [&str; 12] = [
    "ready",
    "start",
    "frame",
    "captureGap",
    "finish",
    "thumbnail",
    "frames",
    "watch",
    "unwatch",
    "release",
    "leftovers",
    "shutdown",
];

/// A request with the bytes that came with it.
#[derive(Debug, PartialEq, Eq)]
pub enum Incoming {
    Ready,
    Start(StartRecording),
    Frame(FrameHeader, Vec<u8>),
    CaptureGap(CaptureGapRequest),
    Finish(FinishRecording),
    Thumbnail(ThumbnailRequest, Vec<u8>),
    Frames(FramesRequest),
    Watch(WatchRequest),
    Unwatch(RecordingRequest),
    Release(RecordingRequest),
    Leftovers(LeftoversRequest),
    Shutdown,
}

/// Why a message was refused, with the request type and the recording or request it names when its header names
/// them, so a client waiting on that request hears the refusal even when the rest of the header could not be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub message: String,
    pub request: Option<&'static str>,
    pub recording_id: Option<String>,
    pub request_id: Option<String>,
}

/// Reads a message's header. Only a frame and a thumbnail request may carry a payload, and each must.
pub fn parse_request(envelope: Envelope) -> Result<Incoming, Refusal> {
    let refuse = |message: String| refusal_for(&envelope.header, message);
    let request: Request = match serde_json::from_slice(&envelope.header) {
        Ok(request) => request,
        Err(error) => return Err(refuse(format!("the header is not a request: {error}"))),
    };
    let has_payload = !envelope.payload.is_empty();
    match request {
        Request::Frame(header) if has_payload => Ok(Incoming::Frame(header, envelope.payload)),
        Request::Thumbnail(request) if has_payload => {
            Ok(Incoming::Thumbnail(request, envelope.payload))
        }
        Request::Frame(_) | Request::Thumbnail(_) => {
            Err(refuse("the request carried no image bytes".to_owned()))
        }
        _ if has_payload => Err(refuse(
            "only a frame or a thumbnail request may carry bytes".to_owned(),
        )),
        Request::Ready(_) => Ok(Incoming::Ready),
        Request::Start(start) => Ok(Incoming::Start(start)),
        Request::CaptureGap(gap) => Ok(Incoming::CaptureGap(gap)),
        Request::Finish(finish) => Ok(Incoming::Finish(finish)),
        Request::Frames(request) => Ok(Incoming::Frames(request)),
        Request::Watch(request) => Ok(Incoming::Watch(request)),
        Request::Unwatch(request) => Ok(Incoming::Unwatch(request)),
        Request::Release(request) => Ok(Incoming::Release(request)),
        Request::Leftovers(request) => Ok(Incoming::Leftovers(request)),
        Request::Shutdown(_) => Ok(Incoming::Shutdown),
    }
}

/// A refusal naming what a header that may be malformed in every other way says about itself.
pub fn refusal_for(header: &[u8], message: String) -> Refusal {
    let value: Option<serde_json::Value> = serde_json::from_slice(header).ok();
    let text = |name: &str, limit: usize| {
        value
            .as_ref()
            .and_then(|value| value.get(name))
            .and_then(serde_json::Value::as_str)
            .map(|id| clip_id(id, limit))
    };
    let request = value
        .as_ref()
        .and_then(|value| value.get("type"))
        .and_then(serde_json::Value::as_str)
        .and_then(|name| REQUEST_TYPES.into_iter().find(|known| *known == name));
    Refusal {
        message,
        request,
        recording_id: text("recordingId", MAX_ID_CHARACTERS),
        request_id: text("requestId", MAX_FRAME_ID_CHARACTERS),
    }
}

// An id as a reply can carry it back: no longer than its limit and without control characters.
fn clip_id(id: &str, limit: usize) -> String {
    id.chars()
        .filter(|character| !character.is_control())
        .take(limit)
        .collect()
}

/// Why an id cannot be used, or `None` when it can: it has 1 to `limit` characters and none is a control character.
pub fn invalid_id(name: &str, id: &str, limit: usize) -> Option<String> {
    let length = id.chars().count();
    if length == 0 || length > limit {
        return Some(format!("the {name} must have 1 to {limit} characters"));
    }
    id.chars()
        .any(char::is_control)
        .then(|| format!("the {name} holds a control character"))
}

/// Whether a capture gap's reason is a code: lower-case letters, digits and underscores, 1 to 64 of them.
pub fn is_reason_code(reason: &str) -> bool {
    (1..=64).contains(&reason.len())
        && reason
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

/// A message to the client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Reply {
    Hello(Hello),
    Ready(ReadyReply),
    Started(Box<Started>),
    Ended(Box<Ended>),
    Thumbnail(Thumbnail),
    Frames(Box<FrameSequence>),
    Watching(Watching),
    Live(LiveFrame),
    WatchEnded(WatchEnded),
    Released(Released),
    Leftovers(Leftovers),
    Error(ErrorReply),
    Bye(Bye),
}

impl Reply {
    // Shortens the lists a reply can do without, keeping their counts, for a header that would pass the limit.
    fn shorten(&mut self) {
        match self {
            Reply::Ended(ended) => {
                ended.gaps.clear();
                ended.capture_gaps.clear();
                if let Some(encoder) = ended.encoder.as_mut() {
                    let keep = encoder.stderr.len().saturating_sub(3);
                    encoder.stderr.drain(..keep);
                }
            }
            Reply::Frames(frames) => frames.stretches.clear(),
            Reply::Leftovers(leftovers) => leftovers.skipped.clear(),
            _ => {}
        }
    }

    // Clips a message that alone would keep a reply past the limit, such as one naming a very long encoder path.
    fn clip_message(&mut self) {
        let clip = |message: &mut String| {
            if message.chars().count() > CLIPPED_MESSAGE_CHARACTERS {
                *message = message.chars().take(CLIPPED_MESSAGE_CHARACTERS).collect();
                message.push_str(" …");
            }
        };
        match self {
            Reply::Ended(ended) => clip(&mut ended.message),
            Reply::Thumbnail(thumbnail) => clip(&mut thumbnail.message),
            Reply::Error(error) => clip(&mut error.message),
            Reply::Ready(ReadyReply {
                encoder:
                    EncoderProbe::Failed { message, .. } | EncoderProbe::Unavailable { message, .. },
            }) => clip(message),
            _ => {}
        }
    }
}

/// How long a message is kept when a reply must be shortened to stay under the header limit.
const CLIPPED_MESSAGE_CHARACTERS: usize = 2000;

/// How the binary was built, as its build script recorded it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildIdentity {
    /// The source revision the binary was built from, when the build could tell.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    /// Whether the crate's sources had changes not in that revision.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dirty: Option<bool>,
    /// The target triple, such as `aarch64-apple-darwin`.
    pub target: String,
    /// `release` or `debug`.
    pub profile: String,
}

/// What the encoder can do, as the probe found it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum EncoderProbe {
    Probing,
    #[serde(rename_all = "camelCase")]
    Ready {
        version: String,
        codec: String,
        container: String,
        encoder: String,
        encoded_input: Vec<FrameFormat>,
        probe_ms: u64,
    },
    #[serde(rename_all = "camelCase")]
    Unavailable {
        version: String,
        missing: String,
        message: String,
        probe_ms: u64,
    },
    #[serde(rename_all = "camelCase")]
    Failed {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        exit: Option<EncoderExit>,
        probe_ms: u64,
    },
}

/// The first message, sent once the encoder probe has answered or the greeting's wait for it is over.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub protocol: u32,
    /// The crate version this binary was built from.
    pub version: String,
    pub build: BuildIdentity,
    /// The encoder program it runs, as it was given.
    pub ffmpeg: String,
    pub encoder: EncoderProbe,
}

/// The answer to a `ready` request, once the probe has ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyReply {
    pub encoder: EncoderProbe,
}

/// A recording began: its encoder runs and frames may follow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    pub recording_id: String,
    pub identity: RecordingIdentity,
    pub codec: String,
    pub container: String,
    pub encoder: String,
    /// The encoder's first version line, such as `ffmpeg version 9.0.2`.
    pub encoder_version: String,
    /// The encoder's process id, which leads a process group of its own.
    pub encoder_pid: u32,
    /// Where the finished video will be. Nothing is at this path until it ends `ok`.
    pub path: String,
    /// `encoded` when frames of `encoded_format` reach the encoder undecoded, `decoded` when every frame is decoded.
    pub route: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoded_format: Option<FrameFormat>,
    /// Where the kept frames are, when they are kept.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frames_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_store_bytes: Option<u64>,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub queue_frames: usize,
    pub queue_bytes: usize,
    pub max_gap_ms: u64,
    pub max_duration_ms: u64,
    pub stall_ms: u64,
}

/// How a recording ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EndStatus {
    /// The container is written and at `path`.
    Ok,
    /// No frame could be shown, so there is no video.
    NoFrames,
    /// The encoder runs but has neither H.264 nor VP8.
    EncoderUnavailable,
    /// The encoder could not start, did not answer as ffmpeg, or exited without writing the video.
    EncoderFailed,
    /// Finishing took longer than the recording's deadline; the encoder was stopped.
    DeadlineExceeded,
    /// The process was told to shut down, or its input ended, before the recording finished.
    Stopped,
    /// The encoder succeeded but its file could not be put at `path`; it is kept at `partial_path`.
    OutputFailed,
}

impl EndStatus {
    /// The status as the protocol spells it, which is also its evidence reason.
    pub fn code(self) -> &'static str {
        match self {
            EndStatus::Ok => "ok",
            EndStatus::NoFrames => "no_frames",
            EndStatus::EncoderUnavailable => "encoder_unavailable",
            EndStatus::EncoderFailed => "encoder_failed",
            EndStatus::DeadlineExceeded => "deadline_exceeded",
            EndStatus::Stopped => "stopped",
            EndStatus::OutputFailed => "output_failed",
        }
    }
}

/// What happened to the frames of a recording. `received` is the sum of every other count except `resized`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameCounts {
    pub received: u64,
    /// Frames written to the encoder, which are in the video when the recording ends `ok`.
    pub shown: u64,
    /// Frames replaced by a later one before their moment in the video came, at this frame rate.
    pub superseded: u64,
    /// Frames the full queue let go, oldest first.
    pub dropped: u64,
    /// Frames whose timestamp was earlier than the frame before.
    pub out_of_order: u64,
    /// Frames more than the recording's maximum duration after its first frame.
    pub out_of_range: u64,
    /// Frames whose bytes were not a readable image of their format.
    pub undecodable: u64,
    /// Frames whose id the recording had already seen.
    pub duplicate: u64,
    /// Frames still waiting when the recording ended early.
    pub unprocessed: u64,
    /// Frames of another size, scaled to fit the recording. Counted among the others too.
    pub resized: u64,
}

/// How the encoder process ended, its last lines, and how many lines it printed in all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncoderExit {
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub stderr: Vec<String>,
    pub lines: u64,
}

/// A pause between two frames that was longer than the recording's maximum gap, shortened to it in the video.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gap {
    /// The capture timestamp of the frame after the pause.
    pub capture_us: u64,
    /// How much shorter the pause is in the video than it was.
    pub shortened_by_us: u64,
}

/// The deepest the queue was, and how many frames found it full and let an older frame go.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueStats {
    pub peak_frames: u64,
    pub peak_bytes: u64,
    pub saturated: u64,
}

/// The recording's evidence, apart from what the test observed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    /// `complete`, `partial` or `unavailable`.
    pub status: &'static str,
    pub reasons: Vec<&'static str>,
}

/// The one message each recording ends with, whether the client finished it or not. Its payload is the frame map:
/// a JSON array saying where each frame went, by its id, in the order frames arrived.
///
/// Video time maps back to the capture clock: the video starts at `first_timestamp_us`, and a frame captured at
/// `t` appears at `t - first_timestamp_us` minus every `shortened_by_us` of the gaps up to it, rounded to the
/// nearest frame interval.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ended {
    pub recording_id: String,
    pub identity: RecordingIdentity,
    pub status: EndStatus,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Where a finished video was kept when it could not be put at its path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partial_path: Option<String>,
    /// How the finished file was put at `path`: `link` or `copy`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placed_by: Option<&'static str>,
    pub frames: FrameCounts,
    /// The capture timestamp of the first frame in the video: video time zero.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_timestamp_us: Option<u64>,
    /// Frames received before that one that are not in the video: dropped by the queue or undecodable.
    pub frames_before_first: u64,
    /// The first shortened gaps, in order, at most `MAX_LISTED_GAPS`.
    pub gaps: Vec<Gap>,
    /// How many gaps were shortened in all.
    pub gaps_shortened: u64,
    /// Whether the finish's end timestamp was moved earlier, to the maximum gap after the last frame or to the
    /// maximum duration.
    pub end_clipped: bool,
    /// Frames written to the encoder, each source frame repeated for as long as it was on screen.
    pub output_frames: u64,
    pub duration_us: u64,
    /// Frame bytes read from the client.
    pub bytes_received: u64,
    /// Bytes written to the encoder: raw pixels on the decoded route, images on the encoded one.
    pub bytes_to_encoder: u64,
    pub queue: QueueStats,
    /// The first capture gaps the client reported, at most `MAX_LISTED_GAPS`.
    pub capture_gaps: Vec<CaptureGap>,
    pub capture_gaps_reported: u64,
    pub evidence: Evidence,
    /// How many frames the frame map in the payload lists.
    pub frame_map_entries: u64,
    /// Frames past the frame map's bounds, 200 000 entries and the payload limit, counted but not listed.
    pub frame_map_omitted: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoder: Option<EncoderExit>,
    /// Time from the finish message to this reply.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finalize_ms: Option<u64>,
}

/// One frame's place in the frame map.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameMapEntry<'a> {
    pub frame_id: &'a str,
    pub capture_us: u64,
    pub fate: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_us: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_frames: Option<u64>,
}

/// A thumbnail's outcome.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thumbnail {
    pub request_id: String,
    /// `ok`, `undecodable`, `too_large`, `output_in_use`, `output_failed`, `busy` or `stopped`.
    pub status: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byte_length: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placed_by: Option<&'static str>,
}

/// A returned frame of a frame sequence; its image is the next `byte_length` bytes of the payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceFrame {
    pub frame_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observation_id: Option<String>,
    pub capture_us: u64,
    /// `shown`, `superseded`, `pending` while a running recording has not yet placed it, or `unprocessed` when the
    /// recording ended before it was written to the encoder.
    pub fate: &'static str,
    pub source_width: u32,
    pub source_height: u32,
    pub width: u32,
    pub height: u32,
    pub format: FrameFormat,
    pub byte_length: u64,
}

/// What became of the frames inside a stretch that has no kept frame.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StretchLosses {
    pub dropped: u64,
    pub undecodable: u64,
    pub out_of_order: u64,
    pub out_of_range: u64,
    pub duplicate: u64,
    pub queued: u64,
    pub not_stored: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stretch {
    pub from_us: u64,
    pub to_us: u64,
    pub lost: StretchLosses,
    pub capture_gaps: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Omitted {
    pub by_count: u64,
    pub by_bytes: u64,
    pub undecodable: u64,
}

/// A frame sequence's outcome; its payload is the returned frames' images, one after another.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameSequence {
    pub request_id: String,
    pub recording_id: String,
    /// `ok`, `not_kept`, `released`, `busy`, `stopped` or `store_failed`.
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// `running` or `ended`.
    pub recording: &'static str,
    pub from_us: u64,
    pub to_us: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stored_through_us: Option<u64>,
    pub in_interval: u64,
    pub available: u64,
    pub frames: Vec<SequenceFrame>,
    pub omitted: Omitted,
    pub stretches: Vec<Stretch>,
    pub stretches_found: u64,
    /// Omitted capture-gap details across the recording, when their bounds may overlap this interval.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture_gaps_omitted: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Watching {
    pub recording_id: String,
    pub max_width: u32,
    pub max_height: u32,
    pub max_fps: u32,
}

/// The newest frame of a watched recording; its JPEG image is the payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveFrame {
    pub recording_id: String,
    pub frame_id: String,
    pub capture_us: u64,
    pub width: u32,
    pub height: u32,
    pub format: FrameFormat,
    pub sequence: u64,
    pub skipped: u64,
    pub dropped: u64,
    pub byte_length: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchEnded {
    pub recording_id: String,
    /// `unwatched`, `recording_ended`, `released`, `shutdown` or `failed`.
    pub reason: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub sent: u64,
    pub skipped: u64,
    pub dropped: u64,
    pub failed: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Released {
    pub recording_id: String,
    /// `requested`, or `limit` when more ended recordings kept frames than the process allows.
    pub reason: &'static str,
    pub removed: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeftoverFile {
    pub path: String,
    /// `video_partial`, `frame_store` or `thumbnail_partial`.
    pub kind: &'static str,
    pub byte_length: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Leftovers {
    pub request_id: String,
    /// `ok`, `in_use` or `invalid`.
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub output: String,
    pub files: Vec<LeftoverFile>,
    pub removed: bool,
    pub skipped: Vec<String>,
}

/// What went wrong with a message the process could not act on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// The header could not be read as a request; the process goes on with the next message.
    InvalidMessage,
    /// A start the process refused, such as an odd width.
    InvalidStart,
    UnknownRecording,
    DuplicateRecording,
    /// A file is already at the output path or its `.partial`, or a running recording writes there.
    OutputInUse,
    /// The process already runs as many recordings as it allows.
    TooManyRecordings,
    /// The request needs an ended recording, and this one still runs.
    RecordingRunning,
    /// The recording already has a live view.
    AlreadyWatched,
    /// The recording has no live view to stop.
    NotWatched,
    /// The stream broke the framing; the process shuts down.
    ProtocolViolation,
    /// A thumbnail or frame sequence failed inside the process; the request is answered, and nothing is held.
    JobFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorReply {
    pub code: ErrorCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recording_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub message: String,
}

/// The last message: every recording has ended, every job has answered, every kept frame is removed, and the
/// process exits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bye {
    /// Recordings that were still running and ended `stopped`.
    pub stopped: u64,
    /// Normal replies dropped before this terminal reply was queued; absent when zero.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replies_dropped: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_all(bytes: &[u8]) -> Vec<Result<Envelope, String>> {
        let mut reader = bytes;
        let mut messages = Vec::new();
        loop {
            match read_envelope(&mut reader) {
                Ok(envelope) => messages.push(Ok(envelope)),
                Err(ReadError::Closed) => return messages,
                Err(error) => {
                    messages.push(Err(error.to_string()));
                    return messages;
                }
            }
        }
    }

    // A reader that hands out at most `step` bytes at a time, as a pipe can.
    struct Trickle<'a> {
        bytes: &'a [u8],
        step: usize,
    }

    impl Read for Trickle<'_> {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let count = self.step.min(buffer.len()).min(self.bytes.len());
            buffer[..count].copy_from_slice(&self.bytes[..count]);
            self.bytes = &self.bytes[count..];
            Ok(count)
        }
    }

    fn parsed(header: &[u8], payload: &[u8]) -> Result<Incoming, Refusal> {
        parse_request(Envelope {
            header: header.to_vec(),
            payload: payload.to_vec(),
        })
    }

    #[test]
    fn frames_round_trip_with_their_bytes_untouched() {
        let payload: Vec<u8> = (0..=255).collect();
        let mut stream = encode_envelope(
            br#"{"type":"frame","recordingId":"a","frameId":"f1","observationId":"o3","timestampUs":5,"format":"png"}"#,
            &payload,
        );
        stream.extend(encode_envelope(br#"{"type":"shutdown"}"#, &[]));
        let messages = read_all(&stream);
        assert_eq!(messages.len(), 2);
        let frame = messages[0].as_ref().expect("the frame reads");
        assert_eq!(frame.payload, payload);
        let expected = FrameHeader {
            recording_id: "a".into(),
            frame_id: "f1".into(),
            action_id: None,
            observation_id: Some("o3".into()),
            timestamp_us: 5,
            format: FrameFormat::Png,
        };
        assert_eq!(
            parsed(&frame.header, &frame.payload),
            Ok(Incoming::Frame(expected, payload))
        );
    }

    #[test]
    fn a_message_split_across_reads_is_read_whole() {
        let stream = encode_envelope(br#"{"type":"shutdown"}"#, &[]);
        for step in [1, 3, 7] {
            let mut reader = Trickle {
                bytes: &stream,
                step,
            };
            let envelope = read_envelope(&mut reader).expect("the message reads");
            assert_eq!(parse_request(envelope), Ok(Incoming::Shutdown));
            assert!(matches!(read_envelope(&mut reader), Err(ReadError::Closed)));
        }
    }

    #[test]
    fn an_end_inside_a_message_is_truncation_not_a_close() {
        let stream = encode_envelope(br#"{"type":"shutdown"}"#, &[]);
        for cut in [1, 7, 8, stream.len() - 1] {
            let mut reader = &stream[..cut];
            assert!(
                matches!(read_envelope(&mut reader), Err(ReadError::Truncated)),
                "cut at {cut}"
            );
        }
        let mut empty: &[u8] = &[];
        assert!(matches!(read_envelope(&mut empty), Err(ReadError::Closed)));
    }

    #[test]
    fn lengths_beyond_the_limits_are_refused_before_reading() {
        let mut header = Vec::new();
        header.extend_from_slice(&(MAX_HEADER_BYTES + 1).to_be_bytes());
        header.extend_from_slice(&0u32.to_be_bytes());
        assert!(matches!(
            read_envelope(&mut header.as_slice()),
            Err(ReadError::HeaderTooLarge(_))
        ));
        let mut payload = Vec::new();
        payload.extend_from_slice(&2u32.to_be_bytes());
        payload.extend_from_slice(&(MAX_PAYLOAD_BYTES + 1).to_be_bytes());
        assert!(matches!(
            read_envelope(&mut payload.as_slice()),
            Err(ReadError::PayloadTooLarge(_))
        ));
    }

    #[test]
    fn a_bad_header_costs_one_message_and_keeps_the_framing() {
        let mut stream = encode_envelope(b"not json", b"stray bytes");
        stream.extend(encode_envelope(br#"{"type":"shutdown"}"#, &[]));
        let messages = read_all(&stream);
        let first = messages[0].as_ref().expect("the framing holds");
        assert!(parsed(&first.header, &first.payload).is_err());
        let second = messages[1].as_ref().expect("the next message reads");
        assert_eq!(parsed(&second.header, &[]), Ok(Incoming::Shutdown));
    }

    #[test]
    fn headers_are_checked_strictly() {
        let cases: [(&[u8], &[u8]); 10] = [
            (br#"{"type":"shutdown"}"#, b"x"),
            (br#"{"type":"shutdown","now":true}"#, b""),
            (br#"{"type":"ready","soon":true}"#, b""),
            (br#"{"type":"start","recordingId":"r","identity":{"runId":"a","attemptId":"b","testId":"c","app":"d","sessionId":"e"},"width":8,"height":6,"fps":30,"output":"/tmp/r","deadlineMs":100,"colour":1}"#, b""),
            (br#"{"type":"start","recordingId":"r","width":8,"height":6,"fps":30,"output":"/tmp/r","deadlineMs":100}"#, b""),
            (br#"{"type":"frame","recordingId":"a","frameId":"f","timestampUs":1,"format":"png"}"#, b""),
            (br#"{"type":"frame","recordingId":"a","timestampUs":1,"format":"png"}"#, b"x"),
            (br#"{"type":"thumbnail","requestId":"q","sourceFormat":"png","output":"/tmp/t","maxWidth":8,"maxHeight":8,"format":"png"}"#, b""),
            (br#"{"type":"finish","recordingId":"a","extra":1}"#, b""),
            (br#"{"type":"rewind"}"#, b""),
        ];
        for (header, payload) in cases {
            assert!(
                parsed(header, payload).is_err(),
                "{}",
                String::from_utf8_lossy(header)
            );
        }
    }

    #[test]
    fn a_refusal_names_the_request_and_the_ids_its_header_names() {
        let refused = parsed(br#"{"type":"start","recordingId":"ntsc","fps":29.97}"#, &[]);
        let refusal = refused.expect_err("refused");
        assert_eq!(
            (refusal.request, refusal.recording_id.as_deref()),
            (Some("start"), Some("ntsc"))
        );
        let job = parsed(
            br#"{"type":"frames","requestId":"q7","recordingId":"r"}"#,
            &[],
        )
        .expect_err("refused");
        assert_eq!(
            (job.request, job.request_id.as_deref()),
            (Some("frames"), Some("q7"))
        );
        let unnamed = parsed(b"{not json", &[]).expect_err("refused");
        assert_eq!((unnamed.request, unnamed.recording_id), (None, None));
        let invented =
            parsed(br#"{"type":"rewind","recordingId":"a\u0007b"}"#, &[]).expect_err("refused");
        assert_eq!(invented.request, None, "an unknown type is not echoed");
        assert_eq!(
            invented.recording_id.as_deref(),
            Some("ab"),
            "control characters are not echoed"
        );
    }

    #[test]
    fn a_start_reads_its_identity_and_optional_limits() {
        let header = br#"{"type":"start","recordingId":"r","identity":{"runId":"run","attemptId":"a1","testId":"t > x","app":"web","sessionId":"a1:web"},"width":8,"height":6,"fps":30,"output":"/tmp/r","deadlineMs":100,"queueFrames":4,"keepFrames":false,"encodedFormat":"jpeg"}"#;
        let Ok(Incoming::Start(start)) = parsed(header, &[]) else {
            panic!("not a start")
        };
        assert_eq!((start.queue_frames, start.queue_bytes), (Some(4), None));
        assert_eq!(start.identity.session_id, "a1:web");
        assert_eq!(start.keep_frames, Some(false));
        assert_eq!(start.encoded_format, Some(FrameFormat::Jpeg));
    }

    #[test]
    fn ids_and_reasons_are_checked() {
        assert_eq!(invalid_id("frame id", "f1", 4), None);
        assert!(invalid_id("frame id", "", 4).is_some());
        assert!(invalid_id("frame id", "abcde", 4).is_some());
        assert!(invalid_id("frame id", "a\nb", 4).is_some());
        assert_eq!(
            invalid_id("frame id", "éééé", 4),
            None,
            "characters, not bytes"
        );
        assert!(is_reason_code("capture_failed_2"));
        for reason in ["", "Capture", "with space", "dash-ed", &"x".repeat(65)] {
            assert!(!is_reason_code(reason), "{reason}");
        }
    }

    #[test]
    fn replies_are_framed_json_with_their_payload() {
        let written = encode_reply(
            &Reply::Bye(Bye {
                stopped: 2,
                replies_dropped: None,
            }),
            &[],
        );
        let envelope = read_envelope(&mut written.as_slice()).expect("reads back");
        assert!(envelope.payload.is_empty());
        assert_eq!(
            String::from_utf8(envelope.header).expect("utf-8"),
            r#"{"type":"bye","stopped":2}"#
        );
        let probe = Reply::Ready(ReadyReply {
            encoder: EncoderProbe::Ready {
                version: "ffmpeg version 9".into(),
                codec: "h264".into(),
                container: "mp4".into(),
                encoder: "libx264".into(),
                encoded_input: vec![FrameFormat::Jpeg],
                probe_ms: 20,
            },
        });
        let text = serde_json::to_string(&probe).expect("serialises");
        assert_eq!(
            text,
            r#"{"type":"ready","encoder":{"state":"ready","version":"ffmpeg version 9","codec":"h264","container":"mp4","encoder":"libx264","encodedInput":["jpeg"],"probeMs":20}}"#
        );
    }

    #[test]
    fn a_reply_that_would_pass_the_header_limit_is_shortened_with_its_counts_kept() {
        // Each control character is written as six bytes of JSON escape.
        let stderr: Vec<String> = (0..20).map(|_| "\u{1b}".repeat(300)).collect();
        let mut ended = crate::recording::ended_before_start(
            "r",
            &RecordingIdentity {
                run_id: "x".repeat(MAX_IDENTITY_CHARACTERS),
                attempt_id: "x".repeat(MAX_IDENTITY_CHARACTERS),
                test_id: "x".repeat(MAX_IDENTITY_CHARACTERS),
                app: "x".repeat(MAX_IDENTITY_CHARACTERS),
                session_id: "x".repeat(MAX_IDENTITY_CHARACTERS),
            },
            EndStatus::EncoderFailed,
            // A message naming a very long encoder path.
            "m".repeat(16 * MAX_PATH_BYTES),
            Some(EncoderExit {
                exit_code: Some(1),
                signal: None,
                stderr,
                lines: 20,
            }),
        );
        ended.capture_gaps = (0..64)
            .map(|index| CaptureGap {
                from_us: index,
                to_us: index,
                reason: "x".repeat(64),
            })
            .collect();
        ended.capture_gaps_reported = 64;
        let reply = Reply::Ended(Box::new(ended));
        assert!(
            serde_json::to_vec(&reply).expect("json").len() > MAX_HEADER_BYTES as usize,
            "the case passes the limit"
        );
        let message = encode_reply(&reply, &[]);
        let envelope = read_envelope(&mut message.as_slice()).expect("within the limits");
        let value: serde_json::Value = serde_json::from_slice(&envelope.header).expect("json");
        assert_eq!(value["captureGapsReported"], 64);
        assert_eq!(value["captureGaps"], serde_json::json!([]));
        assert_eq!(value["encoder"]["lines"], 20);
        assert_eq!(value["encoder"]["stderr"].as_array().map(Vec::len), Some(3));
        assert!(
            value["message"]
                .as_str()
                .is_some_and(|message| message.ends_with(" …"))
        );
    }
}
