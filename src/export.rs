//! 流式 MP4 导出会话：前端逐帧 append，后端累积 sample table 并在收尾写 moov。
//! Streaming MP4 export sessions for the offscreen frame-by-frame exporter.
//!
//! 布局是 `ftyp + mdat(video) + [mdat(audio)] + moov`：`moov` 的长度随帧数
//! 变化，无法在写第一帧前预留，所以放在文件尾（本地文件播放不受影响）。
//! 音频在收尾时整段写入——混音要等演出走完才知道有哪些声音，而那时视频字节数
//! 已知，音频 `mdat` 的偏移可以直接算出来。写盘期间用 `.part` 临时文件，成功
//! 才原子改名，取消则删除。

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use crate::mp4::{self, AudioAac, Mp4Config, Sample};
use crate::project;

/// 收尾时整段写入的 AAC 音轨。
#[derive(Clone, Debug, Default)]
pub struct AudioTrackInput {
    /// 拼接好的 AAC 帧字节。
    pub data: Vec<u8>,
    /// 每个 AAC 帧的字节数，顺序与 `data` 一致。
    pub samples: Vec<u32>,
    pub sample_rate: u32,
    pub channels: u16,
    pub bitrate: u32,
    /// AudioSpecificConfig（`decoderConfig.description`）。
    pub asc: Vec<u8>,
}

/// 单次导出任务的文件与索引状态。
struct ExportJob {
    part: PathBuf,
    final_path: PathBuf,
    relative: String,
    file: Option<File>,
    config: Mp4Config,
    samples: Vec<Sample>,
    bytes: u64,
    /// `mdat` box 头的绝对偏移，finish 时回来回填真实长度。
    mdat_size_at: u64,
    /// 音频 `mdat` payload 的绝对偏移；没有音轨时为 `None`。
    audio_offset: Option<u32>,
}

/// 所有进行中的导出任务，作为 Tauri 托管状态注入。
#[derive(Default)]
pub struct ExportState {
    jobs: Mutex<HashMap<String, ExportJob>>,
    next_id: AtomicU64,
}

/// 清掉 `dir` 下没有会话在写的 `.part` 残留（上次异常退出留下的半成品）。
///
/// 只删 `jobs` 里不认识的 `.part`：同一目录里另一次导出可能正在写，删掉它
/// 就是把别人写了一半的成片掐断。
fn sweep_parts(dir: &std::path::Path, jobs: &HashMap<String, ExportJob>) -> usize {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let active: Vec<PathBuf> = jobs.values().map(|job| job.part.clone()).collect();
    let own = format!("export-{}-", std::process::id());
    let now = std::time::SystemTime::now();
    let mut removed = 0;
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".part") || active.contains(&path) {
            continue;
        }
        // Another Pamela instance may still be writing this file. Remove only
        // our own leftovers, or ones old enough that no live session owns them.
        let stale = name.contains(&own)
            || entry
                .metadata()
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|time| now.duration_since(time).ok())
                .is_some_and(|age| age.as_secs() > 3600);
        if stale && fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// 导出只允许写到项目内的 `exports/*.mp4`。
fn validate_relative(relative: &str) -> Result<String, String> {
    let normalized = relative.replace('\\', "/");
    if !normalized.starts_with("exports/") {
        return Err("导出文件必须放在项目的 exports/ 目录下".to_string());
    }
    if normalized.split('/').any(|part| part == "..") {
        return Err("导出路径不能包含 ..".to_string());
    }
    if !normalized.ends_with(".mp4") {
        return Err("导出文件名必须以 .mp4 结尾".to_string());
    }
    let name = normalized.rsplit('/').next().unwrap_or("");
    if name.len() <= ".mp4".len() {
        return Err("导出文件名不能为空".to_string());
    }
    Ok(normalized)
}

