//! Launch identities for an encoder and every process beneath it, on Windows.
//!
//! Windows has no `ps`, no process groups and no signals. The encoder is created suspended, put in a job object of its
//! own and only then let run, so it and everything it starts are in that job from birth, whatever becomes of their
//! parents: the job is the witness Unix has in the process group, and its member list is what remains. A member is
//! opened, checked to be in the job through its own handle, and recorded with its creation time and executable path.
//! The handle is kept: no other process can take a pid while a handle on its process is open, so the process verified
//! is the process ended. A member that can be read but not ended, or not read at all, is unknown: it is never ended,
//! it is named in the problem by pid and executable, and while it runs the job, and so cleanup, is unconfirmed.
//!
//! The job does not end its members when its handle closes. Like an encoder on Unix, one whose media process dies is
//! left to finish its file once its input closes, and what is left is for the runner that holds the media process to
//! end. Image paths stay in memory; problems name only the executable's file name.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::io;
use std::mem::offset_of;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use std::process::Child;
use std::thread;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_BAD_LENGTH, ERROR_INVALID_PARAMETER, ERROR_MORE_DATA, FILETIME,
    HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
    TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JOBOBJECT_BASIC_PROCESS_ID_LIST,
    JobObjectBasicProcessIdList, QueryInformationJobObject,
};
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, OpenThread, PROCESS_ACCESS_RIGHTS, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    QueryFullProcessImageNameW, ResumeThread, THREAD_SUSPEND_RESUME, TerminateProcess,
    WaitForSingleObject,
};

/// The exit code of a process ended here: the code `Child::kill` gives the launch.
const ENDED_EXIT_CODE: u32 = 1;
/// How often a snapshot that failed with `ERROR_BAD_LENGTH`, as one taken while processes start can, is taken again.
const SNAPSHOT_ATTEMPTS: usize = 5;
/// The longest image path Windows writes, in UTF-16 units.
const IMAGE_UNITS: usize = 32 * 1024;
/// How long a process that refuses TerminateProcess because it is already exiting gets to finish exiting.
const EXITING_WAIT_MS: u32 = 1000;
/// The most members a job's list is read for; a longer list fails the reading rather than growing without bound.
const MAX_MEMBERS: usize = 64 * 1024;

/// What tells one process from another that later has its pid.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Birth {
    /// When the process was created, in 100 ns intervals since 1601.
    created: u64,
    /// The executable, or `None` when it could not be read.
    image: Option<OsString>,
}

impl Birth {
    // An image path that could not be read is no difference; two readable paths that differ are refused.
    fn matches(&self, other: &Birth) -> bool {
        self.created == other.created
            && (self.image == other.image || self.image.is_none() || other.image.is_none())
    }

    // The executable's file name, for a problem that names a process.
    fn name(&self) -> String {
        self.image
            .as_deref()
            .and_then(|image| Path::new(image).file_name())
            .map_or_else(
                || "an unreadable executable".to_owned(),
                |name| name.to_string_lossy().into_owned(),
            )
    }
}

/// How far a pid the job lists could be opened.
pub enum Opened<P> {
    /// In the job, opened for reading, waiting and ending.
    Endable(P, Birth),
    /// In the job, and readable only: it can be named, never ended.
    Readable(Birth),
    /// Not in the job: it has gone, and the pid names no process or another one.
    Elsewhere,
    /// Not readable at all, named by the executable a process snapshot gives for the pid when it gives one.
    Unreadable(Option<String>),
}

/// What the host can read and do. `System` is Windows itself; tests stand in for it.
pub trait Host {
    /// A process opened for reading, waiting and ending, holding its pid while it is kept.
    type Process;
    /// The job a launch was born in.
    type Job;
    fn members(&self, job: &Self::Job) -> Result<Vec<u32>, String>;
    fn open(&self, pid: u32, job: &Self::Job) -> Opened<Self::Process>;
    fn birth(&self, process: &Self::Process) -> Result<Birth, String>;
    fn running(&self, process: &Self::Process) -> Result<bool, String>;
    fn in_job(&self, process: &Self::Process, job: &Self::Job) -> Result<bool, String>;
    fn terminate(&self, process: &Self::Process) -> io::Result<()>;
}

struct Record<P> {
    birth: Birth,
    process: P,
}

