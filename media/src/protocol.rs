//! The wire format between a client and the media process.
//!
//! Every message, in either direction, is a prefix of two big-endian `u32`s, the header's length and the
//! payload's length, then the header, one JSON object, then the payload. Only a frame carries a payload: the
//! image bytes exactly as the capture produced them, never re-encoded as text. The lengths travel outside the
//! JSON, so a header that cannot be read costs one message and never the stream's framing.

use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize};

/// The version a client must speak. A change to any message below is a new version.
pub const PROTOCOL_VERSION: u32 = 1;
/// The longest header the process reads. A longer one means the stream is not this protocol.
pub const MAX_HEADER_BYTES: u32 = 64 * 1024;
/// The largest frame the process reads. A 4K PNG screenshot is well under it.
pub const MAX_PAYLOAD_BYTES: u32 = 64 * 1024 * 1024;
/// The longest recording id, in characters.
pub const MAX_ID_CHARACTERS: usize = 200;
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
    // Replies are small JSON objects and the reader refuses anything near this size, so it never truncates.
    u32::try_from(bytes.len()).unwrap_or(u32::MAX)
}

/// Writes one reply and flushes it, so the client reads it at once.
pub fn write_reply(writer: &mut impl Write, reply: &Reply) -> io::Result<()> {
    let header = serde_json::to_vec(reply).map_err(io::Error::other)?;
    writer.write_all(&encode_envelope(&header, &[]))?;
    writer.flush()
}

/// The format of a frame's bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FrameFormat {
    Png,
    Jpeg,
}

/// Begins a recording. The process adds the container's extension to `output` and names the file in its replies.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartRecording {
    pub recording_id: String,
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
}

/// Announces a frame. Its byte length is the prefix's payload length, and the bytes follow the header.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrameHeader {
    pub recording_id: String,
    /// When the frame was captured, in microseconds on any monotonic clock the client keeps for the recording.
    pub timestamp_us: u64,
    pub format: FrameFormat,
}

/// Ends a recording. With `end_timestamp_us` the last frame stays on screen until then.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FinishRecording {
    pub recording_id: String,
    pub end_timestamp_us: Option<u64>,
}

/// The shutdown message, which has no fields; one with any is refused like any other unknown field.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShutdownRequest {}

/// A message from the client, read from its header.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Request {
    Start(StartRecording),
    Frame(FrameHeader),
    Finish(FinishRecording),
    Shutdown(ShutdownRequest),
}

/// A request with the frame bytes that came with it.
#[derive(Debug, PartialEq, Eq)]
pub enum Incoming {
    Start(StartRecording),
    Frame(FrameHeader, Vec<u8>),
    Finish(FinishRecording),
    Shutdown,
}

/// Why a message was refused, with the recording it names when its header names one, so a client waiting on
/// that recording hears the refusal even when the rest of the header could not be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub message: String,
    pub recording_id: Option<String>,
}

/// Reads a message's header. Only a frame may carry a payload.
pub fn parse_request(envelope: Envelope) -> Result<Incoming, Refusal> {
    let refuse = |message: String| Refusal {
        message,
        recording_id: recording_id_of(&envelope.header),
    };
    let request: Request = match serde_json::from_slice(&envelope.header) {
        Ok(request) => request,
        Err(error) => return Err(refuse(format!("the header is not a request: {error}"))),
    };
    let has_payload = !envelope.payload.is_empty();
    match request {
        Request::Frame(header) if has_payload => Ok(Incoming::Frame(header, envelope.payload)),
        Request::Frame(_) => Err(refuse("a frame carried no bytes".to_owned())),
        _ if has_payload => Err(refuse("only a frame may carry bytes".to_owned())),
        Request::Start(start) => Ok(Incoming::Start(start)),
        Request::Finish(finish) => Ok(Incoming::Finish(finish)),
        Request::Shutdown(_) => Ok(Incoming::Shutdown),
    }
}

// The `recordingId` of a header that may be malformed in every other way.
fn recording_id_of(header: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(header).ok()?;
    let id = value.get("recordingId")?.as_str()?;
    Some(id.chars().take(MAX_ID_CHARACTERS).collect())
}

/// A message to the client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Reply {
    Hello(Hello),
    Started(Started),
    Ended(Ended),
    Error(ErrorReply),
    Bye(Bye),
}

/// The first message, sent as soon as the process runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub protocol: u32,
    /// The crate version this binary was built from.
    pub version: String,
    /// The operating system and architecture it was built for, such as `macos-aarch64`.
    pub target: String,
    /// The encoder program it runs, as it was given.
    pub ffmpeg: String,
}

/// A recording began: its encoder runs and frames may follow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    pub recording_id: String,
    pub codec: String,
    pub container: String,
    pub encoder: String,
    /// The encoder's first version line, such as `ffmpeg version 9.0.2`.
    pub encoder_version: String,
    /// The encoder's process id, which is also its process group: every stop signals the whole group.
    pub encoder_pid: u32,
    /// Where the finished video will be. Nothing is at this path until it ends `ok`.
    pub path: String,
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
    /// Frames still waiting when the recording ended early.
    pub unprocessed: u64,
    /// Frames of another size, scaled to fit the recording. Counted among the others too.
    pub resized: u64,
}

