//! Launch identities for an encoder and descendants observed beneath a verified process it owns.
//! Commands stay in memory. Group numbers never authorize a signal.

use std::collections::BTreeMap;
use std::io::{self, Read};
use std::os::fd::AsRawFd;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const SNAPSHOT_LIMIT: Duration = Duration::from_secs(5);
const SNAPSHOT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone)]
struct Identity {
    pid: u32,
    parent: u32,
    group: u32,
    state: String,
    started: String,
    command: String,
}

impl Identity {
    fn running(&self) -> bool {
        !self.state.starts_with('Z')
    }

    fn matches_birth(&self, other: &Identity) -> bool {
        self.pid == other.pid && self.started == other.started
    }

    fn matches(&self, other: &Identity) -> bool {
        self.matches_birth(other) && self.command == other.command
    }
}

pub struct Ownership {
    root: u32,
    parent: u32,
    records: BTreeMap<u32, Identity>,
    unknown: BTreeMap<u32, Identity>,
    initialized: bool,
    retired: bool,
}

impl Ownership {
    pub fn new(root: u32) -> Self {
        Self {
            root,
            parent: std::process::id(),
            records: BTreeMap::new(),
            unknown: BTreeMap::new(),
            initialized: false,
            retired: false,
        }
    }

    pub fn capture(&mut self) -> Vec<String> {
        if self.retired {
            return Vec::new();
        }
        let initial = !self.initialized;
        self.initialized = true;
        let processes = match snapshot() {
            Ok(processes) => processes,
            Err(error) => return vec![error],
        };
        if initial {
            let Some(root) = processes.iter().find(|entry| entry.pid == self.root) else {
                return vec![format!("launched encoder {} could not be recorded before it exited", self.root)];
            };
            if root.parent != self.parent {
                return vec![format!("encoder {} was not the launched child and was left alone", self.root)];
            }
            self.records.insert(root.pid, root.clone());
        }
        let mut owned: Vec<u32> = processes.iter().filter(|entry| {
            entry.running() && self.records.get(&entry.pid).is_some_and(|record| record.matches(entry))
        }).map(|entry| entry.pid).collect();
        loop {
            let before = owned.len();
            for entry in &processes {
                if !entry.running() || self.records.contains_key(&entry.pid) || !owned.contains(&entry.parent) {
                    continue;
                }
                self.records.insert(entry.pid, entry.clone());
                owned.push(entry.pid);
            }
            if owned.len() == before {
                break;
            }
        }
        let root = processes.iter().find(|entry| entry.pid == self.root);
        let leader_reused = root.is_some_and(|entry| self.records.get(&self.root).is_some_and(|record| !record.matches_birth(entry)));
        if !leader_reused {
            for entry in &processes {
                if entry.running() && entry.group == self.root && !self.records.get(&entry.pid).is_some_and(|record| record.matches_birth(entry)) {
                    self.unknown.insert(entry.pid, entry.clone());
                }
            }
        }
        if processes.iter().any(|entry| entry.running() && self.unknown.get(&entry.pid).is_some_and(|record| record.matches_birth(entry))) {
            return vec![format!("encoder {} has processes whose launch ownership is unknown; they were left alone", self.root)];
        }
        Vec::new()
    }