pub struct Ownership<H: Host = System> {
    host: H,
    job: H::Job,
    root: u32,
    records: BTreeMap<u32, Record<H::Process>>,
    initialized: bool,
    retired: bool,
}

impl Ownership {
    /// Puts a launch created suspended in a job of its own, then lets it run. A launch that cannot be held is the
    /// caller's to end through its handle; it never ran.
    pub fn hold(launch: &mut Child) -> io::Result<Self> {
        let failed = |what: &str| {
            let error = io::Error::last_os_error();
            io::Error::new(
                error.kind(),
                format!("the encoder could not be {what}: {error}"),
            )
        };
        // SAFETY: CreateJobObjectW with no attributes and no name returns a new, uninheritable handle, or null.
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err(failed("given a job of its own"));
        }
        // SAFETY: the handle is valid and owned by nothing else.
        let job = Job(unsafe { OwnedHandle::from_raw_handle(job) });
        // SAFETY: both handles are live: the job's, and the launch's own, which `Child` holds.
        if unsafe { AssignProcessToJobObject(job.handle(), launch.as_raw_handle()) } == 0 {
            return Err(failed("put in its job"));
        }
        resume(launch.id()).map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("the encoder could not be let run in its job: {error}"),
            )
        })?;
        Ok(Self::on(System, job, launch.id()))
    }
}

impl<H: Host> Ownership<H> {
    fn on(host: H, job: H::Job, root: u32) -> Self {
        Self {
            host,
            job,
            root,
            records: BTreeMap::new(),
            initialized: false,
            retired: false,
        }
    }

    /// Records every member of the job not yet recorded. Membership is proved through each process's own handle, so a
    /// pid listed and since given to another process is never taken for the member it was. No age is compared: a
    /// process can enter the job only by being born in it, and a creation time cannot order a parent and a child
    /// started within the same tick of the clock that stamps it.
    pub fn capture(&mut self) -> Vec<String> {
        if self.retired {
            return Vec::new();
        }
        let initial = !self.initialized;
        self.initialized = true;
        let mut candidates: BTreeSet<u32> = match self.host.members(&self.job) {
            Ok(members) => members.into_iter().collect(),
            Err(error) => return vec![error],
        };
        // The launch is this process's own child, not yet reaped, so its pid names it even once the job no longer
        // lists it.
        if initial {
            candidates.insert(self.root);
        }
        let mut unknown = Vec::new();
        for pid in candidates {
            if self.records.contains_key(&pid) {
                continue;
            }
            match self.host.open(pid, &self.job) {
                Opened::Endable(process, birth) => {
                    self.records.insert(pid, Record { birth, process });
                }
                Opened::Readable(birth) => unknown.push(format!("{pid} {}", birth.name())),
                Opened::Unreadable(name) => unknown.push(format!(
                    "{pid} {}",
                    name.unwrap_or_else(|| "an unreadable executable".to_owned())
                )),
                Opened::Elsewhere => {}
            }
        }
        if initial && !self.records.contains_key(&self.root) {
            return vec![format!(
                "launched encoder {} could not be recorded before it exited",
                self.root
            )];
        }
        if !unknown.is_empty() {
            return vec![format!(
                "encoder {} has processes whose launch ownership is unknown; they were left alone: {}",
                self.root,
                unknown.join(", ")
            )];
        }
        Vec::new()
    }

    /// Stops the launch through `launch`, the child handle it was spawned as, and every other recorded process
    /// through the handle kept with it, after reading it again.
    pub fn stop(&mut self, launch: &mut Child) -> Vec<String> {
        let mut problems = self.capture();
        problems.extend(self.stop_with_launch(&mut || stop_child(launch)));
        problems
    }

