//! Launch identities for an encoder and descendants observed beneath a verified process it owns.
//! Commands stay in memory. Group numbers never authorize a signal.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, Read};
use std::os::fd::AsRawFd;
use std::process::{Child, Command, Stdio};
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

    // A command `ps` could not read is no difference, so an encoder read while it exits, or a script read while its
    // shell starts, is still the recorded process. Two readable commands that differ are refused: a start reading has
    // whole seconds, and the command is what tells apart a pid reused within the same second.
    fn matches(&self, other: &Identity) -> bool {
        self.matches_birth(other)
            && (self.command == other.command
                || unreadable(&self.command)
                || unreadable(&other.command))
    }
}

// macOS `ps` prints the kernel's name for a process, at most 16 characters, in parentheses when it cannot read the
// arguments, as while the process exits or execs; procps on Linux prints it, at most 15 characters, in brackets when
// they are empty. The same rule as `unreadableCommand` in `src/shared/process-ownership.ts`.
fn unreadable(command: &str) -> bool {
    let enclosed = |open: char, close: char, limit: usize| {
        command
            .strip_prefix(open)
            .and_then(|rest| rest.strip_suffix(close))
            .is_some_and(|name| (1..=limit).contains(&name.chars().count()))
    };
    enclosed('(', ')', 16) || enclosed('[', ']', 15)
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
        match snapshot(self.root, &self.tracked_pids()) {
            Ok(processes) => self.capture_from(&processes),
            Err(error) => {
                self.initialized = true;
                vec![error]
            }
        }
    }

    fn capture_from(&mut self, processes: &[Identity]) -> Vec<String> {
        if self.retired {
            return Vec::new();
        }
        let initial = !self.initialized;
        self.initialized = true;
        if initial {
            let Some(root) = processes.iter().find(|entry| entry.pid == self.root) else {
                return vec![format!(
                    "launched encoder {} could not be recorded before it exited",
                    self.root
                )];
            };
            if root.parent != self.parent {
                return vec![format!(
                    "encoder {} was not the launched child and was left alone",
                    self.root
                )];
            }
            self.records.insert(root.pid, root.clone());
        }
        // A process recorded while its command could not be read keeps the first readable one, so a later change is seen.
        for entry in processes {
            if let Some(record) = self.records.get_mut(&entry.pid)
                && entry.running()
                && record.matches(entry)
                && unreadable(&record.command)
                && !unreadable(&entry.command)
            {
                record.command.clone_from(&entry.command);
            }
        }
        let mut owned: Vec<u32> = processes
            .iter()
            .filter(|entry| {
                entry.running()
                    && self
                        .records
                        .get(&entry.pid)
                        .is_some_and(|record| record.matches(entry))
            })
            .map(|entry| entry.pid)
            .collect();
        loop {
            let before = owned.len();
            for entry in processes {
                if !entry.running()
                    || self.records.contains_key(&entry.pid)
                    || !owned.contains(&entry.parent)
                {
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
        let leader_reused = root.is_some_and(|entry| {
            self.records
                .get(&self.root)
                .is_some_and(|record| !record.matches_birth(entry))
        });
        if !leader_reused {
            for entry in processes {
                if entry.running()
                    && entry.group == self.root
                    && !self
                        .records
                        .get(&entry.pid)
                        .is_some_and(|record| record.matches_birth(entry))
                {
                    self.unknown.insert(entry.pid, entry.clone());
                }
            }
        }
        if processes.iter().any(|entry| {
            entry.running()
                && self
                    .unknown
                    .get(&entry.pid)
                    .is_some_and(|record| record.matches_birth(entry))
        }) {
            return vec![format!(
                "encoder {} has processes whose launch ownership is unknown; they were left alone",
                self.root
            )];
        }
        // This complete snapshot proved every relevant pid absent. Retire now, before a later stop can query
        // those numbers again. Failed or unreadable discovery never reaches this decision.
        if !self.records.is_empty() && processes.is_empty() {
            self.retired = true;
        }
        Vec::new()
    }

    /// Stops the launch through `launch`, the child handle it was spawned as, and every other recorded process by pid
    /// after reading it again.
    pub fn stop(&mut self, launch: &mut Child) -> Vec<String> {
        let mut problems = self.capture();
        problems.extend(self.stop_with_launch(read_process, kill, &mut || stop_child(launch)));
        problems
    }

    // Each recorded process, newest first, is read again just before its signal and signaled only if it is still the
    // recorded process. `read` and `signal` are the host's own outside tests. Every process here is found by pid,
    // the launch too, as tests ask of the identity check.
    #[cfg(test)]
    fn stop_with(
        &mut self,
        read: impl FnMut(u32) -> Result<Vec<Identity>, String>,
        signal: impl FnMut(libc::pid_t) -> io::Result<()>,
    ) -> Vec<String> {
        self.stop_recorded(read, signal, None)
    }

    // As `stop_with`, except for the launch, which is stopped through `launch` and never looked up by pid. The launch
    // is this process's own child, not yet reaped, so its pid cannot name another process whatever its command now
    // reads as: an exec wrapper's readable command changes when it becomes the program it wraps. A process found by
    // pid keeps the identity check.
    fn stop_with_launch(
        &mut self,
        read: impl FnMut(u32) -> Result<Vec<Identity>, String>,
        signal: impl FnMut(libc::pid_t) -> io::Result<()>,
        launch: &mut dyn FnMut() -> io::Result<()>,
    ) -> Vec<String> {
        self.stop_recorded(read, signal, Some(launch))
    }

    fn stop_recorded(
        &mut self,
        mut read: impl FnMut(u32) -> Result<Vec<Identity>, String>,
        mut signal: impl FnMut(libc::pid_t) -> io::Result<()>,
        launch: Option<&mut dyn FnMut() -> io::Result<()>>,
    ) -> Vec<String> {
        if self.retired {
            return Vec::new();
        }
        let mut problems = Vec::new();
        let held = launch.is_some();
        if let Some(launch) = launch
            && let Err(error) = launch()
        {
            problems.push(format!(
                "recorded encoder process {} could not be stopped: {error}",
                self.root
            ));
        }
        let records: Vec<Identity> = self.records.values().cloned().collect();
        for record in records.iter().rev() {
            if held && record.pid == self.root {
                continue;
            }
            let processes = match read(record.pid) {
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
                problems.push(format!(
                    "recorded encoder process {} changed identity and was left alone",
                    record.pid
                ));
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
            if let Err(error) = signal(pid)
                && error.raw_os_error() != Some(libc::ESRCH)
            {
                problems.push(format!(
                    "recorded encoder process {} could not be stopped: {error}",
                    record.pid
                ));
            }
        }
        problems
    }

    pub fn remains(&mut self) -> Result<bool, String> {
        if self.retired {
            return Ok(false);
        }
        let processes = snapshot(self.root, &self.tracked_pids())?;
        if self.records.is_empty()
            && processes.iter().any(|entry| {
                entry.running() && (entry.pid == self.root || entry.group == self.root)
            })
        {
            return Err(
                "encoder launch ownership was never recorded; completion is unknown".to_owned(),
            );
        }
        let leader_reused = processes
            .iter()
            .find(|entry| entry.pid == self.root)
            .is_some_and(|entry| {
                self.records
                    .get(&self.root)
                    .is_some_and(|record| !record.matches_birth(entry))
            });
        if !leader_reused {
            for entry in &processes {
                if entry.running()
                    && entry.group == self.root
                    && !self
                        .records
                        .get(&entry.pid)
                        .is_some_and(|record| record.matches_birth(entry))
                {
                    self.unknown.insert(entry.pid, entry.clone());
                }
            }
        }
        let live = processes.iter().any(|entry| {
            entry.running()
                && (self
                    .records
                    .get(&entry.pid)
                    .is_some_and(|record| record.matches_birth(entry))
                    || self
                        .unknown
                        .get(&entry.pid)
                        .is_some_and(|record| record.matches_birth(entry)))
        });
        if !live {
            self.retired = true;
        }
        Ok(live)
    }

    fn tracked_pids(&self) -> Vec<u32> {
        self.records
            .keys()
            .chain(self.unknown.keys())
            .copied()
            .collect()
    }

    pub fn cleanup(&mut self, launch: &mut Child, limit: Duration) -> Vec<String> {
        let mut problems = self.stop(launch);
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
                    problems.push(
                        "encoder cleanup did not confirm every recorded process had stopped"
                            .to_owned(),
                    );
                    break;
                }
                Ok(true) => thread::sleep(Duration::from_millis(20)),
            }
        }
        problems
    }
}

