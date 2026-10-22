//! The command line: one verb and its named values, each given once. Nothing here touches the system, so it is the
//! same, and tested, on every platform.

use std::ffi::OsString;

/// What one invocation is asked to do.
#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Version,
    /// Puts the runner, the process that started this one, in a new job that ends everything in it once the last
    /// handle to it closes, and leaves that handle with the runner.
    Hold {
        runner: u32,
        job: JobName,
    },
    /// Puts one child of the runner in a new job of its own, with the processes it already started, and leaves the
    /// job's handle with the runner. `within` is the runner's own job, which every process the child started is in.
    Adopt {
        runner: u32,
        within: JobName,
        job: JobName,
        pid: u32,
    },
    /// The processes the job holds now.
    Members {
        job: JobName,
    },
    /// One process as it is now, and whether the job holds it.
    Process {
        pid: u32,
        job: Option<JobName>,
    },
    /// Ends every process the job holds, unless it holds the runner.
    End {
        runner: u32,
        job: JobName,
    },
    /// Ends one process of the job, only while it is the process that started at `started`.
    Terminate {
        runner: u32,
        job: JobName,
        pid: u32,
        started: u64,
    },
    /// Closes the runner's handle to an empty job.
    Release {
        runner: u32,
        job: JobName,
        handle: usize,
    },
    /// The processes in the runner's job that no launch's job holds and that nothing still running in it stands
    /// behind: what a launch left when the process that started it had already ended.
    Strays {
        runner: u32,
        job: JobName,
        launches: Vec<JobName>,
    },
    /// Sends Ctrl+C, or Ctrl+Break, to the console of the job's processes, or of one of them, as a person in that
    /// console would, unless Retest itself is on that console.
    Interrupt {
        runner: u32,
        job: JobName,
        pid: Option<u32>,
        key: Key,
    },
}

/// The key `interrupt` sends: Ctrl+C, which a console program can be set to ignore, or Ctrl+Break, which it cannot.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Key {
    CtrlC,
    CtrlBreak,
}

/// A job's name in this session's namespace, as Retest makes them: `Local\retest-` and then letters, digits and dashes.
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct JobName(String);

const JOB_PREFIX: &str = "Local\\retest-";
const JOB_NAME_LIMIT: usize = 160;