    // Each recorded process, newest first, is read again just before it is ended and ended only while it runs as the
    // recorded process and is still in the job. The launch is ended through its own child handle.
    fn stop_with_launch(&mut self, launch: &mut dyn FnMut() -> io::Result<()>) -> Vec<String> {
        if self.retired {
            return Vec::new();
        }
        let mut problems = Vec::new();
        if let Err(error) = launch() {
            problems.push(format!(
                "recorded encoder process {} could not be stopped: {error}",
                self.root
            ));
        }
        let mut newest_first: Vec<(&u32, &Record<H::Process>)> = self.records.iter().collect();
        newest_first.sort_by(|(_, one), (_, other)| other.birth.created.cmp(&one.birth.created));
        for (&pid, record) in newest_first {
            if pid == self.root {
                continue;
            }
            match self.host.running(&record.process) {
                Ok(true) => {}
                Ok(false) => continue,
                Err(error) => {
                    problems.push(error);
                    break;
                }
            }
            let same = self.host.birth(&record.process).and_then(|birth| {
                self.host
                    .in_job(&record.process, &self.job)
                    .map(|in_job| in_job && record.birth.matches(&birth))
            });
            match same {
                Ok(true) => {}
                Ok(false) => {
                    problems.push(format!(
                        "recorded encoder process {pid} changed identity and was left alone"
                    ));
                    continue;
                }
                Err(error) => {
                    problems.push(error);
                    break;
                }
            }
            if let Err(error) = self.host.terminate(&record.process) {
                problems.push(format!(
                    "recorded encoder process {pid} could not be stopped: {error}"
                ));
            }
        }
        problems
    }

    /// Whether anything of the launch still runs: a member of its job that is not a recorded process seen to have
    /// exited. A member this owner never recorded, readable or not, counts as running.
    pub fn remains(&mut self) -> Result<bool, String> {
        if self.retired {
            return Ok(false);
        }
        let members = self.host.members(&self.job)?;
        if self.records.is_empty() && !members.is_empty() {
            return Err(
                "encoder launch ownership was never recorded; completion is unknown".to_owned(),
            );
        }
        let mut live = false;
        for pid in members {
            live |= match self.records.get(&pid) {
                Some(record) => self.host.running(&record.process)?,
                None => true,
            };
        }
        if !live {
            self.retired = true;
        }
        Ok(live)
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

// Stops the launch through its child handle. `Child::kill` already treats a launch that has exited as stopped.
fn stop_child(child: &mut Child) -> io::Result<()> {
    child.kill()
}

/// Windows itself.
pub struct System;

/// A process handle opened to read the process's identity, wait for it and end it.
pub struct Process(OwnedHandle);

impl Process {
    fn handle(&self) -> HANDLE {
        self.0.as_raw_handle()
    }
}

/// The job a launch was born in. Nothing else holds its handle, and closing it ends no member.
pub struct Job(OwnedHandle);

impl Job {
    fn handle(&self) -> HANDLE {
        self.0.as_raw_handle()
    }
}

impl Host for System {
    type Process = Process;
    type Job = Job;

    fn members(&self, job: &Job) -> Result<Vec<u32>, String> {
        let header = offset_of!(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList);
        let mut capacity = 64;
        loop {
            // The list is read into words, so its header and its pid words are aligned as the structure needs.
            let words = header.div_ceil(size_of::<usize>()) + capacity;
            let mut buffer = vec![0usize; words];
            let bytes = u32::try_from(words * size_of::<usize>()).unwrap_or(u32::MAX);
            // SAFETY: the buffer holds `bytes` writable bytes, aligned for the structure, for the call to fill.
            let read = unsafe {
                QueryInformationJobObject(
                    job.handle(),
                    JobObjectBasicProcessIdList,
                    buffer.as_mut_ptr().cast(),
                    bytes,
                    std::ptr::null_mut(),
                )
            };
            let error = io::Error::last_os_error();
            // SAFETY: the buffer starts with the structure's two counts, which the call wrote or left zero.
            let list = unsafe { &*buffer.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>() };
            if read != 0 {
                let count = (list.NumberOfProcessIdsInList as usize).min(capacity);
                // SAFETY: `count` pids follow the header inside the buffer, as the call wrote them.
                let pids = unsafe {
                    std::slice::from_raw_parts(
                        buffer.as_ptr().cast::<u8>().add(header).cast::<usize>(),
                        count,
                    )
                };
                return Ok(pids.iter().map(|&pid| pid as u32).collect());
            }
            if error.raw_os_error() == Some(ERROR_MORE_DATA as i32) && capacity < MAX_MEMBERS {
                capacity = (capacity * 2).max(list.NumberOfAssignedProcesses as usize + 8);
                continue;
            }
            return Err(format!("the encoder's job could not be read: {error}"));
        }
    }

    fn open(&self, pid: u32, job: &Job) -> Opened<Process> {
        let full = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE;
        let (process, endable) = match open_process(pid, full) {
            Ok(process) => (process, true),
            Err(_) => match open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION) {
                Ok(process) => (process, false),
                // No process has the pid now: the member has gone since the list was read.
                Err(error) if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) => {
                    return Opened::Elsewhere;
                }
                Err(_) => return Opened::Unreadable(snapshot_name(pid)),
            },
        };
        match (self.in_job(&process, job), self.birth(&process)) {
            (Ok(false), _) => Opened::Elsewhere,
            (Ok(true), Ok(birth)) if endable => Opened::Endable(process, birth),
            (Ok(true), Ok(birth)) => Opened::Readable(birth),
            _ => Opened::Unreadable(snapshot_name(pid)),
        }
    }

