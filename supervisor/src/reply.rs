//! The one JSON line each invocation prints. Every reply carries `schemaVersion` and `type`; a request Windows or the
//! supervisor refused is a `refused` reply with the reason, so the reader always has a sentence to show, and, apart from
//! it, the Windows call that failed and its code, for a diagnostic. Nothing here touches the system, so it is the same,
//! and tested, on every platform.

/// One process as Windows shows it: its id, the id of the process that started it, when it started, as the 100 ns
/// ticks since 1601 Windows keeps, and the executable it runs. The start is printed as a string, since it does not fit
/// the integers JSON readers keep exactly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub pid: u32,
    /// Absent when the process was not in the snapshot taken of every process's parent.
    pub parent_pid: Option<u32>,
    pub started_at: u64,
    /// Absent when Windows would not say.
    pub image: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Reply {
    Held {
        job: String,
        runner: u32,
        handle: usize,
    },
    /// `ended` says the launch had already ended, so it was not put in the job, though what it started was. `late` are
    /// the processes it had started that were put in the job with it; `by_parent` those that could not be moved, being
    /// in a job of their own inside the runner's, beside the launch, and that the process that started them holds;
    /// `unheld` those that could not be held at all. `complete` is false when the search for them stopped before it
    /// found no more.
    Adopted {
        job: String,
        handle: usize,
        root: Identity,
        ended: bool,
        late: Vec<Identity>,
        by_parent: Vec<Identity>,
        unheld: Vec<u32>,
        complete: bool,
    },
    Members {
        job: String,
        processes: Vec<Identity>,
    },
    Process {
        process: Option<Identity>,
        in_job: Option<bool>,
    },
    Ended {
        job: String,
    },
    Terminated {
        pid: u32,
        outcome: Outcome,
    },
    Released {
        job: String,
    },
    Strays {
        job: String,
        processes: Vec<Identity>,
    },
    /// The console Ctrl+C was sent to, by the job's process it was reached through, and every process on it then.
    Interrupted {
        job: String,
        console: u32,
        reached: Vec<u32>,
    },
    /// `problem` is a sentence a person can read; `detail` names the Windows call that failed and its code.
    Refused {
        problem: String,
        detail: Option<String>,
    },
}

/// What `terminate` found: the recorded process, ended; no process under the pid; or another process under it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Terminated,
    Absent,
    Different,
}

impl Reply {
    /// The reply as one line of JSON, ending in a newline.
    pub fn line(&self) -> String {
        let fields = match self {
            Self::Held {
                job,
                runner,
                handle,
            } => format!(
                "\"type\":\"held\",\"job\":{},\"runner\":{runner},\"handle\":{handle}",
                quote(job)
            ),
            Self::Adopted {
                job,
                handle,
                root,
                ended,
                late,
                by_parent,
                unheld,
                complete,
            } => format!(
                "\"type\":\"adopted\",\"job\":{},\"handle\":{handle},\"root\":{},\"ended\":{ended},\"late\":{},\"byParent\":{},\"unheld\":{},\"complete\":{complete}",
                quote(job),
                identity(root),
                identities(late),
                identities(by_parent),
                numbers(unheld)
            ),
            Self::Members { job, processes } => format!(
                "\"type\":\"members\",\"job\":{},\"processes\":{}",
                quote(job),
                identities(processes)
            ),
            Self::Process { process, in_job } => format!(
                "\"type\":\"process\",\"process\":{},\"inJob\":{}",
                process.as_ref().map_or_else(|| "null".to_owned(), identity),
                in_job.map_or("null", |held| if held { "true" } else { "false" })
            ),
            Self::Ended { job } => format!("\"type\":\"ended\",\"job\":{}", quote(job)),
            Self::Terminated { pid, outcome } => {
                let outcome = match outcome {
                    Outcome::Terminated => "terminated",
                    Outcome::Absent => "absent",
                    Outcome::Different => "different",
                };
                format!("\"type\":\"terminated\",\"pid\":{pid},\"outcome\":\"{outcome}\"")
            }
            Self::Released { job } => format!("\"type\":\"released\",\"job\":{}", quote(job)),
            Self::Strays { job, processes } => format!(
                "\"type\":\"strays\",\"job\":{},\"processes\":{}",
                quote(job),
                identities(processes)
            ),
            Self::Interrupted {
                job,
                console,
                reached,
            } => format!(
                "\"type\":\"interrupted\",\"job\":{},\"console\":{console},\"reached\":{}",
                quote(job),
                numbers(reached)
            ),
            Self::Refused { problem, detail } => format!(
                "\"type\":\"refused\",\"problem\":{},\"detail\":{}",
                quote(problem),
                detail.as_deref().map_or_else(|| "null".to_owned(), quote)
            ),
        };
        format!("{{\"schemaVersion\":1,{fields}}}\n")
    }
}