    pub fn stop(&mut self) -> Vec<String> {
        let mut problems = self.capture();
        let records: Vec<Identity> = self.records.values().cloned().collect();
        for record in records.iter().rev() {
            let processes = match snapshot() {
                Ok(processes) => processes,
                Err(error) => {
                    problems.push(error);
                    break;
                }
            };
            let Some(current) = processes.iter().find(|entry| entry.pid == record.pid) else {
                continue;
            };
            if !current.running() {
                continue;
            }
            if !record.matches(current) {
                problems.push(format!("recorded encoder process {} changed identity and was left alone", record.pid));
                continue;
            }
            let Ok(pid) = libc::pid_t::try_from(record.pid) else {
                problems.push("the recorded encoder pid cannot be signaled".to_owned());
                continue;
            };
            if pid < 2 {
                problems.push("the recorded encoder pid cannot be signaled".to_owned());
                continue;
            }
            // SAFETY: this positive pid was just checked against its recorded command and start identity.
            if unsafe { libc::kill(pid, libc::SIGKILL) } != 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    problems.push(format!("recorded encoder process {} could not be stopped: {error}", record.pid));
                }
            }
        }
        problems
    }

    pub fn remains(&mut self) -> Result<bool, String> {
        if self.retired {
            return Ok(false);
        }
        let processes = snapshot()?;
        if self.records.is_empty() && processes.iter().any(|entry| entry.running() && (entry.pid == self.root || entry.group == self.root)) {
            return Err("encoder launch ownership was never recorded; completion is unknown".to_owned());
        }
        let leader_reused = processes.iter().find(|entry| entry.pid == self.root)
            .is_some_and(|entry| self.records.get(&self.root).is_some_and(|record| !record.matches_birth(entry)));
        if !leader_reused {
            for entry in &processes {
                if entry.running() && entry.group == self.root && !self.records.get(&entry.pid).is_some_and(|record| record.matches_birth(entry)) {
                    self.unknown.insert(entry.pid, entry.clone());
                }
            }
        }
        let live = processes.iter().any(|entry| {
            entry.running() && (self.records.get(&entry.pid).is_some_and(|record| record.matches_birth(entry))
                || self.unknown.get(&entry.pid).is_some_and(|record| record.matches_birth(entry)))
        });
        if !live {
            self.retired = true;
        }
        Ok(live)
    }

    pub fn cleanup(&mut self, limit: Duration) -> Vec<String> {
        let mut problems = self.stop();
        let start = Instant::now();
        loop {
            for problem in self.capture() {
                if !problems.contains(&problem) {
                    problems.push(problem);
                }
            }
            match self.remains() {
                Ok(false) => break,
                Err(error) => {
                    problems.push(error);
                    break;
                }
                Ok(true) if start.elapsed() >= limit => {
                    problems.push("encoder cleanup did not confirm every recorded process had stopped".to_owned());
                    break;
                }
                Ok(true) => thread::sleep(Duration::from_millis(20)),
            }
        }
        problems
    }
}

// A timed-out metadata process is not killed without an observed launch identity. The caller gets an explicit
// failure and leaves it alone. Nonblocking reads keep a failed or unanswered snapshot bounded.
fn snapshot() -> Result<Vec<Identity>, String> {
    let mut child = Command::new("/bin/ps")
        .args(["-ww", "-axo", "pid=,ppid=,pgid=,stat=,lstart=,args="])
        .env_clear().env("PATH", "/usr/bin:/bin").env("LC_ALL", "C")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null())
        .spawn().map_err(|error| format!("encoder ownership could not be read: {error}"))?;
    let mut output = child.stdout.take().ok_or_else(|| "encoder ownership output was unavailable".to_owned())?;
    let fd = output.as_raw_fd();
    // SAFETY: the live pipe owns fd, and fcntl changes only its file status flags.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags == -1 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1 {
        return Err("encoder ownership output could not be made bounded".to_owned());
    }
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut eof = false;
    let start = Instant::now();
    let status = loop {
        loop {
            if start.elapsed() >= SNAPSHOT_LIMIT {
                return Err("encoder ownership query did not answer; its completion is unknown".to_owned());
            }
            match output.read(&mut chunk) {
                Ok(0) => { eof = true; break; }
                Ok(read) => {
                    if bytes.len() + read > SNAPSHOT_BYTES {
                        return Err("encoder ownership output exceeded its limit".to_owned());
                    }
                    bytes.extend_from_slice(&chunk[..read]);
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                Err(_) => return Err("encoder ownership output could not be read".to_owned()),
            }
        }
        match child.try_wait() {
            Ok(Some(status)) if eof => break status,
            Ok(_) => {}
            Err(_) => return Err("encoder ownership query exit could not be read".to_owned()),
        }
        if start.elapsed() >= SNAPSHOT_LIMIT {
            return Err("encoder ownership query did not answer; its completion is unknown".to_owned());
        }
        thread::sleep(Duration::from_millis(5));
    };
    if !status.success() {
        return Err("encoder ownership query failed".to_owned());
    }
    let text = String::from_utf8(bytes).map_err(|_| "encoder ownership output was unreadable".to_owned())?;
    parse_snapshot(&text)
}