    fn birth(&self, process: &Process) -> Result<Birth, String> {
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        // SAFETY: the handle is live and has PROCESS_QUERY_LIMITED_INFORMATION; the four times are written in place.
        let read = unsafe {
            GetProcessTimes(
                process.handle(),
                &mut created,
                &mut exited,
                &mut kernel,
                &mut user,
            )
        };
        if read == 0 {
            return Err(format!(
                "an encoder process's creation time could not be read: {}",
                io::Error::last_os_error()
            ));
        }
        let mut image = vec![0u16; IMAGE_UNITS];
        let mut length = IMAGE_UNITS as u32;
        // SAFETY: the buffer holds `length` UTF-16 units, and the call writes at most that many and the new length.
        let named = unsafe {
            QueryFullProcessImageNameW(
                process.handle(),
                PROCESS_NAME_WIN32,
                image.as_mut_ptr(),
                &mut length,
            )
        };
        Ok(Birth {
            created: (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime),
            image: (named != 0)
                .then(|| OsString::from_wide(&image[..(length as usize).min(IMAGE_UNITS)])),
        })
    }

    fn running(&self, process: &Process) -> Result<bool, String> {
        // SAFETY: the handle is live and has SYNCHRONIZE; a zero timeout only reads whether the process has exited.
        match unsafe { WaitForSingleObject(process.handle(), 0) } {
            WAIT_TIMEOUT => Ok(true),
            WAIT_OBJECT_0 => Ok(false),
            _ => Err(format!(
                "an encoder process's exit could not be read: {}",
                io::Error::last_os_error()
            )),
        }
    }

    fn in_job(&self, process: &Process, job: &Job) -> Result<bool, String> {
        let mut result = 0;
        // SAFETY: both handles are live; the process handle has PROCESS_QUERY_LIMITED_INFORMATION.
        if unsafe { IsProcessInJob(process.handle(), job.handle(), &mut result) } == 0 {
            return Err(format!(
                "an encoder process's job could not be read: {}",
                io::Error::last_os_error()
            ));
        }
        Ok(result != 0)
    }

    fn terminate(&self, process: &Process) -> io::Result<()> {
        // SAFETY: the handle is live and has PROCESS_TERMINATE; it names only the process verified through it.
        if unsafe { TerminateProcess(process.handle(), ENDED_EXIT_CODE) } != 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        // A process that has exited, or is exiting, answers TerminateProcess with ERROR_ACCESS_DENIED, as a
        // console host does whose last program has just ended. It is stopped once it has exited.
        if error.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32)
            // SAFETY: the handle is live and has SYNCHRONIZE; the wait only reads whether the process has exited.
            && unsafe { WaitForSingleObject(process.handle(), EXITING_WAIT_MS) } == WAIT_OBJECT_0
        {
            return Ok(());
        }
        Err(error)
    }
}

fn open_process(pid: u32, access: PROCESS_ACCESS_RIGHTS) -> io::Result<Process> {
    // SAFETY: OpenProcess takes plain values and returns a new handle, or null when the process cannot be opened.
    let handle = unsafe { OpenProcess(access, 0, pid) };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a non-null handle from OpenProcess is valid and owned by nothing else.
    Ok(Process(unsafe { OwnedHandle::from_raw_handle(handle) }))
}

// Lets a launch created suspended run: its one thread, found in a thread snapshot by its process, is resumed.
fn resume(pid: u32) -> io::Result<()> {
    let snapshot = snapshot(TH32CS_SNAPTHREAD)?;
    let mut entry = THREADENTRY32 {
        dwSize: size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    let mut resumed = 0;
    // SAFETY: the entry's size is set, and the snapshot handle is live for every call.
    let mut listed = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) } != 0;
    while listed {
        if entry.th32OwnerProcessID == pid {
            // SAFETY: OpenThread takes plain values and returns a new handle, or null.
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if thread.is_null() {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: the handle is valid and owned by nothing else.
            let thread = unsafe { OwnedHandle::from_raw_handle(thread) };
            // SAFETY: the handle is live and has THREAD_SUSPEND_RESUME.
            if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
                return Err(io::Error::last_os_error());
            }
            resumed += 1;
        }
        // SAFETY: as above.
        listed = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) } != 0;
    }
    if resumed == 0 {
        return Err(io::Error::other("its suspended thread was not found"));
    }
    Ok(())
}