// Stops the launch through its child handle. A launch already reaped needs nothing more.
fn stop_child(child: &mut Child) -> io::Result<()> {
    match child.kill() {
        Err(error) if error.kind() == io::ErrorKind::InvalidInput => Ok(()),
        stopped => stopped,
    }
}

fn kill(pid: libc::pid_t) -> io::Result<()> {
    // SAFETY: `stop_with` passes only a positive pid it has just checked against its recorded start and command.
    if unsafe { libc::kill(pid, libc::SIGKILL) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

// A timed-out metadata process is not killed without an observed launch identity. The caller gets an explicit
// failure and leaves it alone. Nonblocking reads keep a failed or unanswered snapshot bounded.
fn snapshot(root: u32, tracked: &[u32]) -> Result<Vec<Identity>, String> {
    // Discovery, selection and a possible re-observation share one budget. A failed query cannot multiply the
    // time spent holding an encoder's ownership lock while its watchdog needs to stop it.
    let deadline = Instant::now() + SNAPSHOT_LIMIT;
    snapshot_with(
        root,
        tracked,
        || discover_before(deadline),
        |arguments| {
            let identities = read_snapshot_before(arguments, deadline)?;
            // Inject only a snapshot selection failure, never the separate identity check before a signal.
            #[cfg(debug_assertions)]
            {
                static FAILED_ONCE: std::sync::atomic::AtomicBool =
                    std::sync::atomic::AtomicBool::new(false);
                if std::env::var_os("RETEST_MEDIA_TEST_FAIL_SELECTION_ONCE").is_some()
                    && !FAILED_ONCE.swap(true, std::sync::atomic::Ordering::AcqRel)
                {
                    return Err(
                        "RETEST_MEDIA_TEST_FAIL_SELECTION_ONCE refused one selected query"
                            .to_owned(),
                    );
                }
            }
            Ok(identities)
        },
    )
}

fn snapshot_with(
    root: u32,
    tracked: &[u32],
    mut discover: impl FnMut() -> Result<Vec<ProcessLink>, String>,
    mut read: impl FnMut(&[&str]) -> Result<Vec<Identity>, String>,
) -> Result<Vec<Identity>, String> {
    // Discover ancestry and group membership without reading unrelated applications' arguments. Every process
    // that could affect ownership is then read with its full command before capture or a signal decides anything.
    let table = discover()?;
    let related = related_pids(&table, root, tracked);
    if related.is_empty() {
        return Ok(Vec::new());
    }
    let pids = related
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    match read(&[
        "-ww",
        "-p",
        &pids,
        "-o",
        "pid=,ppid=,pgid=,stat=,lstart=,args=",
    ]) {
        Ok(processes) => Ok(processes),
        Err(error) => {
            // Selection and discovery can straddle an exit or exec. A successful fresh discovery can prove
            // absence, or select a fresh full-identity read. A failed query alone proves neither.
            let fresh = discover().map_err(|failure| {
                format!("{error}; fresh encoder discovery also failed: {failure}")
            })?;
            let related = related_pids(&fresh, root, tracked);
            if related.is_empty() {
                Ok(Vec::new())
            } else {
                // This is another observation, never another signal. Fresh full identities must still pass
                // capture_from's ancestry, birth and command checks; repeated failure grants no authority.
                let pids = related
                    .iter()
                    .map(u32::to_string)
                    .collect::<Vec<_>>()
                    .join(",");
                read(&[
                    "-ww",
                    "-p",
                    &pids,
                    "-o",
                    "pid=,ppid=,pgid=,stat=,lstart=,args=",
                ])
                .map_err(|failure| {
                    format!("{error}; fresh encoder identity query also failed: {failure}")
                })
            }
        }
    }
}

// The signal decision needs only the recorded pid's fresh full identity. Discovery still happens in capture;
// a missing selected row is absence only after a successful process-table read also finds that pid absent.
fn read_process(pid: u32) -> Result<Vec<Identity>, String> {
    let deadline = Instant::now() + SNAPSHOT_LIMIT;
    read_process_with(
        pid,
        || discover_before(deadline),
        |arguments| read_snapshot_before(arguments, deadline),
    )
}

fn read_process_with(
    pid: u32,
    mut discover: impl FnMut() -> Result<Vec<ProcessLink>, String>,
    mut read: impl FnMut(&[&str]) -> Result<Vec<Identity>, String>,
) -> Result<Vec<Identity>, String> {
    let selected = pid.to_string();
    match read(&[
        "-ww",
        "-p",
        &selected,
        "-o",
        "pid=,ppid=,pgid=,stat=,lstart=,args=",
    ]) {
        Ok(processes) => Ok(processes),
        Err(error) => {
            let table = discover().map_err(|failure| {
                format!("{error}; fresh signal identity discovery also failed: {failure}")
            })?;
            if table.iter().any(|entry| entry.pid == pid) {
                // A failed observation is no signal authority. Re-read once; stop_recorded still compares the
                // complete fresh birth and command to its recorded identity immediately before signaling.
                read(&[
                    "-ww",
                    "-p",
                    &selected,
                    "-o",
                    "pid=,ppid=,pgid=,stat=,lstart=,args=",
                ])
                .map_err(|failure| {
                    format!("{error}; fresh signal identity query also failed: {failure}")
                })
            } else {
                Ok(Vec::new())
            }
        }
    }
}

fn related_pids(processes: &[ProcessLink], root: u32, tracked: &[u32]) -> BTreeSet<u32> {
    let mut related: BTreeSet<u32> = tracked.iter().copied().chain([root]).collect();
    related.extend(
        processes
            .iter()
            .filter(|entry| entry.group == root)
            .map(|entry| entry.pid),
    );
    loop {
        let before = related.len();
        for entry in processes {
            if related.contains(&entry.parent) {
                related.insert(entry.pid);
            }
        }
        if related.len() == before {
            break;
        }
    }
    // Selection grants no ownership. Include descendants even of a mismatching root, so capture_from applies its
    // unchanged full-command identity checks and group members of unknown ancestry stay visible.
    related.retain(|pid| processes.iter().any(|entry| entry.pid == *pid));
    related
}

struct ProcessLink {
    pid: u32,
    parent: u32,
    group: u32,
}

fn discover_before(deadline: Instant) -> Result<Vec<ProcessLink>, String> {
    let text = read_metadata_before(&["-axo", "pid=,ppid=,pgid="], deadline)?;
    parse_links(&text)
}

fn parse_links(text: &str) -> Result<Vec<ProcessLink>, String> {
    let invalid = || "the host returned unreadable encoder process links".to_owned();
    let mut links = Vec::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let mut fields = line.split_whitespace();
        let mut next = || {
            fields
                .next()
                .ok_or_else(invalid)?
                .parse::<u32>()
                .map_err(|_| invalid())
        };
        let entry = ProcessLink {
            pid: next()?,
            parent: next()?,
            group: next()?,
        };
        if fields.next().is_some() {
            return Err(invalid());
        }
        links.push(entry);
    }
    if links.is_empty() {
        return Err(invalid());
    }
    Ok(links)
}

fn read_snapshot_before(arguments: &[&str], deadline: Instant) -> Result<Vec<Identity>, String> {
    parse_snapshot(&read_metadata_before(arguments, deadline)?)
}

fn read_metadata_before(arguments: &[&str], deadline: Instant) -> Result<String, String> {
    if Instant::now() >= deadline {
        return Err(
            "encoder ownership query had no observation budget left; completion is unknown"
                .to_owned(),
        );
    }
    let mut child = Command::new("/bin/ps")
        .args(arguments)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LC_ALL", "C")
        .env("TZ", "UTC0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("encoder ownership could not be read: {error}"))?;
    let mut output = child
        .stdout
        .take()
        .ok_or_else(|| "encoder ownership output was unavailable".to_owned())?;
    let fd = output.as_raw_fd();
    // SAFETY: the live pipe owns fd, and fcntl changes only its file status flags.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags == -1 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1 {
        return Err("encoder ownership output could not be made bounded".to_owned());
    }
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut eof = false;
    let status = loop {
        loop {
            if Instant::now() >= deadline {
                return Err(
                    "encoder ownership query did not answer; its completion is unknown".to_owned(),
                );
            }
            match output.read(&mut chunk) {
                Ok(0) => {
                    eof = true;
                    break;
                }
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
        if Instant::now() >= deadline {
            return Err(
                "encoder ownership query did not answer; its completion is unknown".to_owned(),
            );
        }
        thread::sleep(Duration::from_millis(5));
    };
    if !status.success() {
        let query = arguments.join(" ");
        let query = if query.len() <= 1024 {
            query
        } else {
            format!(
                "{}... [{} bytes of query arguments]",
                query.chars().take(1024).collect::<String>(),
                query.len()
            )
        };
        return Err(format!(
            "encoder ownership query failed with {status}: ps {query}"
        ));
    }
    String::from_utf8(bytes).map_err(|_| "encoder ownership output was unreadable".to_owned())
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
        if command.is_empty()
            || fields[4].len() != 3
            || fields[5].len() != 3
            || !fields[4].bytes().all(|byte| byte.is_ascii_alphabetic())
            || !fields[5].bytes().all(|byte| byte.is_ascii_alphabetic())
            || fields[6].parse::<u32>().is_err()
            || fields[8].len() != 4
            || fields[8].parse::<u32>().is_err()
            || fields[7].len() != 8
            || fields[7].bytes().enumerate().any(|(index, byte)| {
                if index == 2 || index == 5 {
                    byte != b':'
                } else {
                    !byte.is_ascii_digit()
                }
            })
        {
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
    fn process_start_is_utc_even_for_a_child_started_in_another_zone() {
        let mut child = Command::new("/bin/sleep")
            .arg("60")
            .env("TZ", "Etc/GMT+12")
            .spawn()
            .expect("start the recorded child");
        let pid = child.id();
        let reference = Command::new("/bin/ps")
            .args(["-o", "lstart=", "-p", &pid.to_string()])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("LC_ALL", "C")
            .env("TZ", "UTC0")
            .output()
            .expect("read the UTC reference");
        let table = snapshot(pid, &[]);
        let individual = read_process(pid);
        child.kill().expect("end only the recorded child");
        child.wait().expect("reap the recorded child");
        assert!(reference.status.success());
        let expected = String::from_utf8(reference.stdout)
            .expect("ps text")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        for reading in [table, individual] {
            let processes = reading.expect("read the real process identity");
            let identity = processes
                .iter()
                .find(|entry| entry.pid == pid)
                .expect("the recorded child");
            assert_eq!(identity.started, expected);
        }
    }

    #[test]
    fn command_spacing_is_part_of_the_signal_identity() {
        let entries =
            parse_snapshot(" 42 7 42 S Mon Oct  5 12:34:56 2026 ffmpeg  output.partial\n")
                .expect("a complete identity");
        assert_eq!(entries[0].command, "ffmpeg  output.partial");
        let mut changed = entries[0].clone();
        changed.command = "ffmpeg output.partial".to_owned();
        assert!(!entries[0].matches(&changed));
        assert!(
            entries[0].matches_birth(&changed),
            "exec or command changes do not prove a process has exited"
        );
        changed.started = "Mon Oct 5 12:35:00 2026".to_owned();
        assert!(!entries[0].matches_birth(&changed));
    }

    #[test]
    fn zombies_have_exited_even_when_ps_changes_their_command() {
        let live = parse_snapshot(" 42 7 42 S Mon Oct 5 12:34:56 2026 ffmpeg output.partial\n")
            .expect("a live process");
        let zombie = parse_snapshot(" 42 7 42 Z+ Mon Oct 5 12:34:56 2026 (ffmpeg)\n")
            .expect("an observed zombie");
        assert!(live[0].running());
        assert!(!zombie[0].running());
        assert!(live[0].matches_birth(&zombie[0]));
        assert!(
            live[0].matches(&zombie[0]),
            "an unreadable command is no difference; the zombie state alone keeps it from a signal"
        );
        let mut executed = live[0].clone();
        executed.command = "ffmpeg after exec".to_owned();
        assert!(
            executed.running(),
            "a command change without zombie state still holds liveness"
        );
        assert!(
            live[0].matches_birth(&executed),
            "known birth keeps a changed command out of the unknown group"
        );
        assert!(
            !live[0].matches(&executed),
            "the changed command grants no signal authority"
        );
    }

    fn identity(pid: u32, parent: u32, state: &str, command: &str) -> Identity {
        Identity {
            pid,
            parent,
            group: 42,
            state: state.to_owned(),
            started: "Mon Oct 5 12:34:56 2026".to_owned(),
            command: command.to_owned(),
        }
    }

    #[test]
    fn metadata_selection_keeps_every_relevant_process_without_claiming_it() {
        let root = identity(42, std::process::id(), "S", "changed root command");
        let mut child = identity(43, 42, "S", "child");
        child.group = 43;
        let mut descendant = identity(44, 43, "S", "descendant");
        descendant.group = 43;
        let unknown = identity(45, 1, "S", "unknown group member");
        let mut tracked = identity(46, 1, "S", "reparented recorded process");
        tracked.group = 46;
        let mut unrelated = identity(47, 1, "S", "unrelated");
        unrelated.group = 47;
        let identities = [root, child, descendant, unknown, tracked, unrelated];
        let table: Vec<ProcessLink> = identities
            .iter()
            .map(|entry| ProcessLink {
                pid: entry.pid,
                parent: entry.parent,
                group: entry.group,
            })
            .collect();
        assert_eq!(
            related_pids(&table, 42, &[46]),
            BTreeSet::from([42, 43, 44, 45, 46])
        );
        assert!(
            related_pids(&table[5..], 42, &[46]).is_empty(),
            "a fresh complete discovery can prove absence"
        );
        let mut ownership = Ownership::new(42);
        let original = identity(42, std::process::id(), "S", "original command");
        assert!(ownership.capture_from(&[original]).is_empty());
        assert!(
            !ownership.capture_from(&identities[..4]).is_empty(),
            "a changed root still grants no descendant signal authority"
        );
        assert!(!ownership.records.contains_key(&43));
        assert!(ownership.unknown.contains_key(&45));
    }

    #[test]
    fn unreadable_discovery_never_proves_absence() {
        for text in ["", "42 7", "42 7 bad", "42 7 42 extra"] {
            assert!(parse_links(text).is_err(), "{text}");
        }
        let links = parse_links("42 7 42\n43 42 43\n").expect("complete links");
        assert_eq!(related_pids(&links, 42, &[]), BTreeSet::from([42, 43]));
    }

    const ENCODER: &str = "ffmpeg -f rawvideo -i - -c:v libx264 /tmp/r.mp4.partial";

    #[test]
    fn a_failed_signal_identity_query_is_reobserved_before_any_signal() {
        let mut reads = 0;
        let result = read_process_with(
            42,
            || {
                Ok(vec![ProcessLink {
                    pid: 42,
                    parent: std::process::id(),
                    group: 42,
                }])
            },
            |arguments| {
                assert_eq!(arguments[2], "42");
                reads += 1;
                if reads == 1 {
                    Err("selected query exited with SIGTRAP".to_owned())
                } else {
                    Ok(vec![identity(42, std::process::id(), "S", ENCODER)])
                }
            },
        )
        .expect("one successful fresh identity reconciles the failed observation");
        assert_eq!(reads, 2);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].command, ENCODER);
    }

    #[test]
    fn repeated_signal_identity_query_failure_preserves_both_reasons() {
        let mut reads = 0;
        let failure = read_process_with(
            42,
            || {
                Ok(vec![ProcessLink {
                    pid: 42,
                    parent: std::process::id(),
                    group: 42,
                }])
            },
            |_| {
                reads += 1;
                Err(format!("selected signal query failure {reads}"))
            },
        )
        .err()
        .expect("failed observations supply no signal identity");
        assert_eq!(reads, 2);
        assert!(
            failure.contains("selected signal query failure 1"),
            "{failure}"
        );
        assert!(
            failure.contains("selected signal query failure 2"),
            "{failure}"
        );
    }

    #[test]
    fn failed_signal_discovery_preserves_the_selected_query_failure() {
        let failure = read_process_with(
            42,
            || Err("signal discovery failed".to_owned()),
            |_| Err("selected signal query failed".to_owned()),
        )
        .err()
        .expect("failed discovery proves no absence");
        assert!(
            failure.contains("selected signal query failed"),
            "{failure}"
        );
        assert!(failure.contains("signal discovery failed"), "{failure}");
    }

    #[test]
    fn a_failed_selection_is_reconciled_by_fresh_full_identities() {
        let mut reads = 0;
        let result = snapshot_with(
            42,
            &[],
            || {
                Ok(vec![ProcessLink {
                    pid: 42,
                    parent: std::process::id(),
                    group: 42,
                }])
            },
            |arguments| {
                assert_eq!(arguments[2], "42");
                reads += 1;
                if reads == 1 {
                    Err("first selected ps query failed".to_owned())
                } else {
                    Ok(vec![identity(42, std::process::id(), "S", ENCODER)])
                }
            },
        )
        .expect("a fresh complete identity reconciles a transient observation failure");
        assert_eq!(
            reads, 2,
            "one bounded re-observation, not an unbounded retry"
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].command, ENCODER);
    }

    #[test]
    fn repeated_selection_failure_preserves_both_errors_and_no_identity() {
        let mut reads = 0;
        let result = snapshot_with(
            42,
            &[],
            || {
                Ok(vec![ProcessLink {
                    pid: 42,
                    parent: std::process::id(),
                    group: 42,
                }])
            },
            |_| {
                reads += 1;
                Err(format!("selected query failure {reads}"))
            },
        )
        .err()
        .expect("a repeated failed observation cannot authorize any signal");
        assert_eq!(reads, 2);
        assert!(result.contains("selected query failure 1"), "{result}");
        assert!(result.contains("selected query failure 2"), "{result}");
    }

    #[test]
    fn failed_discovery_after_selection_failure_never_proves_absence() {
        let mut discoveries = 0;
        let result = snapshot_with(
            42,
            &[],
            || {
                discoveries += 1;
                if discoveries == 1 {
                    Ok(vec![ProcessLink {
                        pid: 42,
                        parent: std::process::id(),
                        group: 42,
                    }])
                } else {
                    Err("fresh discovery failed".to_owned())
                }
            },
            |_| Err("selected query failed".to_owned()),
        );
        let failure = result
            .err()
            .expect("failed discovery grants no absence or identity");
        assert!(failure.contains("selected query failed"), "{failure}");
        assert!(failure.contains("fresh discovery failed"), "{failure}");
    }

    #[test]
    fn confirmed_absence_retires_the_owner_before_another_signal() {
        let mut ownership = Ownership::new(42);
        assert!(
            ownership
                .capture_from(&[identity(42, std::process::id(), "S", ENCODER)])
                .is_empty()
        );
        assert!(ownership.capture_from(&[]).is_empty());
        assert!(ownership.retired);
        let problems = ownership.stop_with(
            |_| panic!("a retired owner must not read the pid again"),
            |_| panic!("a retired owner must not signal the pid again"),
        );
        assert!(problems.is_empty());
    }

    #[test]
    fn an_encoder_read_while_exiting_is_the_same_process_and_is_stopped() {
        let recorded = identity(42, std::process::id(), "S", ENCODER);
        for state in ["S", "R", "U", "?E"] {
            let mut ownership = Ownership::new(42);
            assert!(
                ownership
                    .capture_from(std::slice::from_ref(&recorded))
                    .is_empty()
            );
            let exiting = Identity {
                state: state.to_owned(),
                command: "(ffmpeg)".to_owned(),
                ..recorded.clone()
            };
            let mut signaled = Vec::new();
            let problems = ownership.stop_with(
                |_| Ok(vec![exiting.clone()]),
                |pid| {
                    signaled.push(pid);
                    Ok(())
                },
            );
            assert!(problems.is_empty(), "host state {state}: {problems:?}");
            assert_eq!(signaled, vec![42], "host state {state}");
        }
    }

    #[test]
    fn another_process_at_the_recorded_pid_is_still_refused() {
        let recorded = identity(42, std::process::id(), "S", ENCODER);
        let readable = Identity {
            command: "/usr/bin/another-tool --serve".to_owned(),
            ..recorded.clone()
        };
        let reborn = Identity {
            started: "Mon Oct 5 12:34:57 2026".to_owned(),
            command: "(ffmpeg)".to_owned(),
            ..recorded.clone()
        };
        let long_name = Identity {
            command: "(ffmpeg with a long name)".to_owned(),
            ..recorded.clone()
        };
        for current in [readable, reborn, long_name] {
            let mut ownership = Ownership::new(42);
            assert!(
                ownership
                    .capture_from(std::slice::from_ref(&recorded))
                    .is_empty()
            );
            let mut signaled = Vec::new();
            let problems = ownership.stop_with(
                |_| Ok(vec![current.clone()]),
                |pid| {
                    signaled.push(pid);
                    Ok(())
                },
            );
            assert_eq!(
                problems,
                vec!["recorded encoder process 42 changed identity and was left alone".to_owned()],
                "{}",
                current.command
            );
            assert!(signaled.is_empty(), "{}", current.command);
        }
    }

    #[test]
    fn the_launch_is_stopped_through_its_handle_whatever_its_command_reads_and_others_keep_the_check()
     {
        let me = std::process::id();
        let launch = identity(42, me, "S", "/bin/sh /tmp/ffmpeg-wrapper -i pipe:0");
        let child = identity(43, 42, "S", "/bin/sh /tmp/ffmpeg-wrapper -i pipe:0");
        let mut ownership = Ownership::new(42);
        assert!(
            ownership
                .capture_from(&[launch.clone(), child.clone()])
                .is_empty()
        );
        // Both now read as other programs: the launch became what it wraps, and the child was replaced.
        let launch_now = Identity {
            command: "sleep 600".to_owned(),
            ..launch
        };
        let child_now = Identity {
            command: "/usr/bin/another-tool".to_owned(),
            ..child
        };
        let mut stopped_by_handle = 0;
        let mut signaled = Vec::new();
        let problems = ownership.stop_with_launch(
            |pid| {
                Ok(vec![if pid == 42 {
                    launch_now.clone()
                } else {
                    child_now.clone()
                }])
            },
            |pid| {
                signaled.push(pid);
                Ok(())
            },
            &mut || {
                stopped_by_handle += 1;
                Ok(())
            },
        );
        assert_eq!(
            stopped_by_handle, 1,
            "the launch is stopped through its handle"
        );
        assert!(
            signaled.is_empty(),
            "nothing is signaled by pid: {signaled:?}"
        );
        assert_eq!(
            problems,
            vec!["recorded encoder process 43 changed identity and was left alone".to_owned()]
        );
    }

    #[test]
    fn a_launch_recorded_before_its_command_could_be_read_still_owns_its_children() {
        let me = std::process::id();
        let mut ownership = Ownership::new(42);
        assert!(
            ownership
                .capture_from(&[identity(42, me, "R", "(sh)")])
                .is_empty()
        );
        let wrapper = identity(42, me, "S", "/bin/sh /tmp/forking-ffmpeg -encoders");
        let child = identity(43, 42, "S", "/bin/sh /tmp/fake-ffmpeg -encoders");
        assert!(
            ownership
                .capture_from(&[wrapper.clone(), child.clone()])
                .is_empty(),
            "the child of a recorded launch is recorded, not unknown"
        );
        assert_eq!(
            ownership.records[&42].command, wrapper.command,
            "the first readable command replaces the unreadable record"
        );
        let changed = Identity {
            command: "/usr/bin/another-tool".to_owned(),
            ..wrapper.clone()
        };
        let mut signaled = Vec::new();
        let problems = ownership.stop_with(
            |_| Ok(vec![changed.clone(), child.clone()]),
            |pid| {
                signaled.push(pid);
                Ok(())
            },
        );
        assert_eq!(signaled, vec![43], "the recorded child is stopped");
        assert_eq!(
            problems,
            vec!["recorded encoder process 42 changed identity and was left alone".to_owned()],
            "a later readable change is still refused"
        );
    }

    #[test]
    fn only_the_kernel_name_shape_reads_as_unreadable() {
        for command in ["(ffmpeg)", "(Google Chrome fo)", "[kworker/0:1]", "(sh)"] {
            assert!(unreadable(command), "{command}");
        }
        for command in [
            "ffmpeg",
            "(ffmpeg) -i -",
            "()",
            "(Google Chrome for)",
            "[a name sixteen ch]",
            "<defunct>",
        ] {
            assert!(!unreadable(command), "{command}");
        }
    }

    #[test]
    fn missing_or_unreadable_identities_are_failures() {
        for text in [
            "",
            " 42 7 42 S Mon Oct 5 12:34:56 2026\n",
            " 42 7 42 S Mon Oct 5 unknown 2026 ffmpeg\n",
            "not a process table\n",
        ] {
            assert!(parse_snapshot(text).is_err());
        }
    }
}
