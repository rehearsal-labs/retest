//! The Win32 side: job objects, and the process readings each answer is made of.
//!
//! Every job is named in this session's namespace, so a later invocation can open it, and created only when the name
//! is new, so a job someone made first is never taken over. Each one ends every process it holds once its last handle
//! closes. The handle that keeps it is duplicated into the runner before anything is put in it: from then on the job
//! lives exactly as long as the runner, and when the runner ends, however it ends, Windows closes that handle and ends
//! everything the job holds. A process is only ever read or ended through a handle opened on it, which pins it, so a pid
//! that went to another process between two calls is caught by its start, never acted on.

use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, c_void};
use std::iter::once;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::sleep;
use std::time::{Duration, Instant};

use windows_sys::Wdk::System::Threading::{
    NtQueryInformationProcess, ProcessBasicInformation, ProcessCommandLineInformation,
};
use windows_sys::Win32::Foundation::{
    CloseHandle, CompareObjectHandles, DUPLICATE_CLOSE_SOURCE, DUPLICATE_SAME_ACCESS,
    DuplicateHandle, ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND, ERROR_INVALID_PARAMETER,
    ERROR_MORE_DATA, FILETIME, GetLastError, HANDLE, INVALID_HANDLE_VALUE, SetLastError,
};
use windows_sys::Win32::System::Console::{
    AttachConsole, CTRL_BREAK_EVENT, CTRL_C_EVENT, FreeConsole, GenerateConsoleCtrlEvent,
    GetConsoleProcessList, SetConsoleCtrlHandler,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_BASIC_PROCESS_ID_LIST, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectBasicProcessIdList, JobObjectExtendedLimitInformation, OpenJobObjectW,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::SystemInformation::GetSystemTimePreciseAsFileTime;
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentProcessId, GetExitCodeProcess, GetProcessTimes, OpenProcess,
    PROCESS_DUP_HANDLE, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA,
    PROCESS_TERMINATE, QueryFullProcessImageNameW, TerminateProcess,
};

use crate::command::{Command, JobName, Key};
use crate::reply::{Identity, Outcome, Reply};

// Job access rights, from winnt.h; windows-sys keeps them in a much larger module than the rest of this file needs.
const JOB_OBJECT_QUERY: u32 = 0x0004;
const JOB_OBJECT_TERMINATE: u32 = 0x0008;
// The exit code GetExitCodeProcess gives a process still running.
const STILL_ACTIVE: u32 = 259;
// The exit code of a process a job's end or `terminate` ended: 137, as a shell reports a process SIGKILL ended (128 + 9),
// so a kill is told from a crash, which Windows reports as 1, as it does a child Node kills.
const ENDED_EXIT_CODE: u32 = 137;
// How many times the processes a child started before it was held are looked for, each look taking those the last
// one held; a launch's helpers are a few levels deep at most. A search still finding more at the last look says so.
const DESCENDANT_LOOKS: usize = 8;
// How many parents a stray is followed up through before it counts as standing on nothing.
const PARENT_STEPS: usize = 64;

/// Does what `command` asks and says how it went. A refusal is an answer too, with its reason.
pub fn answer(command: Command) -> Reply {
    let answered = match command {
        Command::Version => Err(Failure::plain(
            "--version is answered before any job is touched.",
        )),
        Command::Hold { runner, job } => hold(runner, &job),
        Command::Adopt {
            runner,
            within,
            job,
            pid,
        } => adopt(runner, &within, &job, pid),
        Command::Members { job } => members(&job),
        Command::Process { pid, job } => process(pid, job.as_ref()),
        Command::End { runner, job } => end(runner, &job),
        Command::Terminate {
            runner,
            job,
            pid,
            started,
        } => terminate(runner, &job, pid, started),
        Command::Release {
            runner,
            job,
            handle,
        } => release(runner, &job, handle),
        Command::Strays {
            runner,
            job,
            launches,
        } => strays(runner, &job, &launches),
        Command::Interrupt {
            runner,
            job,
            pid,
            key,
        } => interrupt(runner, &job, pid, key),
    };
    answered.unwrap_or_else(|failure| Reply::Refused {
        problem: failure.problem,
        detail: failure.detail,
    })
}

/// Why a request was not done: a sentence a person can read, and, when a Windows call failed, that call and its code.
#[derive(Debug)]
struct Failure {
    problem: String,
    detail: Option<String>,
}

impl Failure {
    fn plain(problem: impl Into<String>) -> Self {
        Self {
            problem: problem.into(),
            detail: None,
        }
    }

    // A sentence a person reads, and the job it is about, named apart from it for a diagnostic.
    fn about(job: &JobName, problem: impl Into<String>) -> Self {
        Self {
            problem: problem.into(),
            detail: Some(format!("Job {}.", job.as_str())),
        }
    }

    // A Windows call that failed on a named job: the job is named in the detail beside the call.
    fn windows_on(job: &JobName, call: &str, problem: impl Into<String>) -> Self {
        let failure = Self::windows(call, problem);
        Self {
            detail: failure
                .detail
                .map(|detail| format!("{detail} Job {}.", job.as_str())),
            ..failure
        }
    }

    // A Windows call that failed: `problem` says in plain words what did not happen, the detail which call it was.
    fn windows(call: &str, problem: impl Into<String>) -> Self {
        // SAFETY: GetLastError reads this thread's last error and has no preconditions.
        let code = unsafe { GetLastError() };
        Self {
            problem: problem.into(),
            detail: Some(format!("{call} failed with Windows error {code}.")),
        }
    }
}

/// A handle this invocation opened, closed when it goes out of scope.
struct Owned(HANDLE);

impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: the handle was returned open by Windows and is closed only here, once.
        unsafe { CloseHandle(self.0) };
    }
}

fn hold(runner: u32, name: &JobName) -> Result<Reply, Failure> {
    let parents = parent_ids()?;
    // SAFETY: GetCurrentProcessId has no preconditions.
    let me = unsafe { GetCurrentProcessId() };
    if parents.get(&me) != Some(&runner) {
        return Err(Failure::plain(format!(
            "Process {runner} did not start this request, so it was not held."
        )));
    }
    let runner_process = open_process(
        runner,
        PROCESS_SET_QUOTA
            | PROCESS_TERMINATE
            | PROCESS_DUP_HANDLE
            | PROCESS_QUERY_LIMITED_INFORMATION,
    )?
    .ok_or_else(|| {
        Failure::plain(format!(
            "Process {runner} is not running, so it was not held."
        ))
    })?;
    let job = create_job(name)?;
    // The runner gets its handle while the job is still empty: had this invocation died after the runner was put in a
    // job only it held, closing that last handle would have ended the runner.
    let handle = duplicate_into(&job, &runner_process, runner)?;
    // SAFETY: both handles are open, the job's with every right and the runner's with PROCESS_SET_QUOTA and PROCESS_TERMINATE.
    if unsafe { AssignProcessToJobObject(job.0, runner_process.0) } == 0 {
        let failure = Failure::windows(
            "AssignProcessToJobObject",
            format!("Process {runner} could not be put in a job."),
        );
        close_in(&runner_process, handle);
        return Err(failure);
    }
    Ok(Reply::Held {
        job: name.as_str().to_owned(),
        runner,
        handle,
    })
}