// What a process snapshot calls the executable of `pid`, for naming a process that cannot be opened.
fn snapshot_name(pid: u32) -> Option<String> {
    let snapshot = snapshot(TH32CS_SNAPPROCESS).ok()?;
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    // SAFETY: the entry's size is set, and the snapshot handle is live for every call.
    let mut listed = unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) } != 0;
    while listed {
        if entry.th32ProcessID == pid {
            let length = entry
                .szExeFile
                .iter()
                .position(|&unit| unit == 0)
                .unwrap_or(entry.szExeFile.len());
            return Some(String::from_utf16_lossy(&entry.szExeFile[..length]));
        }
        // SAFETY: as above.
        listed = unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) } != 0;
    }
    None
}

// A Toolhelp snapshot, taken again when it fails with ERROR_BAD_LENGTH, as one taken while processes start can.
fn snapshot(kind: u32) -> io::Result<OwnedHandle> {
    let mut attempt = 1;
    loop {
        // SAFETY: CreateToolhelp32Snapshot takes plain values and returns a new handle or INVALID_HANDLE_VALUE.
        let snapshot = unsafe { CreateToolhelp32Snapshot(kind, 0) };
        if snapshot != INVALID_HANDLE_VALUE {
            // SAFETY: the snapshot handle is valid and owned by nothing else.
            return Ok(unsafe { OwnedHandle::from_raw_handle(snapshot) });
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(ERROR_BAD_LENGTH as i32) || attempt == SNAPSHOT_ATTEMPTS {
            return Err(error);
        }
        attempt += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use windows_sys::Win32::System::Threading::CREATE_SUSPENDED;

    #[derive(Clone)]
    struct Fake {
        pid: u32,
        created: u64,
        image: &'static str,
        running: bool,
        /// Listed among the job's members.
        listed: bool,
        /// In the job, as its own handle tells.
        in_job: bool,
        endable: bool,
        readable: bool,
    }

    fn fake(pid: u32, created: u64) -> Fake {
        Fake {
            pid,
            created,
            image: "C:\\ffmpeg\\bin\\ffmpeg.exe",
            running: true,
            listed: true,
            in_job: true,
            endable: true,
            readable: true,
        }
    }

    // Processes as a host would show them. A handle is the pid and the creation time it was opened at, so it keeps
    // naming that process whatever else later has the pid.
    #[derive(Default)]
    struct FakeHost {
        processes: RefCell<Vec<Fake>>,
        terminated: RefCell<Vec<u32>>,
        opened: RefCell<Vec<u32>>,
    }

    impl FakeHost {
        fn with(processes: Vec<Fake>) -> Self {
            Self {
                processes: RefCell::new(processes),
                ..Default::default()
            }
        }

        fn find(&self, process: &(u32, u64)) -> Option<Fake> {
            self.processes
                .borrow()
                .iter()
                .find(|entry| entry.pid == process.0 && entry.created == process.1)
                .cloned()
        }

        fn change(&self, pid: u32, change: impl Fn(&mut Fake)) {
            for entry in self.processes.borrow_mut().iter_mut() {
                if entry.pid == pid {
                    change(entry);
                }
            }
        }
    }

    fn birth_of(entry: &Fake) -> Birth {
        Birth {
            created: entry.created,
            image: Some(entry.image.into()),
        }
    }

    impl Host for FakeHost {
        type Process = (u32, u64);
        type Job = ();

        fn members(&self, _: &()) -> Result<Vec<u32>, String> {
            Ok(self
                .processes
                .borrow()
                .iter()
                .filter(|entry| entry.listed)
                .map(|entry| entry.pid)
                .collect())
        }

        fn open(&self, pid: u32, _: &()) -> Opened<(u32, u64)> {
            self.opened.borrow_mut().push(pid);
            let found = self
                .processes
                .borrow()
                .iter()
                .find(|entry| entry.pid == pid)
                .cloned();
            match found {
                None => Opened::Elsewhere,
                Some(entry) if !entry.readable => Opened::Unreadable(Some("hidden.exe".to_owned())),
                Some(entry) if !entry.in_job => Opened::Elsewhere,
                Some(entry) if entry.endable => {
                    Opened::Endable((entry.pid, entry.created), birth_of(&entry))
                }
                Some(entry) => Opened::Readable(birth_of(&entry)),
            }
        }

        fn birth(&self, process: &(u32, u64)) -> Result<Birth, String> {
            let found = self
                .processes
                .borrow()
                .iter()
                .find(|entry| entry.pid == process.0)
                .cloned()
                .ok_or("no such process")?;
            Ok(birth_of(&found))
        }

        fn running(&self, process: &(u32, u64)) -> Result<bool, String> {
            Ok(self.find(process).is_some_and(|entry| entry.running))
        }

        fn in_job(&self, process: &(u32, u64), _: &()) -> Result<bool, String> {
            Ok(self.find(process).is_some_and(|entry| entry.in_job))
        }

        fn terminate(&self, process: &(u32, u64)) -> io::Result<()> {
            self.terminated.borrow_mut().push(process.0);
            self.change(process.0, |entry| {
                entry.running = false;
                entry.listed = false;
            });
            Ok(())
        }
    }

    fn owner(processes: Vec<Fake>) -> Ownership<FakeHost> {
        Ownership::on(FakeHost::with(processes), (), 42)
    }

    const UNKNOWN: &str =
        "encoder 42 has processes whose launch ownership is unknown; they were left alone";

    #[test]
    fn every_member_is_recorded_and_ended_newest_first_and_the_launch_through_its_handle() {
        let mut ownership = owner(vec![fake(42, 100), fake(43, 200), fake(44, 300)]);
        assert!(ownership.capture().is_empty());
        assert_eq!(
            ownership.records.keys().copied().collect::<Vec<_>>(),
            [42, 43, 44]
        );
        let mut launches = 0;
        let problems = ownership.stop_with_launch(&mut || {
            launches += 1;
            Ok(())
        });
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(launches, 1, "the launch is ended through its own handle");
        assert_eq!(
            *ownership.host.terminated.borrow(),
            [44, 43],
            "newest first"
        );
    }

    #[test]
    fn a_member_born_in_the_same_clock_tick_as_the_launch_is_recorded() {
        let mut ownership = owner(vec![fake(42, 100), fake(43, 100)]);
        assert!(ownership.capture().is_empty());
        assert!(ownership.records.contains_key(&43));
    }

    #[test]
    fn a_listed_pid_whose_handle_is_outside_the_job_is_never_recorded() {
        // 50 was a member and has gone; its pid now names a process outside the job.
        let mut reused = fake(50, 400);
        reused.in_job = false;
        let mut ownership = owner(vec![fake(42, 100), reused]);
        assert!(ownership.capture().is_empty());
        assert!(!ownership.records.contains_key(&50));
        assert!(ownership.stop_with_launch(&mut || Ok(())).is_empty());
        assert!(ownership.host.terminated.borrow().is_empty());
    }

    #[test]
    fn a_member_that_can_only_be_read_is_named_never_ended_and_keeps_completion_unconfirmed() {
        let mut elevated = fake(43, 200);
        elevated.endable = false;
        elevated.image = "C:\\Tools\\elevated.exe";
        let mut ownership = owner(vec![fake(42, 100), elevated]);
        assert_eq!(ownership.capture(), [format!("{UNKNOWN}: 43 elevated.exe")]);
        assert!(ownership.stop_with_launch(&mut || Ok(())).is_empty());
        assert!(
            ownership.host.terminated.borrow().is_empty(),
            "an unverified process is never ended"
        );
        ownership.host.change(42, |entry| {
            entry.running = false;
            entry.listed = false;
        });
        assert_eq!(
            ownership.remains(),
            Ok(true),
            "the job still lists the process"
        );
        ownership.host.change(43, |entry| entry.listed = false);
        assert_eq!(ownership.remains(), Ok(false));
    }

    #[test]
    fn a_member_that_cannot_be_read_is_named_from_a_snapshot_and_keeps_completion_unconfirmed() {
        let mut hidden = fake(43, 200);
        hidden.readable = false;
        let mut ownership = owner(vec![fake(42, 100), hidden]);
        assert_eq!(ownership.capture(), [format!("{UNKNOWN}: 43 hidden.exe")]);
        ownership.host.change(42, |entry| entry.running = false);
        assert_eq!(ownership.remains(), Ok(true));
    }

    #[test]
    fn a_member_whose_parent_left_is_recorded_from_the_job_alone() {
        let mut ownership = owner(vec![fake(42, 100)]);
        assert!(ownership.capture().is_empty());
        // The launch exits and leaves the list; a process it started lives on, still in the job.
        ownership.host.change(42, |entry| {
            entry.running = false;
            entry.listed = false;
        });
        ownership.host.processes.borrow_mut().push(fake(44, 300));
        assert_eq!(ownership.remains(), Ok(true));
        assert!(ownership.capture().is_empty());
        assert!(ownership.records.contains_key(&44));
        assert!(ownership.stop_with_launch(&mut || Ok(())).is_empty());
        assert_eq!(*ownership.host.terminated.borrow(), [44]);
        assert_eq!(ownership.remains(), Ok(false));
    }

    #[test]
    fn a_launch_that_cannot_be_opened_is_never_recorded() {
        let mut launch = fake(42, 100);
        launch.endable = false;
        let mut ownership = owner(vec![launch]);
        assert_eq!(
            ownership.capture(),
            ["launched encoder 42 could not be recorded before it exited"]
        );
        assert!(ownership.records.is_empty());
        assert!(
            ownership.remains().is_err(),
            "an unrecorded launch leaves completion unknown"
        );
    }

    #[test]
    fn a_launch_that_has_left_the_list_is_recorded_through_the_handle_that_holds_it() {
        let mut launch = fake(42, 100);
        launch.running = false;
        launch.listed = false;
        let mut ownership = owner(vec![launch]);
        assert!(ownership.capture().is_empty());
        assert!(ownership.records.contains_key(&42));
        assert_eq!(ownership.remains(), Ok(false));
        assert!(ownership.retired);
    }

    #[test]
    fn an_exited_member_still_listed_holds_nothing() {
        let mut ownership = owner(vec![fake(42, 100), fake(43, 200)]);
        assert!(ownership.capture().is_empty());
        ownership.host.change(42, |entry| entry.running = false);
        ownership.host.change(43, |entry| entry.running = false);
        assert_eq!(ownership.remains(), Ok(false));
    }

    #[test]
    fn a_recorded_process_whose_handle_reads_another_birth_or_job_is_left_alone() {
        let changes: [fn(&mut Fake); 2] = [
            |entry| entry.image = "C:\\Windows\\System32\\notepad.exe",
            |entry| entry.in_job = false,
        ];
        for change in changes {
            let mut ownership = owner(vec![fake(42, 100), fake(43, 200)]);
            assert!(ownership.capture().is_empty());
            ownership.host.change(43, change);
            let problems = ownership.stop_with_launch(&mut || Ok(()));
            assert_eq!(
                problems,
                ["recorded encoder process 43 changed identity and was left alone"]
            );
            assert!(ownership.host.terminated.borrow().is_empty());
        }
    }

    #[test]
    fn confirmed_exit_retires_the_owner_before_another_stop() {
        let mut ownership = owner(vec![fake(42, 100), fake(43, 200)]);
        assert!(ownership.capture().is_empty());
        ownership.host.change(42, |entry| entry.listed = false);
        ownership.host.change(43, |entry| entry.listed = false);
        assert_eq!(ownership.remains(), Ok(false));
        assert!(ownership.retired);
        let mut launches = 0;
        assert!(
            ownership
                .stop_with_launch(&mut || {
                    launches += 1;
                    Ok(())
                })
                .is_empty()
        );
        assert_eq!(launches, 0, "a retired owner stops nothing again");
        let opened = ownership.host.opened.borrow().len();
        assert!(ownership.capture().is_empty());
        assert_eq!(
            ownership.host.opened.borrow().len(),
            opened,
            "nor reads anything"
        );
    }

    #[test]
    fn a_birth_matches_only_the_same_creation_and_any_unreadable_image() {
        let birth = Birth {
            created: 100,
            image: Some("C:\\ffmpeg.exe".into()),
        };
        assert!(birth.matches(&Birth {
            image: None,
            ..birth.clone()
        }));
        assert!(!birth.matches(&Birth {
            created: 101,
            ..birth.clone()
        }));
        assert!(!birth.matches(&Birth {
            image: Some("C:\\other.exe".into()),
            ..birth.clone()
        }));
        assert_eq!(birth.name(), "ffmpeg.exe");
    }

    // Runs `command` through cmd.exe, held in a job as an encoder is. The command line goes as written, unquoted.
    fn held(command: &str) -> (Child, Ownership) {
        let mut child = Command::new("cmd.exe")
            .raw_arg(format!("/d /c {command}"))
            .creation_flags(CREATE_SUSPENDED)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("cmd.exe starts suspended");
        let ownership = Ownership::hold(&mut child).expect("cmd.exe is held in a job and runs");
        (child, ownership)
    }

    fn images(ownership: &Ownership) -> Vec<String> {
        ownership
            .records
            .values()
            .map(|record| record.birth.name().to_lowercase())
            .collect()
    }

    fn watched(ownership: &Ownership) -> Vec<Process> {
        ownership
            .records
            .keys()
            .map(|&pid| {
                open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE)
                    .expect("a recorded process opens")
            })
            .collect()
    }

    fn wait_for_ping(ownership: &mut Ownership) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !images(ownership).iter().any(|image| image == "ping.exe") {
            let problems = ownership.capture();
            assert!(problems.is_empty(), "{problems:?}");
            assert!(
                Instant::now() < deadline,
                "ping.exe never appeared in the job"
            );
            thread::sleep(Duration::from_millis(50));
        }
    }

    // A real launch through cmd.exe with a real child: both are in its job, recorded, ended and confirmed gone.
    #[test]
    fn a_real_launch_and_its_child_are_ended_and_confirmed_gone() {
        let (mut child, mut ownership) = held("ping -n 60 127.0.0.1 >nul");
        wait_for_ping(&mut ownership);
        assert!(images(&ownership).iter().any(|image| image == "cmd.exe"));
        let processes = watched(&ownership);
        let problems = ownership.cleanup(&mut child, Duration::from_secs(5));
        assert!(problems.is_empty(), "{problems:?}");
        for process in &processes {
            assert_eq!(
                System.running(process),
                Ok(false),
                "every recorded process has exited"
            );
        }
        assert!(child.wait().is_ok());
    }

    // `start /b` leaves ping running after cmd.exe has exited, so ping's parent is gone before a capture sees ping.
    #[test]
    fn a_real_process_whose_parent_exited_first_is_recorded_from_the_job_and_ended() {
        let (mut child, mut ownership) = held("start /b ping -n 60 127.0.0.1 >nul");
        assert!(child.wait().expect("cmd.exe exits at once").success());
        wait_for_ping(&mut ownership);
        assert_eq!(ownership.remains(), Ok(true), "ping still runs in the job");
        let processes = watched(&ownership);
        let problems = ownership.cleanup(&mut child, Duration::from_secs(5));
        assert!(problems.is_empty(), "{problems:?}");
        for process in &processes {
            assert_eq!(System.running(process), Ok(false));
        }
    }

    #[test]
    fn a_real_launch_that_exits_retires_its_owner() {
        let (mut child, mut ownership) = held("exit 3");
        assert!(ownership.capture().is_empty());
        let status = child.wait().expect("cmd.exe exits");
        assert_eq!(status.code(), Some(3));
        assert_eq!(ownership.remains(), Ok(false));
        assert!(ownership.retired);
        assert!(
            ownership
                .cleanup(&mut child, Duration::from_secs(1))
                .is_empty()
        );
    }

    #[test]
    fn this_process_reads_as_itself_and_is_outside_the_launch_s_job() {
        let process = open_process(
            std::process::id(),
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
        )
        .expect("this process opens");
        let birth = System.birth(&process).expect("its birth reads");
        let image = birth.image.clone().expect("its image reads");
        assert_eq!(
            std::path::PathBuf::from(image).canonicalize().ok(),
            std::env::current_exe()
                .ok()
                .and_then(|path| path.canonicalize().ok())
        );
        assert!(birth.created > 0);
        assert_eq!(System.running(&process), Ok(true));
        assert!(snapshot_name(std::process::id()).is_some());
        let (mut child, mut ownership) = held("exit 0");
        assert_eq!(System.in_job(&process, &ownership.job), Ok(false));
        assert!(
            ownership
                .cleanup(&mut child, Duration::from_secs(5))
                .is_empty()
        );
    }
}