fn parse_snapshot(text: &str) -> Result<Vec<Identity>, String> {
    let unreadable = || "the host returned an unreadable encoder process identity".to_owned();
    let mut processes = Vec::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let mut rest = line;
        let mut fields = Vec::new();
        for _ in 0..9 {
            rest = rest.trim_start();
            let end = rest.find(char::is_whitespace).ok_or_else(unreadable)?;
            fields.push(&rest[..end]);
            rest = &rest[end..];
        }
        let command = rest.trim_start();
        if command.is_empty() || fields[4].len() != 3 || fields[5].len() != 3
            || !fields[4].bytes().all(|byte| byte.is_ascii_alphabetic())
            || !fields[5].bytes().all(|byte| byte.is_ascii_alphabetic())
            || fields[6].parse::<u32>().is_err() || fields[8].len() != 4 || fields[8].parse::<u32>().is_err()
            || fields[7].len() != 8 || fields[7].bytes().enumerate().any(|(index, byte)| {
                if index == 2 || index == 5 { byte != b':' } else { !byte.is_ascii_digit() }
            }) {
            return Err(unreadable());
        }
        processes.push(Identity {
            pid: fields[0].parse().map_err(|_| unreadable())?,
            parent: fields[1].parse().map_err(|_| unreadable())?,
            group: fields[2].parse().map_err(|_| unreadable())?,
            state: fields[3].to_owned(),
            started: fields[4..9].join(" "),
            command: command.to_owned(),
        });
    }
    if processes.is_empty() {
        return Err("the host returned no encoder process identities".to_owned());
    }
    Ok(processes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_spacing_is_part_of_the_signal_identity() {
        let entries = parse_snapshot(" 42 7 42 S Mon Oct  5 12:34:56 2026 ffmpeg  output.partial\n").expect("a complete identity");
        assert_eq!(entries[0].command, "ffmpeg  output.partial");
        let mut changed = entries[0].clone();
        changed.command = "ffmpeg output.partial".to_owned();
        assert!(!entries[0].matches(&changed));
        assert!(entries[0].matches_birth(&changed), "exec or command changes do not prove a process has exited");
        changed.started = "Mon Oct 5 12:35:00 2026".to_owned();
        assert!(!entries[0].matches_birth(&changed));
    }

    #[test]
    fn zombies_have_exited_even_when_ps_changes_their_command() {
        let live = parse_snapshot(" 42 7 42 S Mon Oct 5 12:34:56 2026 ffmpeg output.partial\n").expect("a live process");
        let zombie = parse_snapshot(" 42 7 42 Z+ Mon Oct 5 12:34:56 2026 (ffmpeg)\n").expect("an observed zombie");
        assert!(live[0].running());
        assert!(!zombie[0].running());
        assert!(live[0].matches_birth(&zombie[0]));
        assert!(!live[0].matches(&zombie[0]));
        let mut executed = live[0].clone();
        executed.command = "ffmpeg after exec".to_owned();
        assert!(executed.running(), "a command change without zombie state still holds liveness");
        assert!(live[0].matches_birth(&executed), "known birth keeps a changed command out of the unknown group");
        assert!(!live[0].matches(&executed), "the changed command grants no signal authority");
    }

    #[test]
    fn missing_or_unreadable_identities_are_failures() {
        for text in ["", " 42 7 42 S Mon Oct 5 12:34:56 2026\n", " 42 7 42 S Mon Oct 5 unknown 2026 ffmpeg\n", "not a process table\n"] {
            assert!(parse_snapshot(text).is_err());
        }
    }
}
