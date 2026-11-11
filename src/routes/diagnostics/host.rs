//! Bounded host measurements obtained through sysinfo, without shell commands.
use serde::Serialize;
use std::{
    sync::{LazyLock, Mutex},
    time::Instant,
};
use sysinfo::{CpuRefreshKind, Disks, MemoryRefreshKind, RefreshKind, System};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Memory {
    total_bytes: u64,
    available_bytes: u64,
    swap_total_bytes: u64,
    swap_used_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Disk {
    mount: String,
    filesystem_device_id: Option<u64>,
    total_bytes: u64,
    available_bytes: u64,
}

fn filesystem_device_id(path: &std::path::Path) -> Option<u64> {
    // Namespace-local filesystem identity; it is not a persistent physical-disk identifier.
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(path).ok().map(|metadata| metadata.dev())
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Snapshot {
    cpu_count: usize,
    cpu_percent: Option<f32>,
    cpu_sample_at: Option<String>,
    cpu_sample_window_seconds: Option<f64>,
    load: [f64; 3],
    memory: Memory,
    disks: Vec<Disk>,
    disks_truncated: bool,
    uptime_seconds: u64,
}

struct Sampler {
    system: System,
    previous: Instant,
    cpu_sample: Option<(f32, String, f64)>,
}

impl Sampler {
    fn new() -> Self {
        Self {
            system: System::new_with_specifics(
                RefreshKind::nothing()
                    .with_cpu(CpuRefreshKind::nothing().with_cpu_usage())
                    .with_memory(MemoryRefreshKind::everything()),
            ),
            previous: Instant::now(),
            cpu_sample: None,
        }
    }

    fn read(&mut self) -> Snapshot {
        let elapsed = self.previous.elapsed();
        if elapsed >= sysinfo::MINIMUM_CPU_UPDATE_INTERVAL {
            self.system.refresh_cpu_usage();
            let value = self.system.global_cpu_usage();
            if value.is_finite() && (0.0..=100.0).contains(&value) {
                self.cpu_sample = Some((
                    value,
                    chrono::Utc::now().to_rfc3339(),
                    elapsed.as_secs_f64(),
                ));
            }
            self.previous = Instant::now();
        }
        self.system.refresh_memory();
        let load = System::load_average();
        let disks = Disks::new_with_refreshed_list();
        let mut rows: Vec<Disk> = disks
            .list()
            .iter()
            .filter(|disk| disk.total_space() > 0)
            .map(|disk| Disk {
                mount: disk.mount_point().to_string_lossy().into_owned(),
                filesystem_device_id: filesystem_device_id(disk.mount_point()),
                total_bytes: disk.total_space(),
                available_bytes: disk.available_space(),
            })
            .collect();
        rows.sort_by(|left, right| left.mount.cmp(&right.mount));
        let truncated = rows.len() > 16;
        rows.truncate(16);
        Snapshot {
            cpu_count: self.system.cpus().len(),
            cpu_percent: self.cpu_sample.as_ref().map(|sample| sample.0),
            cpu_sample_at: self.cpu_sample.as_ref().map(|sample| sample.1.clone()),
            cpu_sample_window_seconds: self.cpu_sample.as_ref().map(|sample| sample.2),
            load: [load.one, load.five, load.fifteen],
            memory: Memory {
                total_bytes: self.system.total_memory(),
                available_bytes: self.system.available_memory(),
                swap_total_bytes: self.system.total_swap(),
                swap_used_bytes: self.system.used_swap(),
            },
            disks: rows,
            disks_truncated: truncated,
            uptime_seconds: System::uptime(),
        }
    }
}

pub(super) fn collect() -> Result<Snapshot, &'static str> {
    if !sysinfo::IS_SUPPORTED_SYSTEM {
        return Err("unsupported_system");
    }
    static SAMPLER: LazyLock<Mutex<Sampler>> = LazyLock::new(|| Mutex::new(Sampler::new()));
    SAMPLER
        .lock()
        .map_err(|_| "measurement_unavailable")
        .map(|mut sampler| sampler.read())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn filesystem_identity_is_observed_and_missing_paths_stay_unknown() {
        let directory = std::env::temp_dir();
        assert!(filesystem_device_id(&directory).is_some());
        assert_eq!(
            filesystem_device_id(&directory),
            filesystem_device_id(&directory.join("."))
        );
        let missing = directory.join(format!("saudade-missing-{}", uuid::Uuid::new_v4()));
        assert_eq!(filesystem_device_id(&missing), None);
        let disk = Disk {
            mount: missing.to_string_lossy().into_owned(),
            filesystem_device_id: None,
            total_bytes: 100,
            available_bytes: 50,
        };
        assert!(serde_json::to_value(disk).unwrap()["filesystemDeviceId"].is_null());
    }
}