/// How the encoder process ended, and the last lines it printed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncoderExit {
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub stderr: Vec<String>,
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

/// The one message each recording ends with, whether the client finished it or not.
///
/// Video time maps back to the capture clock: the video starts at `first_timestamp_us`, and a frame captured at
/// `t` appears at `t - first_timestamp_us` minus every `shortened_by_us` of the gaps up to it, rounded to the
/// nearest frame interval.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ended {
    pub recording_id: String,
    pub status: EndStatus,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Where a finished video was kept when it could not be put at its path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partial_path: Option<String>,
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
    /// Decoded pixel bytes written to the encoder.
    pub bytes_to_encoder: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoder: Option<EncoderExit>,
    /// Time from the finish message to this reply.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finalize_ms: Option<u64>,
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
    /// The stream broke the framing; the process shuts down.
    ProtocolViolation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorReply {
    pub code: ErrorCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recording_id: Option<String>,
    pub message: String,
}

/// The last message: every recording has ended and the process exits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bye {
    /// Recordings that were still running and ended `stopped`.
    pub stopped: u64,
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

    #[test]
    fn frames_round_trip_with_their_bytes_untouched() {
        let payload: Vec<u8> = (0..=255).collect();
        let mut stream = encode_envelope(
            br#"{"type":"frame","recordingId":"a","timestampUs":5,"format":"png"}"#,
            &payload,
        );
        stream.extend(encode_envelope(br#"{"type":"shutdown"}"#, &[]));
        let messages = read_all(&stream);
        assert_eq!(messages.len(), 2);
        let frame = messages[0].as_ref().expect("the frame reads");
        assert_eq!(frame.payload, payload);
        let parsed = parse_request(Envelope {
            header: frame.header.clone(),
            payload: frame.payload.clone(),
        });
        let expected = FrameHeader {
            recording_id: "a".into(),
            timestamp_us: 5,
            format: FrameFormat::Png,
        };
        assert_eq!(parsed, Ok(Incoming::Frame(expected, payload)));
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
        assert!(
            parse_request(Envelope {
                header: first.header.clone(),
                payload: first.payload.clone()
            })
            .is_err()
        );
        let second = messages[1].as_ref().expect("the next message reads");
        assert_eq!(
            parse_request(Envelope {
                header: second.header.clone(),
                payload: Vec::new()
            }),
            Ok(Incoming::Shutdown)
        );
    }

    #[test]
    fn headers_are_checked_strictly() {
        let cases: [(&[u8], &[u8]); 7] = [
            (br#"{"type":"shutdown"}"#, b"x"),
            (br#"{"type":"shutdown","now":true}"#, b""),
            (br#"{"type":"start","recordingId":"r","width":8,"height":6,"fps":30,"output":"/tmp/r","deadlineMs":100,"colour":1}"#, b""),
            (
                br#"{"type":"frame","recordingId":"a","timestampUs":1,"format":"png"}"#,
                b"",
            ),
            (
                br#"{"type":"frame","recordingId":"a","timestampUs":1,"format":"gif"}"#,
                b"x",
            ),
            (br#"{"type":"finish","recordingId":"a","extra":1}"#, b""),
            (br#"{"type":"rewind"}"#, b""),
        ];
        for (header, payload) in cases {
            let envelope = Envelope {
                header: header.to_vec(),
                payload: payload.to_vec(),
            };
            assert!(
                parse_request(envelope).is_err(),
                "{}",
                String::from_utf8_lossy(header)
            );
        }
    }

    #[test]
    fn a_refusal_names_the_recording_its_header_names() {
        let header = br#"{"type":"start","recordingId":"ntsc","fps":29.97}"#;
        let refused = parse_request(Envelope {
            header: header.to_vec(),
            payload: Vec::new(),
        });
        assert_eq!(
            refused.map_err(|refusal| refusal.recording_id),
            Err(Some("ntsc".to_owned()))
        );
        let unnamed = parse_request(Envelope {
            header: b"{not json".to_vec(),
            payload: Vec::new(),
        });
        assert_eq!(unnamed.map_err(|refusal| refusal.recording_id), Err(None));
    }

    #[test]
    fn a_start_reads_its_optional_queue_limits() {
        let header = br#"{"type":"start","recordingId":"r","width":8,"height":6,"fps":30,"output":"/tmp/r","deadlineMs":100,"queueFrames":4}"#;
        let parsed = parse_request(Envelope {
            header: header.to_vec(),
            payload: Vec::new(),
        });
        let Ok(Incoming::Start(start)) = parsed else {
            panic!("not a start: {parsed:?}")
        };
        assert_eq!((start.queue_frames, start.queue_bytes), (Some(4), None));
    }

    #[test]
    fn replies_are_framed_json_without_payload() {
        let mut written = Vec::new();
        write_reply(&mut written, &Reply::Bye(Bye { stopped: 2 })).expect("writes");
        let envelope = read_envelope(&mut written.as_slice()).expect("reads back");
        assert!(envelope.payload.is_empty());
        assert_eq!(
            String::from_utf8(envelope.header).expect("utf-8"),
            r#"{"type":"bye","stopped":2}"#
        );
    }
}