fn adopt(runner: u32, within: &JobName, name: &JobName, pid: u32) -> Result<Reply, Failure> {
    let runner_job = open_job(within, JOB_OBJECT_QUERY)?;
    let runner_process = open_process(
        runner,
        PROCESS_DUP_HANDLE | PROCESS_QUERY_LIMITED_INFORMATION,
    )?
    .ok_or_else(|| {
        Failure::plain(format!(
            "Process {runner} is not running, so nothing was held for it."
        ))
    })?;
    if !in_job(&runner_process, &runner_job)? {
        return Err(Failure::about(
            within,
            format!("Process {runner} is not held yet, so nothing was held for it."),
        ));
    }
    // The parent is read through a handle that only reads and that pins the process, so the handle opened to hold it
    // below is this same process. A process this one cannot even read is no child the runner started.
    let reading = match open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION) {
        Ok(Some(reading)) => Some(reading),
        Ok(None) => {
            return Err(Failure::plain(format!(
                "Process {pid} is not running, so it was not held."
            )));
        }
        Err(_) => None,
    };
    if reading.as_ref().and_then(parent_of) != Some(runner) {
        return Err(Failure::plain(format!(
            "Process {pid} was not started by process {runner}, so it was not held."
        )));
    }
    let child = open_process(
        pid,
        PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
    )?
    .ok_or_else(|| Failure::plain(format!("Process {pid} is not running, so it was not held.")))?;
    // A child that already ended cannot be put in a job; what it started before it ended can, and is held below.
    let ended = !running(&child)?;
    // A child starts after its parent. One that started earlier holds a pid that went to it from another process.
    let child_start = started_at(&child)?;
    if child_start < started_at(&runner_process)? {
        return Err(Failure::plain(format!(
            "Process {pid} started before process {runner}, so it is not that process's child and was not held."
        )));
    }
    let job = create_job(name)?;
    let handle = duplicate_into(&job, &runner_process, runner)?;
    // Nothing after this point fails: a refusal from here on would leave the runner holding a job with processes in it.
    // SAFETY: both handles are open, the job's with every right and the child's with PROCESS_SET_QUOTA and PROCESS_TERMINATE.
    if !ended && unsafe { AssignProcessToJobObject(job.0, child.0) } == 0 {
        let failure = Failure::windows(
            "AssignProcessToJobObject",
            format!("Process {pid} could not be held in a job of its own."),
        );
        close_in(&runner_process, handle);
        return Err(failure);
    }
    let root = Identity {
        pid,
        parent_pid: Some(runner),
        started_at: child_start,
        image: image_of(&child),
        command_line: command_line_of(&child),
    };
    let walk = adopt_descendants(&job, &runner_job, pid, child_start);
    Ok(Reply::Adopted {
        job: name.as_str().to_owned(),
        handle,
        root,
        ended,
        late: walk.late,
        by_parent: walk.by_parent,
        unheld: walk.unheld,
        complete: walk.complete,
    })
}

/// What the search for the processes a child started before it was held found.
struct Walk {
    late: Vec<Identity>,
    by_parent: Vec<Identity>,
    unheld: Vec<u32>,
    complete: bool,
}

// The processes the child started before it was held were born outside its job. Each is held now, while its parent is
// one of the held ones and it started between that parent and the snapshot it was found in: a process that started
// earlier holds a pid that went to it from another process, and one that started later took a pid the snapshot gave
// to a process that ended since. Processes born after the child was held are in the job already, and are not finds.
// A process that cannot be read is passed over, never the end of the search: the snapshot names parents by pid, and a
// pid of a process long gone, such as the parent a system process was started by, may be one of the held ones now.
//
// What this cannot see is a process whose parent ended before the snapshot: Windows then names a parent that no longer
// runs, and nothing ties the process to the launch. The runner's job still holds it, and `strays` finds it afterwards.
fn adopt_descendants(job: &Owned, runner_job: &Owned, root: u32, root_start: u64) -> Walk {
    let mut held: HashMap<u32, u64> = HashMap::from([(root, root_start)]);
    // A handle on each held process pins its pid for the whole walk: one that ends meanwhile keeps its pid, so no later
    // process given that pid is taken for its child. The root's is the caller's.
    let mut pins: Vec<Owned> = Vec::new();
    let mut decided: HashSet<u32> = HashSet::from([root]);
    let mut walk = Walk {
        late: Vec::new(),
        by_parent: Vec::new(),
        unheld: Vec::new(),
        complete: false,
    };
    for _ in 0..DESCENDANT_LOOKS {
        let looked = now();
        let Ok(parents) = parent_ids() else {
            return walk;
        };
        let mut found = false;
        for (&pid, &parent) in &parents {
            if decided.contains(&pid) {
                continue;
            }
            let Some(&parent_start) = held.get(&parent) else {
                continue;
            };
            let Some((process, start)) = descendant(pid, parent, parent_start, looked) else {
                continue;
            };
            decided.insert(pid);
            let identity = Identity {
                pid,
                parent_pid: Some(parent),
                started_at: start,
                image: image_of(&process),
                command_line: command_line_of(&process),
            };
            match in_job(&process, job) {
                Ok(true) => {
                    held.insert(pid, start);
                    pins.push(process);
                    continue;
                }
                Ok(false) => {}
                Err(_) => {
                    walk.unheld.push(pid);
                    continue;
                }
            }
            // Everything the launch started before it was held was born in the runner's job, which the runner was put in
            // before it started anything. A process outside it is someone else's, whatever pid its parent was given.
            let in_runner_job = in_job(&process, runner_job).unwrap_or(false);
            if !in_runner_job {
                continue;
            }
            // The reading handle pins the process, so the pid opened again here is still this process.
            let assigned = open_process(pid, PROCESS_SET_QUOTA | PROCESS_TERMINATE)
                .ok()
                .flatten()
                // SAFETY: both handles are open, the job's with every right and the process's with PROCESS_SET_QUOTA
                // and PROCESS_TERMINATE.
                .is_some_and(
                    |writable| unsafe { AssignProcessToJobObject(job.0, writable.0) } != 0,
                );
            // Only an assignment counts as a find: a launch that goes on starting processes in a job of its own, as
            // Firefox starts its content processes, would otherwise use up the looks.
            if assigned {
                found = true;
                held.insert(pid, start);
                walk.late.push(identity);
            } else {
                // Already in a job of its own inside the runner's, as the browser Firefox's launcher starts is, it cannot
                // be moved beside the launch. Its parent holds that job, and the runner's job holds them both.
                held.insert(pid, start);
                walk.by_parent.push(identity);
            }
            pins.push(process);
        }
        if !found {
            walk.complete = true;
            return walk;
        }
    }
    walk
}

// A reading handle on `pid` and its start, when it is a running process that started no earlier than its parent and no
// later than the snapshot taken at `looked`, and whose own handle names the parent the snapshot gave it: a pid given to
// another process since the snapshot is that process, with a parent and a start of its own.
fn descendant(pid: u32, parent: u32, parent_start: u64, looked: u64) -> Option<(Owned, u64)> {
    let process = open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION).ok()??;
    if !running(&process).ok()? || parent_of(&process) != Some(parent) {
        return None;
    }
    let start = started_at(&process).ok()?;
    (parent_start <= start && start <= looked).then_some((process, start))
}