impl JobName {
    /// The name, or why it is not one Retest makes.
    pub fn parse(text: &str) -> Result<Self, String> {
        let rest = text
            .strip_prefix(JOB_PREFIX)
            .ok_or_else(|| format!("a job name starts with {JOB_PREFIX}"))?;
        if rest.is_empty() || text.len() > JOB_NAME_LIMIT {
            return Err(format!(
                "a job name is {JOB_PREFIX} and 1 to {} more characters",
                JOB_NAME_LIMIT - JOB_PREFIX.len()
            ));
        }
        if !rest
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(
                "a job name holds only letters, digits and dashes after its prefix".to_owned(),
            );
        }
        Ok(Self(text.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Reads the arguments after the program's name.
pub fn parse(arguments: impl Iterator<Item = OsString>) -> Result<Command, String> {
    let words = arguments
        .map(|argument| {
            argument
                .into_string()
                .map_err(|_| "arguments must be valid Unicode".to_owned())
        })
        .collect::<Result<Vec<String>, String>>()?;
    let (verb, rest) = words.split_first().ok_or("name what to do")?;
    if verb == "--version" {
        return if rest.is_empty() {
            Ok(Command::Version)
        } else {
            Err("--version takes nothing after it".to_owned())
        };
    }
    let mut values = Values::read(rest)?;
    let command = match verb.as_str() {
        "hold" => Command::Hold {
            runner: values.pid("runner")?,
            job: values.job("job")?,
        },
        "adopt" => Command::Adopt {
            runner: values.pid("runner")?,
            within: values.job("within")?,
            job: values.job("job")?,
            pid: values.pid("pid")?,
        },
        "members" => Command::Members {
            job: values.job("job")?,
        },
        "process" => Command::Process {
            pid: values.pid("pid")?,
            job: values.optional_job("job")?,
        },
        "end" => Command::End {
            runner: values.pid("runner")?,
            job: values.job("job")?,
        },
        "terminate" => Command::Terminate {
            runner: values.pid("runner")?,
            job: values.job("job")?,
            pid: values.pid("pid")?,
            started: values.number("started")?,
        },
        "release" => Command::Release {
            runner: values.pid("runner")?,
            job: values.job("job")?,
            handle: values.handle("handle")?,
        },
        "strays" => Command::Strays {
            runner: values.pid("runner")?,
            job: values.job("job")?,
            launches: values.jobs("launches")?,
        },
        "interrupt" => Command::Interrupt {
            runner: values.pid("runner")?,
            job: values.job("job")?,
            pid: values.optional_pid("pid")?,
            key: values.key("key")?,
        },
        other => return Err(format!("unknown command {other}")),
    };
    values.finish()?;
    Ok(command)
}

// The `--name value` pairs after the verb, taken out one by one, so any left over is named.
struct Values(Vec<(String, String)>);

impl Values {
    fn read(words: &[String]) -> Result<Self, String> {
        let mut pairs: Vec<(String, String)> = Vec::new();
        let mut words = words.iter();
        while let Some(word) = words.next() {
            let name = word
                .strip_prefix("--")
                .ok_or_else(|| format!("expected a --name before {word}"))?;
            let value = words
                .next()
                .ok_or_else(|| format!("--{name} needs a value"))?;
            if pairs.iter().any(|(known, _)| known == name) {
                return Err(format!("--{name} is given twice"));
            }
            pairs.push((name.to_owned(), value.clone()));
        }
        Ok(Self(pairs))
    }

    fn take(&mut self, name: &str) -> Option<String> {
        let index = self.0.iter().position(|(known, _)| known == name)?;
        Some(self.0.remove(index).1)
    }

    fn required(&mut self, name: &str) -> Result<String, String> {
        self.take(name)
            .ok_or_else(|| format!("--{name} is missing"))
    }

    fn number(&mut self, name: &str) -> Result<u64, String> {
        let text = self.required(name)?;
        whole_number(&text).ok_or_else(|| format!("--{name} takes a whole number, not {text}"))
    }

    // Pid 0 is the idle process, which nothing Retest starts can be.
    fn pid(&mut self, name: &str) -> Result<u32, String> {
        let number = self.number(name)?;
        u32::try_from(number)
            .ok()
            .filter(|pid| *pid > 0)
            .ok_or_else(|| format!("--{name} takes a process id from 1 to {}", u32::MAX))
    }

    // Windows hands out handle values in steps of four; anything else names no handle.
    fn handle(&mut self, name: &str) -> Result<usize, String> {
        let number = self.number(name)?;
        usize::try_from(number)
            .ok()
            .filter(|value| *value > 0 && value % 4 == 0)
            .ok_or_else(|| format!("--{name} takes a handle value, a positive multiple of four"))
    }

    fn job(&mut self, name: &str) -> Result<JobName, String> {
        JobName::parse(&self.required(name)?).map_err(|problem| format!("--{name}: {problem}"))
    }

    fn optional_job(&mut self, name: &str) -> Result<Option<JobName>, String> {
        self.take(name)
            .map(|text| JobName::parse(&text).map_err(|problem| format!("--{name}: {problem}")))
            .transpose()
    }

    fn optional_pid(&mut self, name: &str) -> Result<Option<u32>, String> {
        if !self.0.iter().any(|(known, _)| known == name) {
            return Ok(None);
        }
        self.pid(name).map(Some)
    }

    // `c` or `break`; Ctrl+C when absent.
    fn key(&mut self, name: &str) -> Result<Key, String> {
        match self.take(name).as_deref() {
            None | Some("c") => Ok(Key::CtrlC),
            Some("break") => Ok(Key::CtrlBreak),
            Some(other) => Err(format!("--{name} takes c or break, not {other}")),
        }
    }

    // Job names joined by commas, which no name holds; absent when there are none.
    fn jobs(&mut self, name: &str) -> Result<Vec<JobName>, String> {
        let Some(text) = self.take(name) else {
            return Ok(Vec::new());
        };
        text.split(',')
            .map(|part| JobName::parse(part).map_err(|problem| format!("--{name}: {problem}")))
            .collect()
    }

    fn finish(self) -> Result<(), String> {
        match self.0.first() {
            Some((name, _)) => Err(format!("--{name} does not go with this command")),
            None => Ok(()),
        }
    }
}

// Digits only, so a sign, a space or a leading plus never reads as a number.
fn whole_number(text: &str) -> Option<u64> {
    if text.is_empty() || text.len() > 20 || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(words: &[&str]) -> Result<Command, String> {
        parse(words.iter().map(OsString::from))
    }

    fn job(name: &str) -> JobName {
        JobName::parse(name).expect("a valid job name")
    }

    #[test]
    fn each_command_reads_its_named_values_in_any_order() {
        assert_eq!(read(&["--version"]), Ok(Command::Version));
        assert_eq!(
            read(&["hold", "--job", "Local\\retest-1-ab", "--runner", "1"]),
            Ok(Command::Hold {
                runner: 1,
                job: job("Local\\retest-1-ab")
            })
        );
        assert_eq!(
            read(&[
                "adopt",
                "--runner",
                "40",
                "--pid",
                "42",
                "--job",
                "Local\\retest-40-ab-42-1",
                "--within",
                "Local\\retest-40-ab"
            ]),
            Ok(Command::Adopt {
                runner: 40,
                within: job("Local\\retest-40-ab"),
                job: job("Local\\retest-40-ab-42-1"),
                pid: 42
            })
        );
        assert_eq!(
            read(&["members", "--job", "Local\\retest-40-ab-42"]),
            Ok(Command::Members {
                job: job("Local\\retest-40-ab-42")
            })
        );
        assert_eq!(
            read(&["process", "--pid", "42"]),
            Ok(Command::Process { pid: 42, job: None })
        );
        assert_eq!(
            read(&["process", "--pid", "42", "--job", "Local\\retest-40-ab-42"]),
            Ok(Command::Process {
                pid: 42,
                job: Some(job("Local\\retest-40-ab-42"))
            })
        );
        assert_eq!(
            read(&["end", "--runner", "40", "--job", "Local\\retest-40-ab-42"]),
            Ok(Command::End {
                runner: 40,
                job: job("Local\\retest-40-ab-42")
            })
        );
        assert_eq!(
            read(&[
                "terminate",
                "--runner",
                "40",
                "--job",
                "Local\\retest-40-ab-42",
                "--pid",
                "43",
                "--started",
                "133735123456789012"
            ]),
            Ok(Command::Terminate {
                runner: 40,
                job: job("Local\\retest-40-ab-42"),
                pid: 43,
                started: 133_735_123_456_789_012
            })
        );
        assert_eq!(
            read(&[
                "release",
                "--runner",
                "40",
                "--job",
                "Local\\retest-40-ab-42",
                "--handle",
                "1484"
            ]),
            Ok(Command::Release {
                runner: 40,
                job: job("Local\\retest-40-ab-42"),
                handle: 1484
            })
        );
        assert_eq!(
            read(&[
                "strays",
                "--runner",
                "40",
                "--job",
                "Local\\retest-40-ab",
                "--launches",
                "Local\\retest-40-ab-42-1,Local\\retest-40-ab-43-2"
            ]),
            Ok(Command::Strays {
                runner: 40,
                job: job("Local\\retest-40-ab"),
                launches: vec![
                    job("Local\\retest-40-ab-42-1"),
                    job("Local\\retest-40-ab-43-2")
                ]
            })
        );
        assert_eq!(
            read(&["strays", "--runner", "40", "--job", "Local\\retest-40-ab"]),
            Ok(Command::Strays {
                runner: 40,
                job: job("Local\\retest-40-ab"),
                launches: vec![]
            })
        );
        assert_eq!(
            read(&[
                "interrupt",
                "--runner",
                "40",
                "--job",
                "Local\\retest-40-ab-42-1"
            ]),
            Ok(Command::Interrupt {
                runner: 40,
                job: job("Local\\retest-40-ab-42-1"),
                pid: None,
                key: Key::CtrlC
            })
        );
        assert_eq!(
            read(&[
                "interrupt",
                "--runner",
                "40",
                "--job",
                "Local\\retest-40-ab-42-1",
                "--pid",
                "42",
                "--key",
                "break"
            ]),
            Ok(Command::Interrupt {
                runner: 40,
                job: job("Local\\retest-40-ab-42-1"),
                pid: Some(42),
                key: Key::CtrlBreak
            })
        );
        assert!(
            read(&[
                "interrupt",
                "--runner",
                "40",
                "--job",
                "Local\\retest-40-ab-42-1",
                "--key",
                "z"
            ])
            .is_err()
        );
        assert!(
            read(&[
                "strays",
                "--runner",
                "40",
                "--job",
                "Local\\retest-40-ab",
                "--launches",
                "Local\\retest-40-ab-42-1,"
            ])
            .is_err(),
            "an empty name in the list is refused"
        );
        assert_eq!(
            read(&[
                "adopt",
                "--runner",
                "40",
                "--pid",
                "42",
                "--job",
                "Local\\retest-40-ab-42-1"
            ]),
            Err("--within is missing".to_owned())
        );
    }

    #[test]
    fn a_missing_repeated_or_extra_value_is_refused_by_name() {
        assert_eq!(read(&[]), Err("name what to do".to_owned()));
        assert_eq!(
            read(&["hold", "--runner", "1"]),
            Err("--job is missing".to_owned())
        );
        assert_eq!(
            read(&[
                "members",
                "--job",
                "Local\\retest-a",
                "--job",
                "Local\\retest-b"
            ]),
            Err("--job is given twice".to_owned())
        );
        assert_eq!(
            read(&["members", "--job", "Local\\retest-a", "--pid", "4"]),
            Err("--pid does not go with this command".to_owned())
        );
        assert_eq!(
            read(&["members", "--job"]),
            Err("--job needs a value".to_owned())
        );
        assert_eq!(
            read(&["members", "Local\\retest-a"]),
            Err("expected a --name before Local\\retest-a".to_owned())
        );
        assert_eq!(
            read(&["--version", "now"]),
            Err("--version takes nothing after it".to_owned())
        );
        assert_eq!(
            read(&["kill", "--pid", "4"]),
            Err("unknown command kill".to_owned())
        );
    }

    #[test]
    fn numbers_are_digits_only_and_within_their_range() {
        for text in [
            "",
            "-1",
            "+1",
            " 1",
            "1 ",
            "0x10",
            "1.0",
            "184467440737095516160",
        ] {
            assert!(
                read(&["process", "--pid", text]).is_err(),
                "{text:?} read as a pid"
            );
        }
        assert!(read(&["process", "--pid", "0"]).is_err());
        assert!(read(&["process", "--pid", "4294967296"]).is_err());
        assert_eq!(
            read(&["process", "--pid", "4294967295"]),
            Ok(Command::Process {
                pid: u32::MAX,
                job: None
            })
        );
        assert!(
            read(&[
                "release",
                "--runner",
                "1",
                "--job",
                "Local\\retest-a",
                "--handle",
                "6"
            ])
            .is_err()
        );
        assert!(
            read(&[
                "release",
                "--runner",
                "1",
                "--job",
                "Local\\retest-a",
                "--handle",
                "0"
            ])
            .is_err()
        );
        assert!(
            read(&[
                "terminate",
                "--runner",
                "1",
                "--job",
                "Local\\retest-a",
                "--pid",
                "2",
                "--started",
                "18446744073709551616"
            ])
            .is_err()
        );
    }

    #[test]
    fn a_job_name_is_one_retest_makes_and_nothing_else() {
        assert!(JobName::parse("Local\\retest-40-0f3c-42").is_ok());
        for name in [
            "",
            "Local\\retest-",
            "Global\\retest-1",
            "retest-1",
            "Local\\retest-1\\x",
            "Local\\retest-1 2",
            "Local\\retest-ä",
            "Local\\Retest-1",
        ] {
            assert!(JobName::parse(name).is_err(), "{name:?} read as a job name");
        }
        let longest = format!(
            "Local\\retest-{}",
            "a".repeat(JOB_NAME_LIMIT - JOB_PREFIX.len())
        );
        assert!(JobName::parse(&longest).is_ok());
        assert!(JobName::parse(&format!("{longest}a")).is_err());
    }
}