impl ExportState {
    /// 创建 `.part` 文件、写 `ftyp` 与占位的 `mdat` 头，返回任务 id。
    pub fn begin(&self, root: &str, relative: &str, config: Mp4Config) -> Result<String, String> {
        let relative = validate_relative(relative)?;
        let final_path = project::resolve(root, &relative).map_err(|e| e.to_string())?;
        if let Some(parent) = final_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let name = final_path
            .file_name()
            .ok_or_else(|| "导出文件名无效".to_string())?;
        // The session id is part of the temp name: two Pamela instances
        // exporting the same file must not open (and truncate) one `.part`.
        let id = format!(
            "export-{}-{}",
            std::process::id(),
            self.next_id.fetch_add(1, Ordering::Relaxed)
        );
        let part = final_path.with_file_name(format!("{}.{id}.part", name.to_string_lossy()));

        // 「清扫 → 建文件 → 登记」在锁内一次做完：清扫要排除仍在写盘的
        // 会话，否则并发开始两次导出时会互相删掉对方的临时文件。
        let mut jobs = self.jobs.lock().map_err(|_| "导出状态已损坏".to_string())?;
        // 同一目标路径只允许一个会话：两个会话会用 truncate 互相清空 .part，
        // 最终成片的长度与索引都会错位。
        let same_target = |job: &ExportJob| {
            job.final_path == final_path
                || job
                    .final_path
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&final_path.to_string_lossy())
        };
        if jobs.values().any(same_target) {
            return Err(format!(
                "{} 正在导出，请等待完成或取消",
                final_path.display()
            ));
        }
        if let Some(dir) = part.parent() {
            sweep_parts(dir, &jobs);
        }

        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&part)
            .map_err(|e| e.to_string())?;
        let ftyp = mp4::ftyp();
        let header = mp4::mdat_header(0);
        file.write_all(&ftyp)
            .and_then(|()| file.write_all(&header))
            .map_err(|e| e.to_string())?;

        let job = ExportJob {
            part,
            final_path,
            relative,
            file: Some(file),
            config,
            samples: Vec::new(),
            bytes: 0,
            mdat_size_at: ftyp.len() as u64,
            audio_offset: None,
        };
        jobs.insert(id.clone(), job);
        Ok(id)
    }

    /// 追加一帧编码数据。`data` 是前端已经解码好的字节。
    pub fn append(&self, id: &str, data: &[u8], keyframe: bool) -> Result<(), String> {
        let mut jobs = self.jobs.lock().map_err(|_| "导出状态已损坏".to_string())?;
        let job = jobs
            .get_mut(id)
            .ok_or_else(|| "导出任务不存在或已结束".to_string())?;
        let size = u32::try_from(data.len())
            .map_err(|_| "单帧数据超过 32 位样本尺寸上限".to_string())?;
        let write = job
            .file
            .as_mut()
            .ok_or_else(|| "导出文件句柄已关闭".to_string())?
            .write_all(data);
        if let Err(error) = write {
            // A session whose write failed can never produce a valid moov, and
            // leaving it registered keeps the target path locked.
            let message = error.to_string();
            if let Some(failed) = jobs.remove(id) {
                drop(failed.file);
                let _ = fs::remove_file(&failed.part);
            }
            return Err(message);
        }
        job.samples.push(Sample {
            size,
            is_keyframe: keyframe,
        });
        job.bytes += data.len() as u64;
        Ok(())
    }

    /// 回填 `mdat` 长度、写入音轨（可选）、在尾部写 `moov`、原子改名为最终文件。
    /// `avcc` 在最后一帧编码完才拿得到，所以留到收尾才提供。
    /// @returns 项目相对路径。
    pub fn finish(
        &self,
        id: &str,
        avcc: Vec<u8>,
        audio: Option<AudioTrackInput>,
    ) -> Result<String, String> {
        let mut jobs = self.jobs.lock().map_err(|_| "导出状态已损坏".to_string())?;
        let mut job = jobs
            .remove(id)
            .ok_or_else(|| "导出任务不存在或已结束".to_string())?;

        let result = (|| -> Result<String, String> {
            // Windows 上文件句柄未关闭时 rename 会失败，先取出来显式 drop。
            let mut file = job
                .file
                .take()
                .ok_or_else(|| "导出文件句柄已关闭".to_string())?;
            if job.samples.is_empty() {
                return Err("没有写入任何视频帧".to_string());
            }
            let ftyp_len = mp4::ftyp().len();
            // 头是 `size = 1` + 64 位 largesize：真实长度写在 box 起点之后
            // 8 字节处，覆盖整个 box（含头）。
            let largesize = mp4::MDAT_HEADER_LEN as u64 + job.bytes;
            file.seek(SeekFrom::Start(job.mdat_size_at + 8))
                .map_err(|e| e.to_string())?;
            file.write_all(&largesize.to_be_bytes())
                .map_err(|e| e.to_string())?;

            let offset = mp4::streaming_mdat_offset(ftyp_len);
            job.config.avcc = avcc;

            // 音频整段写进自己的 mdat：偏移此刻才算得出来（视频字节数已知），
            // 长度也已知，所以它的 `largesize` 不用回填。
            let mut track: Option<AudioAac> = None;
            if let Some(input) = audio {
                if !input.data.is_empty() {
                    if input.samples.is_empty() {
                        return Err("音轨缺少 AAC 帧长度表".to_string());
                    }
                    let audio_offset = mp4::audio_mdat_offset(ftyp_len, job.bytes)?;
                    file.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
                    file.write_all(&mp4::mdat_header(input.data.len() as u64))
                        .and_then(|()| file.write_all(&input.data))
                        .map_err(|e| e.to_string())?;
                    track = Some(AudioAac {
                        samples: input.samples,
                        sample_rate: input.sample_rate,
                        channels: input.channels,
                        bitrate: input.bitrate,
                        asc: input.asc,
                    });
                    job.audio_offset = Some(audio_offset);
                }
            }

            let moov = mp4::moov_with_audio(
                &job.config,
                &job.samples,
                offset,
                track.as_ref().zip(job.audio_offset),
            )?;
            file.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
            file.write_all(&moov).map_err(|e| e.to_string())?;
            file.flush().map_err(|e| e.to_string())?;
            drop(file);

            // 收尾分三步：新成片先改名到同目录的 .staged，旧成片再退到 .bak，
            // 最后才让新成片就位。任何一步失败都能把旧成片放回去。
            let name = job
                .final_path
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_else(|| "export.mp4".to_string());
            let staged = job.final_path.with_file_name(format!("{name}.staged"));
            let backup = job.final_path.with_file_name(format!("{name}.bak"));
            let _ = fs::remove_file(&staged);
            fs::rename(&job.part, &staged).map_err(|e| e.to_string())?;

            let had_old = job.final_path.exists();
            if had_old {
                let _ = fs::remove_file(&backup);
                if let Err(error) = fs::rename(&job.final_path, &backup) {
                    let _ = fs::remove_file(&staged);
                    return Err(error.to_string());
                }
            }
            match fs::rename(&staged, &job.final_path) {
                Ok(()) => {
                    if had_old {
                        let _ = fs::remove_file(&backup);
                    }
                    Ok(job.relative.clone())
                }
                Err(error) => {
                    if had_old {
                        let _ = fs::rename(&backup, &job.final_path);
                    }
                    let _ = fs::remove_file(&staged);
                    Err(error.to_string())
                }
            }
        })();

        if result.is_err() {
            drop(job.file.take());
            let _ = fs::remove_file(&job.part);
        }
        result
    }

    /// 取消导出并删除临时文件。
    pub fn abort(&self, id: &str) -> Result<(), String> {
        let mut jobs = self.jobs.lock().map_err(|_| "导出状态已损坏".to_string())?;
        let job = jobs.remove(id);
        if let Some(job) = job {
            drop(job.file);
            let _ = fs::remove_file(&job.part);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files;

    static TEST_ID: AtomicU64 = AtomicU64::new(0);

    fn temp_root() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "pamela-export-test-{}-{}",
            std::process::id(),
            TEST_ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn config() -> Mp4Config {
        Mp4Config {
            width: 1920,
            height: 1080,
            timescale: 30000,
            sample_delta: 1000,
            avcc: vec![1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 3, 0x67, 0x64, 0x00],
        }
    }

    #[test]
    fn validate_relative_only_allows_exports_mp4() {
        assert_eq!(
            validate_relative("exports\\demo.mp4").unwrap(),
            "exports/demo.mp4"
        );
        for bad in [
            "demo.mp4",
            "assets/demo.mp4",
            "exports/demo.webm",
            "exports/.mp4",
            "exports/../demo.mp4",
        ] {
            assert!(validate_relative(bad).is_err(), "{bad} 应该被拒绝");
        }
    }

    #[test]
    fn begin_refuses_a_second_session_for_the_same_file() {
        let root = temp_root();
        let state = ExportState::default();

        let first = state
            .begin(root.to_str().unwrap(), "exports/same.mp4", config())
            .unwrap();
        let second = state.begin(root.to_str().unwrap(), "exports/same.mp4", config());
        assert!(second.is_err(), "同一目标文件不能同时开两个会话");

        state.abort(&first).unwrap();
        fs::remove_dir_all(&root).unwrap();
    }

    /// `.part` 文件的当前数量；会话 id 现在带进程前缀，不能按固定名断言。
    fn part_files(root: &std::path::Path) -> Vec<PathBuf> {
        fs::read_dir(root.join("exports"))
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.to_string_lossy().ends_with(".part"))
            .collect()
    }

    #[test]
    fn begin_sweeps_stale_parts_but_keeps_the_live_session() {
        let root = temp_root();
        let state = ExportState::default();
        let exports = root.join("exports");
        fs::create_dir_all(&exports).unwrap();
        // 上次异常退出留下的半成品（本进程会话前缀），以及一个正常文件。
        let stale = format!("crashed.mp4.export-{}-1.part", std::process::id());
        fs::write(exports.join(&stale), b"junk").unwrap();
        fs::write(exports.join("kept.mp4"), b"old").unwrap();

        let first = state
            .begin(root.to_str().unwrap(), "exports/a.mp4", config())
            .unwrap();
        assert!(!exports.join(&stale).exists(), "残留被清掉");
        assert!(exports.join("kept.mp4").exists(), "非 .part 文件不动");
        assert_eq!(part_files(&root).len(), 1, "当前会话的临时文件保留");

        // 第二次导出不能把第一次正在写的临时文件当成残留。
        let second = state
            .begin(root.to_str().unwrap(), "exports/b.mp4", config())
            .unwrap();
        assert_eq!(part_files(&root).len(), 2, "在写的会话保留");

        state.abort(&first).unwrap();
        state.abort(&second).unwrap();
        assert_eq!(part_files(&root).len(), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_streaming_session_writes_the_same_bytes_as_mux_streaming() {
        let root = temp_root();
        let state = ExportState::default();
        let frames: [&[u8]; 3] = [&[1, 2, 3, 4], &[5, 6, 7], &[8, 9, 10, 11, 12]];
        let encoded: Vec<u8> = frames.iter().flat_map(|f| f.iter().copied()).collect();
        let samples = vec![
            Sample {
                size: 4,
                is_keyframe: true,
            },
            Sample {
                size: 3,
                is_keyframe: false,
            },
            Sample {
                size: 5,
                is_keyframe: true,
            },
        ];

        let id = state
            .begin(root.to_str().unwrap(), "exports/demo.mp4", config())
            .unwrap();
        for (index, frame) in frames.iter().enumerate() {
            state
                .append(&id, frame, samples[index].is_keyframe)
                .unwrap();
        }
        let relative = state.finish(&id, config().avcc, None).unwrap();
        assert_eq!(relative, "exports/demo.mp4");

        let written = fs::read(root.join("exports/demo.mp4")).unwrap();
        assert_eq!(
            written,
            mp4::mux_streaming(&config(), &samples, &encoded).unwrap()
        );
        assert!(!root.join("exports/demo.mp4.part").exists());
        fs::remove_dir_all(root).unwrap();
    }

    /// 把 `smoke-export` 录下来的真编码字节拼成 MP4，供 `ffprobe` 验解码。
    ///
    /// ```text
    /// set PAMELA_SMOKE_EXPORT_DUMP=target\export-dump.json
    /// node tools\smoke-export.mjs
    /// set PAMELA_EXPORT_DUMP=target\export-dump.json
    /// cargo test --lib mux_a_dumped_export_for_ffprobe -- --ignored --nocapture
    /// ffprobe -v error -show_frames target\mp4-e2e.mp4
    /// ```
    #[test]
    #[ignore]
    fn mux_a_dumped_export_for_ffprobe() {
        #[derive(serde::Deserialize)]
        struct DumpChunk {
            data: String,
            keyframe: bool,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct DumpAudio {
            data: String,
            samples: Vec<u32>,
            sample_rate: u32,
            channels: u16,
            bitrate: u32,
            asc: String,
        }
        #[derive(serde::Deserialize)]
        struct Dump {
            avcc: String,
            chunks: Vec<DumpChunk>,
            audio: Option<DumpAudio>,
        }

        let Ok(path) = std::env::var("PAMELA_EXPORT_DUMP") else {
            println!("跳过：没有设置 PAMELA_EXPORT_DUMP");
            return;
        };
        let dump: Dump = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let frames: Vec<Vec<u8>> = dump
            .chunks
            .iter()
            .map(|chunk| files::base64_decode(&chunk.data).unwrap())
            .collect();
        let samples: Vec<Sample> = dump
            .chunks
            .iter()
            .zip(frames.iter())
            .map(|(chunk, bytes)| Sample {
                size: bytes.len() as u32,
                is_keyframe: chunk.keyframe,
            })
            .collect();
        let encoded: Vec<u8> = frames
            .iter()
            .flat_map(|frame| frame.iter().copied())
            .collect();
        let config = Mp4Config {
            avcc: files::base64_decode(&dump.avcc).unwrap(),
            ..config()
        };

        let (bytes, audio_bytes) = match dump.audio {
            Some(audio) => {
                let track = AudioAac {
                    samples: audio.samples,
                    sample_rate: audio.sample_rate,
                    channels: audio.channels,
                    bitrate: audio.bitrate,
                    asc: files::base64_decode(&audio.asc).unwrap(),
                };
                let bytes = files::base64_decode(&audio.data).unwrap();
                let muxed =
                    mp4::mux_streaming_audio(&config, &samples, &encoded, Some((&track, &bytes)))
                        .unwrap();
                (muxed, bytes.len())
            }
            None => (
                mp4::mux_streaming_audio(&config, &samples, &encoded, None).unwrap(),
                0,
            ),
        };

        let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/mp4-e2e.mp4");
        fs::write(&out, &bytes).unwrap();
        println!(
            "{} 帧视频 + {} 字节音频 → {}（{} 字节）",
            samples.len(),
            audio_bytes,
            out.display(),
            bytes.len()
        );
    }

    #[test]
    fn a_session_with_audio_writes_the_same_bytes_as_mux_streaming_audio() {
        let root = temp_root();
        let state = ExportState::default();
        let frames: [&[u8]; 2] = [&[1, 2, 3, 4], &[5, 6, 7]];
        let track = AudioTrackInput {
            data: vec![9; 20],
            samples: vec![5, 5, 5, 5],
            sample_rate: 48_000,
            channels: 2,
            bitrate: 128_000,
            asc: vec![0x11, 0x90],
        };
        let id = state
            .begin(root.to_str().unwrap(), "exports/a.mp4", config())
            .unwrap();
        for frame in frames {
            state.append(&id, frame, true).unwrap();
        }
        let relative = state
            .finish(&id, config().avcc, Some(track.clone()))
            .unwrap();
        assert_eq!(relative, "exports/a.mp4");

        let written = fs::read(root.join("exports/a.mp4")).unwrap();
        let samples: Vec<Sample> = frames
            .iter()
            .map(|frame| Sample {
                size: frame.len() as u32,
                is_keyframe: true,
            })
            .collect();
        let encoded: Vec<u8> = frames
            .iter()
            .flat_map(|frame| frame.iter().copied())
            .collect();
        let audio = AudioAac {
            samples: track.samples.clone(),
            sample_rate: track.sample_rate,
            channels: track.channels,
            bitrate: track.bitrate,
            asc: track.asc.clone(),
        };
        let expected =
            mp4::mux_streaming_audio(&config(), &samples, &encoded, Some((&audio, &track.data)))
                .unwrap();
        assert_eq!(written, expected, "流式写盘与纯函数必须逐字节一致");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn abort_removes_the_part_file_and_finish_rejects_empty_sessions() {
        let root = temp_root();
        let state = ExportState::default();
        let id = state
            .begin(root.to_str().unwrap(), "exports/a.mp4", config())
            .unwrap();
        assert_eq!(part_files(&root).len(), 1);
        state.abort(&id).unwrap();
        assert_eq!(part_files(&root).len(), 0, "取消后临时文件被删除");

        let id = state
            .begin(root.to_str().unwrap(), "exports/b.mp4", config())
            .unwrap();
        assert!(state.finish(&id, config().avcc, None).is_err());
        assert_eq!(part_files(&root).len(), 0, "空会话失败后不留临时文件");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn begin_refuses_paths_outside_the_project() {
        let root = temp_root();
        let state = ExportState::default();
        assert!(state
            .begin(root.to_str().unwrap(), "exports/../../evil.mp4", config())
            .is_err());
        assert!(state
            .begin(root.to_str().unwrap(), "C:/evil.mp4", config())
            .is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