fn members(name: &JobName) -> Result<Reply, Failure> {
    let job = open_job(name, JOB_OBJECT_QUERY)?;
    let listed = process_ids(&job)?;
    let mut processes = Vec::with_capacity(listed.len());
    for pid in listed {
        // A member that cannot be read is listed with its pid alone, as `strays` lists one: the job holds it, so it is
        // one of the job's, and one process no reading can open never hides the rest.
        let process = match open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION) {
            Ok(Some(process)) => process,
            Ok(None) => continue,
            Err(_) => {
                processes.push(unread(pid));
                continue;
            }
        };
        // A listed process that ended since, or whose pid went to a process outside the job, is no longer a member.
        match (running(&process), in_job(&process, &job)) {
            (Ok(false), _) | (_, Ok(false)) => continue,
            (Ok(true), Ok(true)) => {}
            _ => {
                processes.push(unread(pid));
                continue;
            }
        }
        processes.push(identity_of(pid, &process).unwrap_or_else(|_| unread(pid)));
    }
    Ok(Reply::Members {
        job: name.as_str().to_owned(),
        processes,
    })
}

fn process(pid: u32, name: Option<&JobName>) -> Result<Reply, Failure> {
    let Some(process) = open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION)? else {
        return Ok(Reply::Process {
            process: None,
            in_job: None,
        });
    };
    if !running(&process)? {
        return Ok(Reply::Process {
            process: None,
            in_job: None,
        });
    }
    let identity = identity_of(pid, &process)?;
    let in_job = match name {
        None => None,
        Some(name) => Some(match find_job(name, JOB_OBJECT_QUERY)? {
            Some(job) => in_job(&process, &job)?,
            // A job nobody holds any more holds no process.
            None => false,
        }),
    };
    Ok(Reply::Process {
        process: Some(identity),
        in_job,
    })
}

fn end(runner: u32, name: &JobName) -> Result<Reply, Failure> {
    let job = open_job(name, JOB_OBJECT_TERMINATE | JOB_OBJECT_QUERY)?;
    if holds_runner(runner, &job)? {
        return Err(Failure::about(
            name,
            "These processes include Retest itself, so they were not ended.",
        ));
    }
    // SAFETY: the job's handle is open with JOB_OBJECT_TERMINATE.
    if unsafe { TerminateJobObject(job.0, ENDED_EXIT_CODE) } == 0 {
        return Err(Failure::windows_on(
            name,
            "TerminateJobObject",
            "The processes could not be ended.",
        ));
    }
    Ok(Reply::Ended {
        job: name.as_str().to_owned(),
    })
}

fn terminate(runner: u32, name: &JobName, pid: u32, started: u64) -> Result<Reply, Failure> {
    if pid == runner {
        return Err(Failure::plain(format!(
            "Process {pid} is Retest itself, so it was not ended."
        )));
    }
    let Some(process) = open_process(pid, PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION)?
    else {
        return Ok(Reply::Terminated {
            pid,
            outcome: Outcome::Absent,
        });
    };
    if !running(&process)? {
        return Ok(Reply::Terminated {
            pid,
            outcome: Outcome::Absent,
        });
    }
    let held = match find_job(name, JOB_OBJECT_QUERY)? {
        Some(job) => in_job(&process, &job)?,
        None => false,
    };
    if started_at(&process)? != started || !held {
        return Ok(Reply::Terminated {
            pid,
            outcome: Outcome::Different,
        });
    }
    // SAFETY: the process's handle is open with PROCESS_TERMINATE, and it pins the process just checked.
    if unsafe { TerminateProcess(process.0, ENDED_EXIT_CODE) } == 0 {
        return Err(Failure::windows(
            "TerminateProcess",
            format!("Process {pid} could not be ended."),
        ));
    }
    Ok(Reply::Terminated {
        pid,
        outcome: Outcome::Terminated,
    })
}

// Closes the runner's handle to a job only when that handle is this job and the job holds nothing, since closing the last
// handle of a job ends what it holds.
fn release(runner: u32, name: &JobName, value: usize) -> Result<Reply, Failure> {
    let job = open_job(name, JOB_OBJECT_QUERY)?;
    let runner_process = open_process(runner, PROCESS_DUP_HANDLE)?.ok_or_else(|| {
        Failure::plain(format!(
            "Process {runner} is not running, so it holds no handle to release."
        ))
    })?;
    let mut copy: HANDLE = null_mut();
    // SAFETY: the runner's handle is open with PROCESS_DUP_HANDLE; Windows checks that the value names a handle there.
    if unsafe {
        DuplicateHandle(
            runner_process.0,
            value as HANDLE,
            GetCurrentProcess(),
            &mut copy,
            0,
            0,
            DUPLICATE_SAME_ACCESS,
        )
    } == 0
    {
        return Err(Failure::windows(
            "DuplicateHandle",
            format!("Process {runner} holds no handle {value}, so nothing was released."),
        ));
    }
    let copy = Owned(copy);
    // SAFETY: both handles are open.
    if unsafe { CompareObjectHandles(copy.0, job.0) } == 0 {
        return Err(Failure::about(
            name,
            format!("Handle {value} of process {runner} is another one, so it was left open."),
        ));
    }
    if !process_ids(&job)?.is_empty() {
        return Err(Failure::about(
            name,
            "Processes are still running there, so its handle was kept.",
        ));
    }
    close_in(&runner_process, value);
    Ok(Reply::Released {
        job: name.as_str().to_owned(),
    })
}

// The processes the runner's job holds that no launch's job holds, that are neither the runner nor this program, and
// that nothing still running stands behind. Each was started by a launch, or by something a launch started, whose
// process had already ended when the launch was held, so no launch's job took it; it runs until the runner ends.
fn strays(runner: u32, name: &JobName, launches: &[JobName]) -> Result<Reply, Failure> {
    let job = open_job(name, JOB_OBJECT_QUERY)?;
    // A launch's job that is gone holds nothing; one that cannot be opened is left out, so what it holds is named.
    let launch_jobs: Vec<Owned> = launches
        .iter()
        .filter_map(|launch| find_job(launch, JOB_OBJECT_QUERY).ok().flatten())
        .collect();
    // SAFETY: GetCurrentProcessId has no preconditions.
    let me = unsafe { GetCurrentProcessId() };
    let looked = now();
    let mut found = Vec::new();
    for pid in process_ids(&job)? {
        if pid == runner || pid == me {
            continue;
        }
        let process = match open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION) {
            Ok(Some(process)) => process,
            Ok(None) => continue,
            // A member that cannot even be read is named: nothing says it is anyone's.
            Err(_) => {
                found.push(unread(pid));
                continue;
            }
        };
        if !running(&process).unwrap_or(true) {
            continue;
        }
        let start = started_at(&process).unwrap_or(0);
        // One born after the snapshot is not in it, so its parent is not known; it is no leftover of an ended launch.
        if start > looked
            || !in_job(&process, &job).unwrap_or(true)
            || in_any(&process, &launch_jobs)
        {
            continue;
        }
        if stands_behind(&process, start, runner, &launch_jobs, looked) {
            continue;
        }
        found.push(Identity {
            pid,
            parent_pid: parent_of(&process),
            started_at: start,
            image: image_of(&process),
            command_line: command_line_of(&process),
        });
    }
    Ok(Reply::Strays {
        job: name.as_str().to_owned(),
        processes: found,
    })
}

