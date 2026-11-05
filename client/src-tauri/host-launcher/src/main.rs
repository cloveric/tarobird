#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

#[cfg(windows)]
mod storage_probe;

use serde::Deserialize;
use std::{
    collections::{BTreeMap, VecDeque},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Configuration {
    version: u32,
    directory: PathBuf,
    home: PathBuf,
    executable: PathBuf,
    entrypoint: PathBuf,
    control_pipe: String,
    supervisor: String,
    environment: BTreeMap<String, String>,
}

impl Configuration {
    fn read(file: &Path) -> Result<Self, String> {
        let metadata = std::fs::symlink_metadata(file).map_err(|_| "launcher_config_missing")?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 64 * 1024 {
            return Err("launcher_config_invalid".into());
        }
        let config: Self = serde_json::from_slice(
            &std::fs::read(file).map_err(|_| "launcher_config_read_failed")?,
        )
        .map_err(|_| "launcher_config_invalid")?;
        if config.version != 1
            || !config.directory.is_absolute()
            || !config.home.is_absolute()
            || !config.executable.is_absolute()
            || !config.entrypoint.is_absolute()
            || !config.executable.is_file()
            || !config.entrypoint.is_file()
            || !config.control_pipe.starts_with(r"\\.\pipe\tarobot-hub-")
            || config.environment.get("TAROBOT_HOST_SUPERVISOR") != Some(&config.supervisor)
        {
            return Err("launcher_config_invalid".into());
        }
        if config.supervisor.is_empty()
            || config
                .environment
                .iter()
                .any(|(key, value)| key.contains(['\0', '=']) || value.contains('\0'))
        {
            return Err("launcher_environment_invalid".into());
        }
        let expected = config.directory.join("host-service").join("launcher.json");
        if std::fs::canonicalize(file).ok() != std::fs::canonicalize(expected).ok() {
            return Err("launcher_config_owner_mismatch".into());
        }
        Ok(config)
    }
    fn enabled(&self) -> bool {
        std::fs::read_to_string(self.directory.join("desktop-enabled.json"))
            .map(|text| text.trim() == "true")
            .unwrap_or(false)
    }
}

fn quote_argument(value: &str) -> String {
    let mut result = String::from("\"");
    let mut slashes = 0;
    for character in value.chars() {
        if character == '\\' {
            slashes += 1;
            continue;
        }
        result.extend(std::iter::repeat_n(
            '\\',
            if character == '"' {
                slashes * 2 + 1
            } else {
                slashes
            },
        ));
        result.push(character);
        slashes = 0;
    }
    result.extend(std::iter::repeat_n('\\', slashes * 2));
    result.push('"');
    result
}

fn sanitize_loader_environment(environment: &mut BTreeMap<String, String>) {
    environment.retain(|key, _| {
        !matches!(
            key.as_str(),
            "NODE_OPTIONS" | "NODE_PATH" | "LD_PRELOAD" | "LD_LIBRARY_PATH"
        ) && !key.starts_with("DYLD_")
    });
}

#[derive(Default)]
struct RestartBudget {
    failures: VecDeque<Instant>,
}
impl RestartBudget {
    fn delay(&mut self, now: Instant, uptime: Duration) -> Option<Duration> {
        const WINDOW: Duration = Duration::from_secs(300);
        if uptime >= WINDOW {
            self.failures.clear();
        }
        while self
            .failures
            .front()
            .is_some_and(|time| now.duration_since(*time) >= WINDOW)
        {
            self.failures.pop_front();
        }
        if self.failures.len() >= 5 {
            return None;
        }
        self.failures.push_back(now);
        Some(Duration::from_secs(
            (1u64 << (self.failures.len() - 1)).min(30),
        ))
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{
        ffi::c_void,
        fs::{File, OpenOptions},
        io::Write,
        mem::size_of,
        os::windows::io::AsRawHandle,
        ptr::{null, null_mut},
    };
    type Handle = *mut c_void;
    const CREATE_SUSPENDED: u32 = 0x00000004;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    const CREATE_UNICODE_ENVIRONMENT: u32 = 0x00000400;
    const STARTF_USESTDHANDLES: u32 = 0x00000100;
    const HANDLE_FLAG_INHERIT: u32 = 1;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x00002000;
    const WAIT_OBJECT_0: u32 = 0;
    const WAIT_TIMEOUT: u32 = 258;
    #[repr(C)]
    struct StartupInfo {
        cb: u32,
        reserved: *mut u16,
        desktop: *mut u16,
        title: *mut u16,
        x: u32,
        y: u32,
        x_size: u32,
        y_size: u32,
        x_chars: u32,
        y_chars: u32,
        fill_attribute: u32,
        flags: u32,
        show_window: u16,
        reserved2_len: u16,
        reserved2: *mut u8,
        stdin: Handle,
        stdout: Handle,
        stderr: Handle,
    }
    #[repr(C)]
    struct ProcessInformation {
        process: Handle,
        thread: Handle,
        process_id: u32,
        thread_id: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct BasicLimits {
        process_user_time: i64,
        job_user_time: i64,
        flags: u32,
        minimum_working_set: usize,
        maximum_working_set: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_operations: u64,
        write_operations: u64,
        other_operations: u64,
        read_bytes: u64,
        write_bytes: u64,
        other_bytes: u64,
    }
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimits {
        basic: BasicLimits,
        io: IoCounters,
        process_memory: usize,
        job_memory: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            class: i32,
            information: *const c_void,
            length: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
        fn SetHandleInformation(handle: Handle, mask: u32, flags: u32) -> i32;
        fn CreateProcessW(
            application: *const u16,
            command_line: *mut u16,
            process_attributes: *const c_void,
            thread_attributes: *const c_void,
            inherit_handles: i32,
            flags: u32,
            environment: *const c_void,
            directory: *const u16,
            startup: *const StartupInfo,
            information: *mut ProcessInformation,
        ) -> i32;
        fn ResumeThread(thread: Handle) -> u32;
        fn TerminateProcess(process: Handle, exit_code: u32) -> i32;
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
        fn GetExitCodeProcess(process: Handle, exit_code: *mut u32) -> i32;
    }
    struct OwnedHandle(Handle);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain([0]).collect()
    }
    fn error(operation: &str) -> String {
        format!("{operation}: {}", std::io::Error::last_os_error())
    }
    fn log(file: &mut File, message: &str) {
        let _ = writeln!(file, "[host-launcher] {message}");
    }

    fn run_once(config: &Configuration, log_file: &mut File) -> Result<u32, String> {
        let job = OwnedHandle(unsafe { CreateJobObjectW(null(), null()) });
        if job.0.is_null() {
            return Err(error("CreateJobObject"));
        }
        let limits = ExtendedLimits {
            basic: BasicLimits {
                flags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                ..Default::default()
            },
            ..Default::default()
        };
        if unsafe {
            SetInformationJobObject(
                job.0,
                9,
                &limits as *const _ as *const c_void,
                size_of::<ExtendedLimits>() as u32,
            )
        } == 0
        {
            return Err(error("SetInformationJobObject"));
        }
        let input = File::open("NUL").map_err(|_| "launcher_stdin_unavailable")?;
        let output = log_file
            .try_clone()
            .map_err(|_| "launcher_log_unavailable")?;
        for handle in [input.as_raw_handle(), output.as_raw_handle()] {
            if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) }
                == 0
            {
                return Err(error("SetHandleInformation"));
            }
        }
        let executable = config.executable.to_string_lossy();
        let arguments = [
            executable.as_ref(),
            config
                .entrypoint
                .to_str()
                .ok_or("launcher_entry_encoding")?,
            "host",
            "run",
            "--state-dir",
            config
                .directory
                .to_str()
                .ok_or("launcher_directory_encoding")?,
        ];
        let mut command_line = wide(&arguments.map(quote_argument).join(" "));
        let application = wide(&executable);
        let directory = wide(config.home.to_str().ok_or("launcher_home_encoding")?);
        let mut environment = BTreeMap::new();
        for (name, value) in std::env::vars() {
            environment.insert(name.to_ascii_uppercase(), value);
        }
        for (name, value) in &config.environment {
            environment.insert(name.to_ascii_uppercase(), value.clone());
        }
        sanitize_loader_environment(&mut environment);
        let environment: Vec<u16> = environment
            .iter()
            .flat_map(|(name, value)| wide(&format!("{name}={value}")))
            .chain([0])
            .collect();
        let startup = StartupInfo {
            cb: size_of::<StartupInfo>() as u32,
            reserved: null_mut(),
            desktop: null_mut(),
            title: null_mut(),
            x: 0,
            y: 0,
            x_size: 0,
            y_size: 0,
            x_chars: 0,
            y_chars: 0,
            fill_attribute: 0,
            flags: STARTF_USESTDHANDLES,
            show_window: 0,
            reserved2_len: 0,
            reserved2: null_mut(),
            stdin: input.as_raw_handle(),
            stdout: output.as_raw_handle(),
            stderr: output.as_raw_handle(),
        };
        let mut information = ProcessInformation {
            process: null_mut(),
            thread: null_mut(),
            process_id: 0,
            thread_id: 0,
        };
        if unsafe {
            CreateProcessW(
                application.as_ptr(),
                command_line.as_mut_ptr(),
                null(),
                null(),
                1,
                CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                environment.as_ptr() as *const c_void,
                directory.as_ptr(),
                &startup,
                &mut information,
            )
        } == 0
        {
            return Err(error("CreateProcess"));
        }
        let process = OwnedHandle(information.process);
        let thread = OwnedHandle(information.thread);
        // The child cannot execute one instruction before job membership. This
        // closes the spawn/Assign race where a worker could escape supervision.
        if unsafe { AssignProcessToJobObject(job.0, process.0) } == 0 {
            let message = error("AssignProcessToJobObject");
            unsafe {
                TerminateProcess(process.0, 1);
            }
            return Err(message);
        }
        if unsafe { ResumeThread(thread.0) } == u32::MAX {
            return Err(error("ResumeThread"));
        }
        log(
            log_file,
            &format!("started host pid {}", information.process_id),
        );
        loop {
            let wait = unsafe { WaitForSingleObject(process.0, 250) };
            if wait == WAIT_OBJECT_0 {
                let mut code = 1;
                if unsafe { GetExitCodeProcess(process.0, &mut code) } == 0 {
                    return Err(error("GetExitCodeProcess"));
                }
                return Ok(code);
            }
            if wait != WAIT_TIMEOUT {
                return Err(error("WaitForSingleObject"));
            }
            // Desired state only controls future starts/restarts. The manager
            // owns authenticated (and when requested, drain-guarded) shutdown.
            // Polling enabled here used to send an unguarded stop ahead of the
            // manager's drained-stop, violating the drain lease contract.

        }
        // OwnedHandle closes the job last; any residual descendants are ended.
    }
    pub fn run(config: Configuration) -> Result<(), String> {
        let mut output = OpenOptions::new()
            .create(true)
            .append(true)
            .open(config.directory.join("hub.log"))
            .map_err(|_| "launcher_log_unavailable")?;
        let mut budget = RestartBudget::default();
        while config.enabled() {
            let started = Instant::now();
            let code = match run_once(&config, &mut output) {
                Ok(code) => code,
                Err(error) => {
                    log(&mut output, &error);
                    1
                }
            };
            if code == 0 || code == 78 || !config.enabled() {
                return Ok(());
            }
            let Some(delay) = budget.delay(Instant::now(), started.elapsed()) else {
                log(
                    &mut output,
                    "automatic restart paused after repeated failures; use host start to retry",
                );
                return Err("launcher_restart_limit".into());
            };
            log(
                &mut output,
                &format!("host exited {code}; retry in {}s", delay.as_secs()),
            );
            let until = Instant::now() + delay;
            while Instant::now() < until {
                if !config.enabled() {
                    return Ok(());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        Ok(())
    }
}

#[cfg(windows)]
fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if (args.len() == 2 || args.len() == 3) && args[0] == "--inspect-host-directory" {
        let result = args[1].to_str().and_then(|value| value.parse::<u32>().ok())
            .ok_or_else(|| "host_directory_probe_failed".to_owned())
            .and_then(|pid| storage_probe::inspect(args.get(2).map(Path::new), pid));
        match result {
            Ok(value) => { println!("{}", value); return; }
            Err(error) => { eprintln!("{}", storage_probe::probe_failure(&error)); std::process::exit(78); }
        }
    }
    // A service launcher must never write even its log in a virtualized view.
    if storage_probe::package_family(std::process::id()) != Ok(None) { std::process::exit(78); }
    let result = if args.len() == 2 && args[0] == "--config" {
        Configuration::read(Path::new(&args[1])).and_then(windows::run)
    } else {
        Err("usage: tarobot-host-launcher --config PATH".into())
    };
    if result.is_err() {
        std::process::exit(1);
    }
}
#[cfg(not(windows))]
fn main() {
    eprintln!("tarobot-host-launcher is a Windows GUI service helper");
    std::process::exit(78);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quotes_windows_paths_without_shell_interpretation() {
        assert_eq!(quote_argument(r"C:\Users\A B\"), "\"C:\\Users\\A B\\\\\"");
        assert_eq!(quote_argument("a\"b"), "\"a\\\"b\"");
        assert_eq!(quote_argument("x & y $ z"), "\"x & y $ z\"");
    }
    #[test]
    fn bounds_crash_retries_and_recovers_after_a_healthy_interval() {
        let mut budget = RestartBudget::default();
        let now = Instant::now();
        for seconds in [1, 2, 4, 8, 16] {
            assert_eq!(
                budget.delay(now, Duration::ZERO),
                Some(Duration::from_secs(seconds))
            );
        }
        assert!(budget.delay(now, Duration::ZERO).is_none());
        assert_eq!(
            budget.delay(now + Duration::from_secs(301), Duration::from_secs(301)),
            Some(Duration::from_secs(1))
        );
    }
    #[test]
    fn absent_desired_state_is_stopped() {
        let config = Configuration {
            version: 1,
            directory: PathBuf::from("/not-a-real-host"),
            home: PathBuf::from("/"),
            executable: PathBuf::new(),
            entrypoint: PathBuf::new(),
            control_pipe: String::new(),
            supervisor: String::new(),
            environment: BTreeMap::new(),
        };
        assert!(!config.enabled());
    }
    #[test]
    fn removes_inherited_runtime_loader_overrides() {
        let mut environment = [
            "PATH",
            "HOME",
            "NODE_OPTIONS",
            "NODE_PATH",
            "LD_PRELOAD",
            "LD_LIBRARY_PATH",
            "DYLD_INSERT_LIBRARIES",
            "DYLD_UNKNOWN_FUTURE_OPTION",
        ]
        .map(|key| (key.to_string(), "value".to_string()))
        .into_iter()
        .collect();
        sanitize_loader_environment(&mut environment);
        assert_eq!(
            environment.keys().map(String::as_str).collect::<Vec<_>>(),
            vec!["HOME", "PATH"]
        );
    }
    #[test]
    fn validates_exact_owner_config_and_rejects_unknown_fields() {
        let directory =
            std::env::temp_dir().join(format!("tarobot-launcher-config-{}", std::process::id()));
        std::fs::create_dir_all(directory.join("host-service")).unwrap();
        let file = directory.join("host-service/launcher.json");
        let entry = directory.join("entry.js");
        std::fs::write(&entry, "").unwrap();
        let mut value = serde_json::json!({ "version":1, "directory":directory, "home":directory, "executable":std::env::current_exe().unwrap(), "entrypoint":entry,
            "control_pipe":r"\\.\pipe\tarobot-hub-fixture", "supervisor":"fixture", "environment":{"TAROBOT_HOST_SUPERVISOR":"fixture"} });
        std::fs::write(&file, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(Configuration::read(&file).is_ok());
        value["unexpected"] = serde_json::json!(true);
        std::fs::write(&file, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(Configuration::read(&file).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