fn identity(process: &Identity) -> String {
    format!(
        "{{\"pid\":{},\"parentPid\":{},\"startedAt\":\"{}\",\"image\":{}}}",
        process.pid,
        process
            .parent_pid
            .map_or_else(|| "null".to_owned(), |parent| parent.to_string()),
        process.started_at,
        process
            .image
            .as_deref()
            .map_or_else(|| "null".to_owned(), quote)
    )
}

fn numbers(values: &[u32]) -> String {
    format!(
        "[{}]",
        values
            .iter()
            .map(u32::to_string)
            .collect::<Vec<String>>()
            .join(",")
    )
}

fn identities(processes: &[Identity]) -> String {
    format!(
        "[{}]",
        processes
            .iter()
            .map(identity)
            .collect::<Vec<String>>()
            .join(",")
    )
}

/// A JSON string: quotes, backslashes and control characters escaped, everything else as it is, so a path with spaces
/// or letters outside ASCII reads back the same.
pub fn quote(text: &str) -> String {
    let mut quoted = String::with_capacity(text.len() + 2);
    quoted.push('"');
    for character in text.chars() {
        match character {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            '\t' => quoted.push_str("\\t"),
            control
                if (control as u32) < 0x20 || control == '\u{2028}' || control == '\u{2029}' =>
            {
                quoted.push_str(&format!("\\u{:04x}", control as u32));
            }
            other => quoted.push(other),
        }
    }
    quoted.push('"');
    quoted
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chrome(pid: u32, parent: Option<u32>) -> Identity {
        Identity {
            pid,
            parent_pid: parent,
            started_at: 133_735_123_456_789_012,
            image: Some("C:\\Program Files\\Google\\Chrome\\chrome.exe".to_owned()),
        }
    }

    #[test]
    fn every_reply_is_one_line_with_its_schema_version_and_type() {
        let replies = [
            Reply::Held {
                job: "Local\\retest-40-ab".to_owned(),
                runner: 40,
                handle: 1484,
            },
            Reply::Adopted {
                job: "Local\\retest-40-ab-42".to_owned(),
                handle: 1488,
                root: chrome(42, Some(40)),
                ended: false,
                late: vec![chrome(43, Some(42))],
                by_parent: vec![chrome(45, Some(42))],
                unheld: vec![44],
                complete: true,
            },
            Reply::Members {
                job: "Local\\retest-40-ab-42".to_owned(),
                processes: vec![],
            },
            Reply::Process {
                process: None,
                in_job: None,
            },
            Reply::Ended {
                job: "Local\\retest-40-ab-42".to_owned(),
            },
            Reply::Terminated {
                pid: 43,
                outcome: Outcome::Different,
            },
            Reply::Released {
                job: "Local\\retest-40-ab-42".to_owned(),
            },
            Reply::Strays {
                job: "Local\\retest-40-ab".to_owned(),
                processes: vec![chrome(46, Some(41))],
            },
            Reply::Interrupted {
                job: "Local\\retest-40-ab-42".to_owned(),
                console: 42,
                reached: vec![42, 43],
            },
            Reply::Refused {
                problem: "No job named Local\\retest-40-ab-42 is held.".to_owned(),
                detail: None,
            },
            Reply::Refused {
                problem: "Process 42 could not be held in a job of its own.".to_owned(),
                detail: Some("AssignProcessToJobObject failed with Windows error 5.".to_owned()),
            },
        ];
        for reply in replies {
            let line = reply.line();
            assert!(
                line.starts_with("{\"schemaVersion\":1,\"type\":\""),
                "{line}"
            );
            assert!(line.ends_with("}\n"), "{line}");
            assert_eq!(line.matches('\n').count(), 1, "{line}");
        }
    }

    #[test]
    fn an_identity_keeps_its_start_exactly_as_a_string_and_its_absent_parts_as_null() {
        let line = Reply::Members {
            job: "Local\\retest-1-a-2".to_owned(),
            processes: vec![
                chrome(42, Some(40)),
                Identity {
                    pid: 43,
                    parent_pid: None,
                    started_at: u64::MAX,
                    image: None,
                },
            ],
        }
        .line();
        assert_eq!(
            line,
            "{\"schemaVersion\":1,\"type\":\"members\",\"job\":\"Local\\\\retest-1-a-2\",\"processes\":[{\"pid\":42,\"parentPid\":40,\"startedAt\":\"133735123456789012\",\"image\":\"C:\\\\Program Files\\\\Google\\\\Chrome\\\\chrome.exe\"},{\"pid\":43,\"parentPid\":null,\"startedAt\":\"18446744073709551615\",\"image\":null}]}\n"
        );
        assert_eq!(
            Reply::Process {
                process: Some(chrome(42, None)),
                in_job: Some(true)
            }
            .line(),
            "{\"schemaVersion\":1,\"type\":\"process\",\"process\":{\"pid\":42,\"parentPid\":null,\"startedAt\":\"133735123456789012\",\"image\":\"C:\\\\Program Files\\\\Google\\\\Chrome\\\\chrome.exe\"},\"inJob\":true}\n"
        );
        assert_eq!(
            Reply::Adopted {
                job: "Local\\retest-1-a-2".to_owned(),
                handle: 8,
                root: chrome(2, Some(1)),
                ended: true,
                late: vec![],
                by_parent: vec![],
                unheld: vec![5, 6],
                complete: false
            }
            .line(),
            "{\"schemaVersion\":1,\"type\":\"adopted\",\"job\":\"Local\\\\retest-1-a-2\",\"handle\":8,\"root\":{\"pid\":2,\"parentPid\":1,\"startedAt\":\"133735123456789012\",\"image\":\"C:\\\\Program Files\\\\Google\\\\Chrome\\\\chrome.exe\"},\"ended\":true,\"late\":[],\"byParent\":[],\"unheld\":[5,6],\"complete\":false}\n"
        );
        assert_eq!(
            Reply::Refused {
                problem: "Process 42 could not be held in a job of its own.".to_owned(),
                detail: Some("AssignProcessToJobObject failed with Windows error 5.".to_owned())
            }
            .line(),
            "{\"schemaVersion\":1,\"type\":\"refused\",\"problem\":\"Process 42 could not be held in a job of its own.\",\"detail\":\"AssignProcessToJobObject failed with Windows error 5.\"}\n"
        );
    }

    #[test]
    fn quoting_escapes_what_json_requires_and_keeps_every_other_character() {
        assert_eq!(quote("plain"), "\"plain\"");
        assert_eq!(quote("a \"b\" \\c"), "\"a \\\"b\\\" \\\\c\"");
        assert_eq!(quote("line\nnext\r\tend"), "\"line\\nnext\\r\\tend\"");
        assert_eq!(quote("\u{0}\u{1f}\u{7f}"), "\"\\u0000\\u001f\u{7f}\"");
        assert_eq!(quote("\u{2028}\u{2029}"), "\"\\u2028\\u2029\"");
        assert_eq!(
            quote("C:\\Users\\Zoë\\アプリ\\app.exe"),
            "\"C:\\\\Users\\\\Zoë\\\\アプリ\\\\app.exe\""
        );
    }
}