// Whether the process's parents, followed up while each still runs and started no later than the process after it,
// reach the runner or a process a launch's job holds. Each parent is read from the handle of the process it started.
fn stands_behind(
    process: &Owned,
    start: u64,
    runner: u32,
    launches: &[Owned],
    looked: u64,
) -> bool {
    let (mut parent_pid, mut current_start) = (parent_of(process), start);
    for _ in 0..PARENT_STEPS {
        let Some(parent) = parent_pid else {
            return false;
        };
        // The runner ran before everything its job holds was born, so a child naming its pid is its own.
        if parent == runner {
            return true;
        }
        let Ok(Some(process)) = open_process(parent, PROCESS_QUERY_LIMITED_INFORMATION) else {
            return false;
        };
        if !running(&process).unwrap_or(false) {
            return false;
        }
        let Ok(parent_start) = started_at(&process) else {
            return false;
        };
        if parent_start > current_start || parent_start > looked {
            return false;
        }
        if in_any(&process, launches) {
            return true;
        }
        (parent_pid, current_start) = (parent_of(&process), parent_start);
    }
    false
}

fn in_any(process: &Owned, jobs: &[Owned]) -> bool {
    jobs.iter().any(|job| in_job(process, job).unwrap_or(false))
}

// Ctrl+C or Ctrl+Break, sent to the console of `target`, or of the job's first process with one, which reaches every
// process on that console as a person pressing it there would. A console Retest itself is on is never sent one. This
// program starts with no console, joins that one, takes the key itself without ending, and leaves it again.
fn interrupt(runner: u32, name: &JobName, target: Option<u32>, key: Key) -> Result<Reply, Failure> {
    let pressed = match key {
        Key::CtrlC => "Ctrl+C",
        Key::CtrlBreak => "Ctrl+Break",
    };
    let job = open_job(name, JOB_OBJECT_QUERY)?;
    if holds_runner(runner, &job)? {
        return Err(Failure::about(
            name,
            format!("These processes include Retest itself, so {pressed} was not sent."),
        ));
    }
    let members = process_ids(&job)?;
    let candidates: Vec<u32> = match target {
        Some(pid) if members.contains(&pid) => vec![pid],
        Some(pid) => {
            return Err(Failure::about(
                name,
                format!("Process {pid} is not one of these processes, so {pressed} was not sent."),
            ));
        }
        None => members.into_iter().filter(|pid| *pid != runner).collect(),
    };
    // SAFETY: GetCurrentProcessId has no preconditions.
    let me = unsafe { GetCurrentProcessId() };
    // SAFETY: FreeConsole has no preconditions; it fails harmlessly when this program has no console.
    unsafe { FreeConsole() };
    let mut unattached = None;
    for pid in candidates {
        // The job's list is a list of pids: one that ended since may have gone to a process on another console. A handle
        // pins the process while its console is joined, and only a running member of the job is joined.
        let Ok(Some(process)) = open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION) else {
            continue;
        };
        if !running(&process).unwrap_or(false) || !in_job(&process, &job).unwrap_or(false) {
            continue;
        }
        // SAFETY: AttachConsole has no memory preconditions; it fails when the process has no console.
        if unsafe { AttachConsole(pid) } == 0 {
            unattached = Failure::windows("AttachConsole", "").detail;
            continue;
        }
        let on_console: Vec<u32> = console_processes()
            .into_iter()
            .filter(|attached| *attached != me)
            .collect();
        if on_console.contains(&runner) {
            // SAFETY: as above.
            unsafe { FreeConsole() };
            return Err(Failure::about(
                name,
                format!("These processes share Retest's console, so {pressed} was not sent."),
            ));
        }
        // This program ignores Ctrl+C, and takes Ctrl+Break, which cannot be ignored, without ending.
        // SAFETY: a null handler with TRUE sets the ignoring; the other handler is a function that lives as long as this
        // program. Neither call has other preconditions.
        unsafe {
            SetConsoleCtrlHandler(None, 1);
            SetConsoleCtrlHandler(Some(taken), 1);
        }
        let event = match key {
            Key::CtrlC => CTRL_C_EVENT,
            Key::CtrlBreak => CTRL_BREAK_EVENT,
        };
        // SAFETY: GenerateConsoleCtrlEvent has no memory preconditions; group 0 is every process on this console.
        let sent = unsafe { GenerateConsoleCtrlEvent(event, 0) } != 0;
        // Ctrl+Break reaches this program too, on a thread of its own; one that arrived while this program ended would
        // end it with the key's exit code instead of its answer's. It is waited for, briefly, before leaving.
        if sent && key == Key::CtrlBreak {
            let started = Instant::now();
            while !BREAK_TAKEN.load(Ordering::SeqCst) && started.elapsed() < Duration::from_secs(2)
            {
                sleep(Duration::from_millis(5));
            }
        }
        let failure = (!sent).then(|| {
            Failure::windows(
                "GenerateConsoleCtrlEvent",
                format!("{pressed} could not be sent to the console of process {pid}."),
            )
        });
        // SAFETY: as above.
        unsafe { FreeConsole() };
        return match failure {
            Some(failure) => Err(failure),
            None => Ok(Reply::Interrupted {
                job: name.as_str().to_owned(),
                console: pid,
                reached: on_console,
            }),
        };
    }
    Err(Failure {
        problem: format!("None of these processes has a console, so {pressed} was not sent."),
        detail: Some(format!(
            "{}Job {}.",
            unattached
                .map(|detail| format!("{detail} "))
                .unwrap_or_default(),
            name.as_str()
        )),
    })
}

// Whether the Ctrl+Break this program sent has reached it too.
static BREAK_TAKEN: AtomicBool = AtomicBool::new(false);

// What this program does with the key it sends to the console it joined: takes it, so it goes on to answer.
unsafe extern "system" fn taken(_event: u32) -> windows_sys::core::BOOL {
    BREAK_TAKEN.store(true, Ordering::SeqCst);
    1
}

// The processes on the console this program is attached to.
fn console_processes() -> Vec<u32> {
    let mut capacity = 64usize;
    loop {
        let mut list = vec![0u32; capacity];
        // SAFETY: the buffer holds `capacity` process ids.
        let count = unsafe { GetConsoleProcessList(list.as_mut_ptr(), capacity as u32) } as usize;
        if count <= capacity {
            list.truncate(count);
            return list;
        }
        capacity = count + 16;
    }
}

fn holds_runner(runner: u32, job: &Owned) -> Result<bool, Failure> {
    let Some(runner_process) = open_process(runner, PROCESS_QUERY_LIMITED_INFORMATION)? else {
        return Ok(false);
    };
    in_job(&runner_process, job)
}

// A new job named `name` that ends everything in it once its last handle closes. A name that is taken is refused rather
// than joined: the job behind it is someone else's.
fn create_job(name: &JobName) -> Result<Owned, Failure> {
    let wide = wide(name.as_str());
    // SAFETY: SetLastError has no preconditions; it clears the code CreateJobObjectW sets only when the name exists.
    unsafe { SetLastError(0) };
    // SAFETY: the name is a NUL-terminated UTF-16 string that outlives the call; no security attributes are passed.
    let handle = unsafe { CreateJobObjectW(null(), wide.as_ptr()) };
    if handle.is_null() {
        return Err(Failure::windows(
            "CreateJobObjectW",
            "Windows would not make a job for Retest's processes.",
        ));
    }
    // SAFETY: GetLastError reads the code CreateJobObjectW just left.
    let existed = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    let job = Owned(handle);
    if existed {
        return Err(Failure::about(
            name,
            "Another job already has this name, so it was not used.",
        ));
    }
    // SAFETY: an all-zero JOBOBJECT_EXTENDED_LIMIT_INFORMATION is a valid value that sets no limit.
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: the pointer and size describe `limits`, which outlives the call.
    let set = unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast::<c_void>(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if set == 0 {
        return Err(Failure::windows(
            "SetInformationJobObject",
            "Windows would not make a job that ends its processes when Retest ends, so none was used.",
        ));
    }
    Ok(job)
}

fn open_job(name: &JobName, access: u32) -> Result<Owned, Failure> {
    find_job(name, access)?
        .ok_or_else(|| Failure::about(name, "Retest no longer holds these processes."))
}

fn find_job(name: &JobName, access: u32) -> Result<Option<Owned>, Failure> {
    let wide = wide(name.as_str());
    // SAFETY: the name is a NUL-terminated UTF-16 string that outlives the call; the handle is not inherited.
    let handle = unsafe { OpenJobObjectW(access, 0, wide.as_ptr()) };
    if handle.is_null() {
        // SAFETY: GetLastError reads the code OpenJobObjectW just left.
        if unsafe { GetLastError() } == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        return Err(Failure::windows_on(
            name,
            "OpenJobObjectW",
            "Retest could not open what it holds.",
        ));
    }
    Ok(Some(Owned(handle)))
}

// The ids of every process the job holds, nested jobs included, as many as there are.
fn process_ids(job: &Owned) -> Result<Vec<u32>, Failure> {
    let header = size_of::<JOBOBJECT_BASIC_PROCESS_ID_LIST>() - size_of::<usize>();
    let mut capacity = 64usize;
    loop {
        // usize words keep the list aligned as Windows writes it; the first words hold the two counts.
        let words = header.div_ceil(size_of::<usize>()) + capacity;
        let mut buffer = vec![0usize; words];
        let bytes = (words * size_of::<usize>()) as u32;
        // SAFETY: the buffer is `bytes` long, writable and aligned for JOBOBJECT_BASIC_PROCESS_ID_LIST.
        let queried = unsafe {
            QueryInformationJobObject(
                job.0,
                JobObjectBasicProcessIdList,
                buffer.as_mut_ptr().cast::<c_void>(),
                bytes,
                null_mut(),
            )
        };
        // SAFETY: the buffer starts with a JOBOBJECT_BASIC_PROCESS_ID_LIST header Windows filled or left zeroed.
        let list = unsafe { &*buffer.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>() };
        let assigned = list.NumberOfAssignedProcesses as usize;
        if queried == 0 {
            // SAFETY: GetLastError reads the code QueryInformationJobObject just left.
            if unsafe { GetLastError() } == ERROR_MORE_DATA && assigned > capacity {
                capacity = assigned + 16;
                continue;
            }
            return Err(Failure::windows(
                "QueryInformationJobObject",
                "Windows would not list the processes in a job.",
            ));
        }
        let listed = list.NumberOfProcessIdsInList as usize;
        if listed < assigned {
            capacity = assigned + 16;
            continue;
        }
        let first = header.div_ceil(size_of::<usize>());
        return Ok(buffer[first..first + listed]
            .iter()
            .map(|&pid| pid as u32)
            .collect());
    }
}

// Every running process's parent, from one snapshot. Windows keeps the id of the process that started each one, even
// after that process has ended and its id went to another, which is why every use here also compares starts.
fn parent_ids() -> Result<HashMap<u32, u32>, Failure> {
    // SAFETY: TH32CS_SNAPPROCESS with process id 0 snapshots every process; no other argument is read.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(Failure::windows(
            "CreateToolhelp32Snapshot",
            "Windows would not list its running processes.",
        ));
    }
    let snapshot = Owned(snapshot);
    // SAFETY: an all-zero PROCESSENTRY32W is valid once its size is set.
    let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut parents = HashMap::new();
    // SAFETY: the snapshot is open and `entry` has its size set.
    let mut more = unsafe { Process32FirstW(snapshot.0, &mut entry) } != 0;
    while more {
        parents.insert(entry.th32ProcessID, entry.th32ParentProcessID);
        // SAFETY: as above.
        more = unsafe { Process32NextW(snapshot.0, &mut entry) } != 0;
    }
    Ok(parents)
}

// The time now, as the 100 ns ticks since 1601 a process's start is given in.
fn now() -> u64 {
    let mut time = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    // SAFETY: `time` is writable.
    unsafe { GetSystemTimePreciseAsFileTime(&mut time) };
    (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime)
}

// An open handle on the process, or none when no process has the pid.
fn open_process(pid: u32, access: u32) -> Result<Option<Owned>, Failure> {
    // SAFETY: OpenProcess has no memory preconditions; the handle is not inherited.
    let handle = unsafe { OpenProcess(access, 0, pid) };
    if handle.is_null() {
        // SAFETY: GetLastError reads the code OpenProcess just left.
        if unsafe { GetLastError() } == ERROR_INVALID_PARAMETER {
            return Ok(None);
        }
        return Err(Failure::windows(
            "OpenProcess",
            format!("Process {pid} could not be opened."),
        ));
    }
    Ok(Some(Owned(handle)))
}

fn running(process: &Owned) -> Result<bool, Failure> {
    let mut code = 0u32;
    // SAFETY: the handle is open with PROCESS_QUERY_LIMITED_INFORMATION and `code` is writable.
    if unsafe { GetExitCodeProcess(process.0, &mut code) } == 0 {
        return Err(Failure::windows(
            "GetExitCodeProcess",
            "Windows would not say whether a process is still running.",
        ));
    }
    Ok(code == STILL_ACTIVE)
}

fn started_at(process: &Owned) -> Result<u64, Failure> {
    let empty = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut created, mut exited, mut kernel, mut user) = (empty, empty, empty, empty);
    // SAFETY: the handle is open with PROCESS_QUERY_LIMITED_INFORMATION and each FILETIME is writable.
    if unsafe { GetProcessTimes(process.0, &mut created, &mut exited, &mut kernel, &mut user) } == 0
    {
        return Err(Failure::windows(
            "GetProcessTimes",
            "Windows would not say when a process started.",
        ));
    }
    Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
}

// A process no handle could be opened on: its pid, and a start of 0, which no process has.
fn unread(pid: u32) -> Identity {
    Identity {
        pid,
        parent_pid: None,
        started_at: 0,
        image: None,
        command_line: None,
    }
}

// One process as its own handle shows it, so its parent, start, image and command line are all this one process's.
fn identity_of(pid: u32, process: &Owned) -> Result<Identity, Failure> {
    Ok(Identity {
        pid,
        parent_pid: parent_of(process),
        started_at: started_at(process)?,
        image: image_of(process),
        command_line: command_line_of(process),
    })
}

// PROCESS_BASIC_INFORMATION, as NtQueryInformationProcess writes it on x64; only the last field is read.
#[repr(C)]
struct BasicInformation {
    exit_status: i32,
    peb: *mut c_void,
    affinity: usize,
    base_priority: i32,
    unique_process_id: usize,
    inherited_from: usize,
}

// The pid of the process that started this one, as Windows recorded it when it was created, read from its handle.
fn parent_of(process: &Owned) -> Option<u32> {
    // SAFETY: an all-zero BasicInformation is valid; NtQueryInformationProcess fills it.
    let mut information: BasicInformation = unsafe { zeroed() };
    let mut written = 0u32;
    // SAFETY: the handle is open with PROCESS_QUERY_LIMITED_INFORMATION, which this class needs, and the buffer is
    // exactly the size given.
    let status = unsafe {
        NtQueryInformationProcess(
            process.0,
            ProcessBasicInformation,
            (&raw mut information).cast(),
            size_of::<BasicInformation>() as u32,
            &mut written,
        )
    };
    (status >= 0)
        .then(|| u32::try_from(information.inherited_from).ok())
        .flatten()
}

// UNICODE_STRING, as NtQueryInformationProcess writes it ahead of the characters it points to.
#[repr(C)]
struct CountedText {
    length: u16,
    maximum_length: u16,
    buffer: *const u16,
}

// The longest command line read; Windows allows 32767 characters.
const COMMAND_LINE_BYTES: usize = 70_000;

// The command line the process was started with, read from its handle; none when Windows would not say.
fn command_line_of(process: &Owned) -> Option<String> {
    // Kept in u64s, so the counted text at its start is aligned as Windows writes it.
    let mut buffer = vec![0u64; COMMAND_LINE_BYTES / 8];
    let mut written = 0u32;
    // SAFETY: the handle is open with PROCESS_QUERY_LIMITED_INFORMATION, which this class needs since Windows 8.1, and
    // the buffer holds the byte count given.
    let status = unsafe {
        NtQueryInformationProcess(
            process.0,
            ProcessCommandLineInformation,
            buffer.as_mut_ptr().cast(),
            (buffer.len() * 8) as u32,
            &mut written,
        )
    };
    if status < 0 || (written as usize) < size_of::<CountedText>() {
        return None;
    }
    // SAFETY: Windows wrote a CountedText at the start of the aligned buffer.
    let text = unsafe { &*buffer.as_ptr().cast::<CountedText>() };
    let characters = usize::from(text.length) / 2;
    if characters == 0 {
        return Some(String::new());
    }
    let start = buffer.as_ptr() as usize;
    let at = text.buffer as usize;
    // The characters follow the counted text inside the buffer; anything else is not read.
    if at < start + size_of::<CountedText>() || at + characters * 2 > start + written as usize {
        return None;
    }
    // SAFETY: the range was checked to lie inside the buffer Windows wrote.
    let slice = unsafe { std::slice::from_raw_parts(text.buffer, characters) };
    Some(String::from_utf16_lossy(slice))
}

fn image_of(process: &Owned) -> Option<String> {
    let mut buffer = vec![0u16; 32_768];
    let mut length = buffer.len() as u32;
    // SAFETY: the buffer holds `length` UTF-16 units and `length` is writable.
    if unsafe {
        QueryFullProcessImageNameW(
            process.0,
            PROCESS_NAME_WIN32,
            buffer.as_mut_ptr(),
            &mut length,
        )
    } == 0
    {
        return None;
    }
    Some(String::from_utf16_lossy(&buffer[..length as usize]))
}

fn in_job(process: &Owned, job: &Owned) -> Result<bool, Failure> {
    let mut result = 0;
    // SAFETY: both handles are open, the process's with PROCESS_QUERY_LIMITED_INFORMATION and the job's with JOB_OBJECT_QUERY.
    if unsafe { IsProcessInJob(process.0, job.0, &mut result) } == 0 {
        return Err(Failure::windows(
            "IsProcessInJob",
            "Windows would not say whether a process is in a job.",
        ));
    }
    Ok(result != 0)
}

// A copy of `job`'s handle inside `target`, not inherited by anything `target` starts: a child that inherited it would
// keep the job open after the runner ended.
fn duplicate_into(job: &Owned, target: &Owned, pid: u32) -> Result<usize, Failure> {
    let mut copy: HANDLE = null_mut();
    // SAFETY: both handles are open, the target's with PROCESS_DUP_HANDLE, and `copy` is writable.
    if unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            job.0,
            target.0,
            &mut copy,
            0,
            0,
            DUPLICATE_SAME_ACCESS,
        )
    } == 0
    {
        return Err(Failure::windows(
            "DuplicateHandle",
            format!("The job could not be given to process {pid}, so nothing was put in it."),
        ));
    }
    Ok(copy as usize)
}

// Closes a handle inside another process; a failure leaves it open, which only keeps an empty job alive.
fn close_in(target: &Owned, value: usize) {
    // SAFETY: the target's handle is open with PROCESS_DUP_HANDLE; with DUPLICATE_CLOSE_SOURCE and no target process,
    // Windows only closes the source handle.
    unsafe {
        DuplicateHandle(
            target.0,
            value as HANDLE,
            null_mut(),
            null_mut(),
            0,
            0,
            DUPLICATE_CLOSE_SOURCE,
        )
    };
}

fn wide(text: &str) -> Vec<u16> {
    OsStr::new(text).encode_wide().chain(once(0)).collect()
}

// These cases share one process as the runner and read its whole job, so they run one at a time:
// `cargo test -- --test-threads=1`.
#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command as Spawn, Stdio};
    use std::sync::OnceLock;
    use std::thread::sleep;
    use std::time::{Duration, Instant};

    use crate::command::JobName;

    // A console of its own with no window, as Retest starts an app server.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    fn unique(label: &str) -> JobName {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default();
        JobName::parse(&format!(
            "Local\\retest-test-{}-{label}-{nanos}",
            std::process::id()
        ))
        .expect("a valid job name")
    }

    // This test process plays the runner: it is put once in a job of its own, as `hold` puts Retest, and keeps that
    // job's handle until it exits. Children it starts from then on are born in that job.
    fn runner_job() -> &'static JobName {
        static JOB: OnceLock<JobName> = OnceLock::new();
        JOB.get_or_init(|| {
            let name = unique("runner");
            let job = create_job(&name).unwrap_or_else(|failure| panic!("{}", failure.problem));
            // SAFETY: the job's handle is open with every right, and GetCurrentProcess names this process.
            assert!(unsafe { AssignProcessToJobObject(job.0, GetCurrentProcess()) } != 0);
            std::mem::forget(job);
            name
        })
    }

    // `cmd` that starts a `ping` of its own and waits for it: a child with a descendant, as a shell running a server is.
    fn shell_with_helper() -> Child {
        runner_job();
        Spawn::new("cmd.exe")
            .args(["/d", "/c", "ping -n 30 127.0.0.1 >nul"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("cmd starts")
    }

    fn adopted(runner: u32, name: &JobName, pid: u32) -> Reply {
        adopt(runner, runner_job(), name, pid)
            .unwrap_or_else(|failure| panic!("adopt failed: {}", failure.problem))
    }

    fn member_ids(name: &JobName) -> Vec<u32> {
        match members(name) {
            Ok(Reply::Members { processes, .. }) => {
                processes.iter().map(|process| process.pid).collect()
            }
            Ok(other) => panic!("members answered {other:?}"),
            Err(failure) => panic!("members failed: {}", failure.problem),
        }
    }

    fn stray_ids(launches: &[JobName]) -> Vec<u32> {
        match strays(std::process::id(), runner_job(), launches) {
            Ok(Reply::Strays { processes, .. }) => {
                processes.iter().map(|process| process.pid).collect()
            }
            Ok(other) => panic!("strays answered {other:?}"),
            Err(failure) => panic!("strays failed: {}", failure.problem),
        }
    }

    fn end_process(pid: u32) {
        if let Ok(Some(process)) = open_process(pid, PROCESS_TERMINATE) {
            // SAFETY: the handle is open with PROCESS_TERMINATE.
            unsafe { TerminateProcess(process.0, ENDED_EXIT_CODE) };
        }
    }

    fn running_pid(pid: u32) -> bool {
        matches!(open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION), Ok(Some(process)) if running(&process).unwrap_or(false))
    }

    fn children_of(parent: u32) -> Vec<u32> {
        parent_ids()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(pid, of)| (of == parent).then_some(pid))
            .collect()
    }

    fn image_ends_with(pid: u32, name: &str) -> bool {
        open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION)
            .ok()
            .flatten()
            .and_then(|process| image_of(&process))
            .is_some_and(|image| image.to_lowercase().ends_with(name))
    }

    fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
        let started = Instant::now();
        while !done() {
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "{what} did not happen within 10 s"
            );
            sleep(Duration::from_millis(25));
        }
    }

    #[test]
    fn an_adopted_child_and_what_it_starts_are_members_until_the_job_ends_them() {
        let runner = std::process::id();
        let mut child = shell_with_helper();
        let name = unique("adopt");
        let Reply::Adopted {
            handle,
            root,
            unheld,
            complete,
            ..
        } = adopted(runner, &name, child.id())
        else {
            panic!("adopt answered something else")
        };
        assert_eq!(root.pid, child.id());
        assert_eq!(root.parent_pid, Some(runner));
        assert!(
            unheld.is_empty(),
            "helpers left outside the job: {unheld:?}"
        );
        assert!(complete, "the search for earlier helpers finished");
        assert!(handle > 0 && handle % 4 == 0);
        wait_for("ping to start inside the job", || {
            member_ids(&name).len() >= 2
        });
        let ids = member_ids(&name);
        assert!(ids.contains(&child.id()), "{ids:?}");
        // Each member's parent and command line come from its own handle: the shell's are this process and its words,
        // and the ping's parent is the shell.
        let Ok(Reply::Members { processes, .. }) = members(&name) else {
            panic!("members failed")
        };
        let shell = processes
            .iter()
            .find(|process| process.pid == child.id())
            .expect("the shell is a member");
        assert_eq!(shell.parent_pid, Some(runner));
        assert!(
            shell
                .command_line
                .as_deref()
                .is_some_and(|line| line.contains("ping -n 30 127.0.0.1")),
            "{:?}",
            shell.command_line
        );
        let ping = processes
            .iter()
            .find(|process| process.pid != child.id())
            .expect("the ping is a member");
        assert_eq!(ping.parent_pid, Some(child.id()));
        assert!(
            ping.command_line
                .as_deref()
                .is_some_and(|line| line.to_lowercase().contains("ping")),
            "{:?}",
            ping.command_line
        );
        assert!(matches!(end(runner, &name), Ok(Reply::Ended { .. })));
        wait_for("the job to empty", || member_ids(&name).is_empty());
        assert!(child.wait().is_ok());
        assert!(matches!(
            release(runner, &name, handle),
            Ok(Reply::Released { .. })
        ));
        assert!(members(&name).is_err(), "a released job is no longer held");
    }

    #[test]
    fn a_child_that_ended_before_it_was_held_is_named_and_what_it_started_is_held() {
        let runner = std::process::id();
        runner_job();
        let mut child = Spawn::new("cmd.exe")
            .args(["/d", "/c", "start /b ping -n 30 127.0.0.1 >nul"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("cmd starts");
        // Waiting keeps this process's handle on the child, so its pid stays its own, as Node's does.
        assert!(child.wait().is_ok());
        let name = unique("ended");
        let Reply::Adopted {
            handle,
            root,
            ended,
            late,
            ..
        } = adopted(runner, &name, child.id())
        else {
            panic!("adopt answered something else")
        };
        assert!(ended, "the shell had ended");
        assert_eq!(root.pid, child.id());
        assert!(
            late.iter().any(|process| process
                .image
                .as_deref()
                .is_some_and(|image| image.to_lowercase().ends_with("ping.exe"))),
            "the ping the shell left running is held: {late:?}"
        );
        assert!(!member_ids(&name).is_empty());
        assert!(matches!(end(runner, &name), Ok(Reply::Ended { .. })));
        wait_for("the job to empty", || member_ids(&name).is_empty());
        assert!(matches!(
            release(runner, &name, handle),
            Ok(Reply::Released { .. })
        ));
    }

    #[test]
    fn a_taken_name_a_stranger_and_another_start_are_refused() {
        let runner = std::process::id();
        let mut child = shell_with_helper();
        let name = unique("taken");
        let Reply::Adopted { handle, .. } = adopted(runner, &name, child.id()) else {
            panic!("the first adoption failed")
        };
        assert!(
            matches!(adopt(runner, runner_job(), &name, child.id()), Err(failure) if failure.problem.contains("already has this name"))
        );
        // Process 4 is the System process, which this process did not start.
        assert!(
            matches!(adopt(runner, runner_job(), &unique("stranger"), 4), Err(failure) if failure.problem.contains("not started by"))
        );
        assert!(
            matches!(adopt(runner, &unique("nojob"), &unique("nowhere"), child.id()), Err(failure) if failure.problem.contains("no longer holds"))
        );
        assert!(
            matches!(release(runner, &name, handle), Err(failure) if failure.problem.contains("still running"))
        );
        let Ok(Reply::Process {
            process: Some(identity),
            in_job: Some(true),
        }) = process(child.id(), Some(&name))
        else {
            panic!("the child is not in its job")
        };
        assert!(matches!(
            terminate(runner, &name, child.id(), identity.started_at + 1),
            Ok(Reply::Terminated {
                outcome: Outcome::Different,
                ..
            })
        ));
        assert!(matches!(
            terminate(runner, &name, child.id(), identity.started_at),
            Ok(Reply::Terminated {
                outcome: Outcome::Terminated,
                ..
            })
        ));
        assert!(child.wait().is_ok());
        assert!(matches!(end(runner, &name), Ok(Reply::Ended { .. })));
        wait_for("the job to empty", || member_ids(&name).is_empty());
        assert!(matches!(
            release(runner, &name, handle),
            Ok(Reply::Released { .. })
        ));
    }

    // The adoption window: a shell starts a second shell, which starts a ping and ends before the first is held. The
    // ping's parent no longer runs, so the search cannot tie it to the launch; the runner's job still holds it, and
    // `strays` names it once nothing running stands behind it.
    #[test]
    fn a_grandchild_whose_parent_ended_before_the_hold_is_a_stray_of_the_runners_job() {
        let runner = std::process::id();
        runner_job();
        let mut child = Spawn::new("cmd.exe")
            .args([
                "/d",
                "/c",
                "cmd /d /c start /b ping -n 30 127.0.0.1 >nul & ping -n 30 127.0.0.1 >nul",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("cmd starts");
        // The inner shell ends as soon as it has started its ping, which then stands on nothing.
        let mut orphans = Vec::new();
        wait_for("the inner shell to start its ping and end", || {
            orphans = stray_ids(&[])
                .into_iter()
                .filter(|pid| image_ends_with(*pid, "ping.exe"))
                .collect();
            !orphans.is_empty()
        });
        let name = unique("window");
        let Reply::Adopted { handle, late, .. } = adopted(runner, &name, child.id()) else {
            panic!("adopt answered something else")
        };
        for pid in &orphans {
            assert!(
                late.iter().all(|process| process.pid != *pid),
                "the orphaned ping {pid} cannot be tied to the launch"
            );
            assert!(
                stray_ids(std::slice::from_ref(&name)).contains(pid),
                "the runner's job names the orphaned ping {pid}"
            );
        }
        assert!(matches!(end(runner, &name), Ok(Reply::Ended { .. })));
        wait_for("the launch's job to empty", || member_ids(&name).is_empty());
        assert!(child.wait().is_ok());
        for pid in &orphans {
            assert!(
                running_pid(*pid),
                "ending the launch's job left {pid} running"
            );
            assert!(stray_ids(&[]).contains(pid));
            end_process(*pid);
        }
        assert!(matches!(
            release(runner, &name, handle),
            Ok(Reply::Released { .. })
        ));
    }

    // A helper born before the hold that is already in a job of its own inside the runner's, as a browser's sandboxed
    // helpers are, cannot be moved beside the launch: it is held by its parent, and no stray while its parent runs.
    #[test]
    fn a_helper_in_a_job_of_its_own_is_held_by_its_parent() {
        let runner = std::process::id();
        let mut child = shell_with_helper();
        let mut helper = Vec::new();
        wait_for("the shell to start its ping", || {
            helper = children_of(child.id());
            !helper.is_empty()
        });
        let sandbox = unique("sandbox");
        let sandbox_job =
            create_job(&sandbox).unwrap_or_else(|failure| panic!("{}", failure.problem));
        for pid in &helper {
            let process = open_process(*pid, PROCESS_SET_QUOTA | PROCESS_TERMINATE)
                .ok()
                .flatten()
                .expect("the ping opens");
            // SAFETY: both handles are open with the rights assignment needs.
            assert!(unsafe { AssignProcessToJobObject(sandbox_job.0, process.0) } != 0);
        }
        let name = unique("parented");
        let Reply::Adopted {
            handle,
            by_parent,
            unheld,
            complete,
            ..
        } = adopted(runner, &name, child.id())
        else {
            panic!("adopt answered something else")
        };
        assert!(unheld.is_empty(), "nothing is left unheld: {unheld:?}");
        assert!(complete);
        for pid in &helper {
            assert!(
                by_parent.iter().any(|process| process.pid == *pid),
                "{pid} is held by its parent: {by_parent:?}"
            );
            assert!(
                !stray_ids(std::slice::from_ref(&name)).contains(pid),
                "a helper whose parent runs in the launch's job is no stray"
            );
        }
        // Ending the sandbox's last handle ends the helper, as the browser's own handle does when the browser ends.
        drop(sandbox_job);
        assert!(matches!(end(runner, &name), Ok(Reply::Ended { .. })));
        assert!(child.wait().is_ok());
        wait_for("the helper to end with its job", || {
            helper.iter().all(|pid| !running_pid(*pid))
        });
        wait_for("the launch's job to empty", || member_ids(&name).is_empty());
        assert!(matches!(
            release(runner, &name, handle),
            Ok(Reply::Released { .. })
        ));
    }

    // Ctrl+C reaches a process on a console of its own, and not the runner. This process turns Ctrl+C on for itself
    // first, since one started from a service, as an SSH session or a CI step is, inherits it turned off, and the child
    // inherits it from here. Being the supervisor too, this process leaves its own console as it sends; a child that
    // shares the runner's console is refused by the real supervisor in tests/unit/process-supervisor-windows.test.ts.
    #[test]
    fn ctrl_c_reaches_a_console_of_its_own() {
        let runner = std::process::id();
        runner_job();
        // SAFETY: a null handler with FALSE turns Ctrl+C on for this process; it has no other preconditions.
        unsafe { SetConsoleCtrlHandler(None, 0) };
        let mut own = Spawn::new("ping.exe")
            .args(["-n", "30", "127.0.0.1"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("ping starts");
        let name = unique("interrupt");
        let Reply::Adopted { handle, .. } = adopted(runner, &name, own.id()) else {
            panic!("adopt answered something else")
        };
        // The child makes its own console as it starts; until it has, no Ctrl+C can be sent to it.
        sleep(Duration::from_millis(500));
        let started = Instant::now();
        let (console, reached) = match interrupt(runner, &name, None, Key::CtrlC) {
            Ok(Reply::Interrupted {
                console, reached, ..
            }) => (console, reached),
            Ok(other) => panic!("interrupt answered {other:?}"),
            Err(failure) => panic!("Ctrl+C was not sent: {failure:?}"),
        };
        assert_eq!(console, own.id());
        assert!(!reached.contains(&runner));
        assert!(own.wait().is_ok());
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "ping ended on Ctrl+C, long before its 30 pings"
        );
        wait_for("the job to empty", || member_ids(&name).is_empty());
        // Windows lists a process in its job for a moment after it ended, and release waits for that list to empty.
        wait_for("the job's handle to be given back", || {
            matches!(release(runner, &name, handle), Ok(Reply::Released { .. }))
        });
    }

    // A process's start and the clock each look of the search is stamped with are one clock. Measured here: how often,
    // and by how much, the start Windows gives a child reads earlier than the clock taken just before it was started.
    #[test]
    fn a_childs_start_reads_no_later_than_the_clock_once_it_has_started() {
        let mut early = 0u32;
        let mut widest = 0u64;
        for _ in 0..20 {
            let before = now();
            let mut child = Spawn::new("cmd.exe")
                .args(["/d", "/c", "exit 0"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("cmd starts");
            let after = now();
            let process = open_process(child.id(), PROCESS_QUERY_LIMITED_INFORMATION)
                .ok()
                .flatten()
                .expect("the child opens");
            let start = started_at(&process).expect("its start reads");
            assert!(
                start <= after,
                "a start later than the clock read once it had started"
            );
            if start < before {
                early += 1;
                widest = widest.max(before - start);
            }
            assert!(child.wait().is_ok());
        }
        println!(
            "starts read earlier than the clock taken before the launch: {early} of 20, by at most {widest} ticks"
        );
    }
}
