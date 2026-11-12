//! 手写 ISO BMFF（MP4）封装：把 WebCodecs 产出的 H.264 帧装进 MP4。
//! A dependency-free MP4 muxer for H.264 chunks produced by WebCodecs.
//!
//! 只做一条视频轨（每帧一个 sample）与可选的**一条 AAC 音轨**（每帧一个
//! sample，AAC 一帧 1024 个采样点）。两条轨各自的所有 sample 连续放在自己的
//! `mdat` chunk 里，于是两条轨的 `stsc` / `stco` 都只需一条记录；流式写盘时
//! 前端每 append 一帧视频，后端只累积 size 与关键帧标记，音频在收尾时整段写入，
//! 最后生成 `moov`。
//!
//! `mdat` 一律用 64 位 box 头（`size = 1` + `largesize`），因此成片不再受
//! 4 GiB 的 32 位 box 长度限制。不需要 `co64`：`stco` 记的是 chunk 的**文件
//! 偏移**，而唯一的 chunk 就在 `ftyp` 之后，永远是个很小的数——超长的是
//! `mdat` 的**长度**，不是它的位置。
//!
//! 不引入 crate：box 拼装是纯函数，可以逐字节断言（与 `files.rs` 手写
//! base64、`audio-editor.js` 手写 WAV 是同一套做法）。

/// 单位变换矩阵，供 `mvhd` / `tkhd` 使用。
const IDENTITY_MATRIX: [u32; 9] = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000];

/// `mdat` 头固定 16 字节：`size = 1`、类型、64 位 `largesize`。
pub const MDAT_HEADER_LEN: usize = 16;

/// 一个样本（一帧编码数据）的索引信息。
#[derive(Clone, Debug)]
pub struct Sample {
    /// 编码后字节数。
    pub size: u32,
    /// 是否关键帧，决定 `stss` 是否收录。
    pub is_keyframe: bool,
}

/// 一条 AAC 音轨：样本表、采样格式与 AudioSpecificConfig。
#[derive(Clone, Debug)]
pub struct AudioAac {
    /// 每个 AAC 帧的字节数，按编码顺序。
    pub samples: Vec<u32>,
    pub sample_rate: u32,
    pub channels: u16,
    /// 编码码率，写进 `esds` 的 maxBitrate / avgBitrate。
    pub bitrate: u32,
    /// WebCodecs `decoderConfig.description`（AudioSpecificConfig）的原样字节。
    pub asc: Vec<u8>,
}

/// 轨道参数。`avcc` 是 WebCodecs `decoderConfig.description` 的原样字节。
#[derive(Clone, Debug)]
pub struct Mp4Config {
    pub width: u16,
    pub height: u16,
    /// 每秒 ticks；导出约定 30000。
    pub timescale: u32,
    /// 每帧 ticks；30fps 时为 1000。
    pub sample_delta: u32,
    /// AVCDecoderConfigurationRecord。
    pub avcc: Vec<u8>,
}

fn push_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_be_bytes());
}

fn push_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_be_bytes());
}

fn push_zeros(out: &mut Vec<u8>, count: usize) {
    out.resize(out.len() + count, 0);
}

/// 一个 box：4 字节大端长度（含头部）+ 4 字节类型 + payload。
pub fn box_bytes(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + payload.len());
    push_u32(&mut out, (8 + payload.len()) as u32);
    out.extend_from_slice(kind);
    out.extend_from_slice(payload);
    out
}

/// `ftyp`：isom 主品牌，兼容 iso2 / avc1 / mp41。
pub fn ftyp() -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(b"isom");
    push_u32(&mut payload, 0);
    for brand in [b"isom", b"iso2", b"avc1", b"mp41"] {
        payload.extend_from_slice(&brand[..]);
    }
    box_bytes(b"ftyp", &payload)
}

/// `mvhd`（version 0），payload 固定 100 字节。`next_track_id` 至少要比已用
/// 的 `track_ID` 大 1。
pub fn mvhd(timescale: u32, duration: u32) -> Vec<u8> {
    mvhd_tracks(timescale, duration, 2)
}

/// 同上，但显式给出下一个可用的 `track_ID`（有音轨时为 3）。
fn mvhd_tracks(timescale: u32, duration: u32, next_track_id: u32) -> Vec<u8> {
    let mut payload = Vec::with_capacity(100);
    push_u32(&mut payload, 0); // version + flags
    push_u32(&mut payload, 0); // creation_time
    push_u32(&mut payload, 0); // modification_time
    push_u32(&mut payload, timescale);
    push_u32(&mut payload, duration);
    push_u32(&mut payload, 0x0001_0000); // rate = 1.0
    push_u16(&mut payload, 0x0100); // volume = 1.0
    push_zeros(&mut payload, 10); // reserved
    for value in IDENTITY_MATRIX {
        push_u32(&mut payload, value);
    }
    push_zeros(&mut payload, 24); // pre_defined
    push_u32(&mut payload, next_track_id);
    box_bytes(b"mvhd", &payload)
}

/// `tkhd`（version 0，flags = enabled | inMovie），宽高为 16.16 定点。
pub fn tkhd(width: u16, height: u16, duration: u32) -> Vec<u8> {
    tkhd_track(1, width, height, duration, 0)
}

fn tkhd_track(track_id: u32, width: u16, height: u16, duration: u32, volume: u16) -> Vec<u8> {
    let mut payload = Vec::with_capacity(84);
    push_u32(&mut payload, 0x0000_0003);
    push_u32(&mut payload, 0); // creation_time
    push_u32(&mut payload, 0); // modification_time
    push_u32(&mut payload, track_id);
    push_u32(&mut payload, 0); // reserved
    push_u32(&mut payload, duration);
    push_zeros(&mut payload, 8); // reserved
    push_u16(&mut payload, 0); // layer
    push_u16(&mut payload, 0); // alternate_group
    push_u16(&mut payload, volume); // 视频轨为 0，音轨为 0x0100
    push_u16(&mut payload, 0); // reserved
    for value in IDENTITY_MATRIX {
        push_u32(&mut payload, value);
    }
    push_u32(&mut payload, u32::from(width) << 16);
    push_u32(&mut payload, u32::from(height) << 16);
    box_bytes(b"tkhd", &payload)
}

/// `mdhd`（version 0），语言为 `und`。
pub fn mdhd(timescale: u32, duration: u32) -> Vec<u8> {
    let mut payload = Vec::with_capacity(24);
    push_u32(&mut payload, 0);
    push_u32(&mut payload, 0);
    push_u32(&mut payload, 0);
    push_u32(&mut payload, timescale);
    push_u32(&mut payload, duration);
    push_u16(&mut payload, 0x55c4); // 'und'
    push_u16(&mut payload, 0);
    box_bytes(b"mdhd", &payload)
}

/// `hdlr`：视频轨。
pub fn hdlr() -> Vec<u8> {
    hdlr_kind(b"vide", b"VideoHandler\0")
}

fn hdlr_kind(handler: &[u8; 4], name: &[u8]) -> Vec<u8> {
    let mut payload = Vec::new();
    push_u32(&mut payload, 0);
    push_u32(&mut payload, 0); // pre_defined
    payload.extend_from_slice(handler);
    push_zeros(&mut payload, 12); // reserved
    payload.extend_from_slice(name);
    box_bytes(b"hdlr", &payload)
}

fn vmhd() -> Vec<u8> {
    let mut payload = Vec::new();
    push_u32(&mut payload, 0x0000_0001); // flags = 1
    push_u16(&mut payload, 0); // graphicsmode
    push_zeros(&mut payload, 6); // opcolor
    box_bytes(b"vmhd", &payload)
}

/// `smhd`：音轨的媒体信息头。
fn smhd() -> Vec<u8> {
    let mut payload = Vec::new();
    push_u32(&mut payload, 0); // version + flags
    push_u16(&mut payload, 0); // balance
    push_u16(&mut payload, 0); // reserved
    box_bytes(b"smhd", &payload)
}

fn dinf() -> Vec<u8> {
    // self-contained 的 `url ` box，媒体数据就在本文件里。
    let url = box_bytes(b"url ", &[0, 0, 0, 1]);
    let mut dref_payload = Vec::new();
    push_u32(&mut dref_payload, 0);
    push_u32(&mut dref_payload, 1); // entry_count
    dref_payload.extend_from_slice(&url);
    box_bytes(b"dinf", &box_bytes(b"dref", &dref_payload))
}

/// `avc1` 视觉样本描述，78 字节固定字段 + 一个 `avcC` 子 box。
pub fn avc1(width: u16, height: u16, avcc: &[u8]) -> Vec<u8> {
    let mut payload = Vec::with_capacity(78 + 8 + avcc.len());
    push_zeros(&mut payload, 6); // reserved
    push_u16(&mut payload, 1); // data_reference_index
    push_u16(&mut payload, 0); // pre_defined
    push_u16(&mut payload, 0); // reserved
    push_zeros(&mut payload, 12); // pre_defined[3]
    push_u16(&mut payload, width);
    push_u16(&mut payload, height);
    push_u32(&mut payload, 0x0048_0000); // horizresolution 72 dpi
    push_u32(&mut payload, 0x0048_0000); // vertresolution 72 dpi
    push_u32(&mut payload, 0); // reserved
    push_u16(&mut payload, 1); // frame_count
    push_zeros(&mut payload, 32); // compressorname
    push_u16(&mut payload, 0x0018); // depth
    push_u16(&mut payload, 0xffff); // pre_defined = -1
    payload.extend_from_slice(&box_bytes(b"avcC", avcc));
    box_bytes(b"avc1", &payload)
}

fn stsd(config: &Mp4Config) -> Vec<u8> {
    let entry = avc1(config.width, config.height, &config.avcc);
    let mut payload = Vec::new();
    push_u32(&mut payload, 0);
    push_u32(&mut payload, 1); // entry_count
    payload.extend_from_slice(&entry);
    box_bytes(b"stsd", &payload)
}

fn stts(sample_count: u32, delta: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    push_u32(&mut payload, 0);
    push_u32(&mut payload, 1); // entry_count：所有帧等长
    push_u32(&mut payload, sample_count);
    push_u32(&mut payload, delta);
    box_bytes(b"stts", &payload)
}

fn stss(keyframes: &[u32]) -> Vec<u8> {
    let mut payload = Vec::new();
    push_u32(&mut payload, 0);
    push_u32(&mut payload, keyframes.len() as u32);
    for number in keyframes {
        push_u32(&mut payload, *number);
    }
    box_bytes(b"stss", &payload)
}

fn stsc(sample_count: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    push_u32(&mut payload, 0);
    push_u32(&mut payload, 1); // entry_count：所有 sample 在一个 chunk
    push_u32(&mut payload, 1); // first_chunk
    push_u32(&mut payload, sample_count); // samples_per_chunk
    push_u32(&mut payload, 1); // sample_description_index
    box_bytes(b"stsc", &payload)
}

fn stsz(sizes: &[u32]) -> Vec<u8> {
    let mut payload = Vec::new();
    push_u32(&mut payload, 0);
    push_u32(&mut payload, 0); // sample_size = 0 表示逐项给出
    push_u32(&mut payload, sizes.len() as u32);
    for size in sizes {
        push_u32(&mut payload, *size);
    }
    box_bytes(b"stsz", &payload)
}

fn stco(offset: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    push_u32(&mut payload, 0);
    push_u32(&mut payload, 1); // entry_count
    push_u32(&mut payload, offset);
    box_bytes(b"stco", &payload)
}

/// MPEG-4 描述符的长度字段：每字节 7 位，最高位表示「后面还有」。
fn push_descriptor_len(out: &mut Vec<u8>, len: usize) {
    if len < 0x80 {
        out.push(len as u8);
        return;
    }
    let mut chunks = Vec::new();
    let mut value = len;
    while value > 0 {
        chunks.insert(0, (value & 0x7f) as u8);
        value >>= 7;
    }
    let last = chunks.len().saturating_sub(1);
    for (index, byte) in chunks.iter().enumerate() {
        out.push(if index == last { *byte } else { *byte | 0x80 });
    }
}

/// `esds`：AAC 的 DecoderConfigDescriptor + AudioSpecificConfig。
///
/// `objectTypeIndication = 0x40`（MPEG-4 Audio）、`streamType = 5`（音频）。
/// `asc` 是 WebCodecs 给出的 AudioSpecificConfig，播放器靠它识别 AAC 参数。
fn esds(track: &AudioAac) -> Vec<u8> {
    // DecoderSpecificInfo（tag 0x05）
    let mut dsi = Vec::new();
    dsi.push(0x05);
    push_descriptor_len(&mut dsi, track.asc.len());
    dsi.extend_from_slice(&track.asc);

    // DecoderConfigDescriptor（tag 0x04）
    let mut dcd = Vec::new();
    dcd.push(0x40); // objectTypeIndication: AAC
    dcd.push(0x15); // streamType = 5 << 2 | upstream(0) << 1 | reserved(1)
    dcd.extend_from_slice(&[0, 0, 0]); // bufferSizeDB
    push_u32(&mut dcd, track.bitrate); // maxBitrate
    push_u32(&mut dcd, track.bitrate); // avgBitrate
    dcd.extend_from_slice(&dsi);

    // SLConfigDescriptor（tag 0x06）：预定义 = 2（MP4 文件里的默认值）
    let sl = [0x06u8, 0x01, 0x02];

    let mut es = Vec::new();
    push_u16(&mut es, 0); // ES_ID
    es.push(0); // flags
    es.push(0x04);
    push_descriptor_len(&mut es, dcd.len());
    es.extend_from_slice(&dcd);
    es.extend_from_slice(&sl);

    let mut payload = Vec::new();
    push_u32(&mut payload, 0); // version + flags
    payload.push(0x03); // ES_Descriptor
    push_descriptor_len(&mut payload, es.len());
    payload.extend_from_slice(&es);
    box_bytes(b"esds", &payload)
}

/// `mp4a` 音频样本描述：28 字节固定字段 + `esds`。
pub fn mp4a(track: &AudioAac) -> Vec<u8> {
    let mut payload = Vec::with_capacity(36 + 40 + track.asc.len());
    push_zeros(&mut payload, 6); // reserved
    push_u16(&mut payload, 1); // data_reference_index
    push_zeros(&mut payload, 8); // version / revision / vendor
    push_u16(&mut payload, track.channels);
    push_u16(&mut payload, 16); // samplesize
    push_u16(&mut payload, 0); // pre_defined
    push_u16(&mut payload, 0); // reserved
    push_u32(&mut payload, track.sample_rate << 16); // 16.16 定点
    payload.extend_from_slice(&esds(track));
    box_bytes(b"mp4a", &payload)
}

fn audio_stsd(track: &AudioAac) -> Vec<u8> {
    let mut payload = Vec::new();
    push_u32(&mut payload, 0);
    push_u32(&mut payload, 1); // entry_count
    payload.extend_from_slice(&mp4a(track));
    box_bytes(b"stsd", &payload)
}

/// 音轨的 `trak`。`media_duration` 用采样数（音轨自己的 timescale），
/// `movie_duration` 用影片 timescale（给 `tkhd`）。
fn audio_trak(track: &AudioAac, offset: u32, media_duration: u32, movie_duration: u32) -> Vec<u8> {
    let count = track.samples.len() as u32;
    let mut stbl = Vec::new();
    stbl.extend_from_slice(&audio_stsd(track));
    // AAC 每一帧固定 1024 个采样点，所以 stts 只需一条记录。
    stbl.extend_from_slice(&stts(count, 1024));
    stbl.extend_from_slice(&stsc(count));
    stbl.extend_from_slice(&stsz(&track.samples));
    stbl.extend_from_slice(&stco(offset));

    let mut minf = Vec::new();
    minf.extend_from_slice(&smhd());
    minf.extend_from_slice(&dinf());
    minf.extend_from_slice(&box_bytes(b"stbl", &stbl));

    let mut mdia = Vec::new();
    mdia.extend_from_slice(&mdhd(track.sample_rate, media_duration));
    mdia.extend_from_slice(&hdlr_kind(b"soun", b"SoundHandler\0"));
    mdia.extend_from_slice(&box_bytes(b"minf", &minf));

    // 音量 1.0，宽高为 0：播放器据此知道这条轨没有画面。
    let mut trak = Vec::new();
    trak.extend_from_slice(&tkhd_track(2, 0, 0, movie_duration, 0x0100));
    trak.extend_from_slice(&box_bytes(b"mdia", &mdia));
    box_bytes(b"trak", &trak)
}

/// 音轨在影片 timescale 下的时长；同时校验样本表与配置。
fn audio_movie_duration(config: &Mp4Config, track: &AudioAac) -> Result<u64, String> {
    if track.samples.is_empty() {
        return Err("音轨没有样本".to_string());
    }
    if track.sample_rate == 0 || track.channels == 0 {
        return Err("音轨的采样率或声道数无效".to_string());
    }
    if track.asc.is_empty() {
        return Err("缺少 AudioSpecificConfig（decoderConfig.description）".to_string());
    }
    let samples = track.samples.len() as u64 * 1024;
    Ok(samples * u64::from(config.timescale) / u64::from(track.sample_rate))
}

/// `mdat` payload 的绝对文件偏移；单 chunk 时它同时也是 `stco` 的唯一条目。
///
/// 流式写盘时先写占位 `ftyp` + `moov`，append 完所有帧后调用 `moov()` 回填：
/// `moov` 的长度与 offset 的数值无关（条目数固定），所以两遍计算是稳定的。
pub fn mdat_offset(ftyp_len: usize, moov_len: usize) -> u32 {
    mdat_offset_checked(ftyp_len, moov_len).unwrap_or(u32::MAX)
}

/// 同 [`mdat_offset`]，但拒绝超过 32 位 `stco` 上限的偏移。
pub fn mdat_offset_checked(ftyp_len: usize, moov_len: usize) -> Result<u32, String> {
    u32::try_from(ftyp_len + moov_len + MDAT_HEADER_LEN)
        .map_err(|_| "moov 过大，文件偏移超过 32 位 stco 上限".to_string())
}

/// 生成完整 `moov`（只有视频轨）。`mdat_offset` 是视频 `mdat` payload 的绝对偏移。
pub fn moov(config: &Mp4Config, samples: &[Sample], mdat_offset: u32) -> Result<Vec<u8>, String> {
    moov_with_audio(config, samples, mdat_offset, None)
}

/// 生成 `moov`：一条视频轨，外加可选的音轨（`(音轨, 音频 mdat 的 payload 偏移)`）。
///
/// 影片时长取两者较长的一个：音频比画面长时，播放器不会提前掐掉尾巴；画面更长
/// 时，音轨 `tkhd` 里仍写影片时长，只是它自己的样本早早结束（合法）。
pub fn moov_with_audio(
    config: &Mp4Config,
    samples: &[Sample],
    video_offset: u32,
    audio: Option<(&AudioAac, u32)>,
) -> Result<Vec<u8>, String> {
    if samples.is_empty() {
        return Err("没有可写入的视频帧".to_string());
    }
    if config.sample_delta == 0 {
        return Err("帧时长不能为零".to_string());
    }
    if config.avcc.is_empty() {
        return Err("缺少 avcC（decoderConfig.description）".to_string());
    }
    let count = u32::try_from(samples.len())
        .map_err(|_| "视频帧数超过 32 位样本表上限".to_string())?;
    let video_duration = u64::from(count) * u64::from(config.sample_delta);
    let audio_duration = match audio {
        Some((track, _)) => audio_movie_duration(config, track)?,
        None => 0,
    };
    let duration = video_duration.max(audio_duration);
    if duration > u64::from(u32::MAX) {
        return Err("影片时长超出 32 位 duration 上限".to_string());
    }
    let duration = duration as u32;

    let keyframes: Vec<u32> = samples
        .iter()
        .enumerate()
        .filter(|(_, sample)| sample.is_keyframe)
        .map(|(index, _)| index as u32 + 1)
        .collect();
    let sizes: Vec<u32> = samples.iter().map(|sample| sample.size).collect();

    let mut stbl = Vec::new();
    stbl.extend_from_slice(&stsd(config));
    stbl.extend_from_slice(&stts(count, config.sample_delta));
    stbl.extend_from_slice(&stss(&keyframes));
    stbl.extend_from_slice(&stsc(count));
    stbl.extend_from_slice(&stsz(&sizes));
    stbl.extend_from_slice(&stco(video_offset));
    let stbl = box_bytes(b"stbl", &stbl);

    let mut minf = Vec::new();
    minf.extend_from_slice(&vmhd());
    minf.extend_from_slice(&dinf());
    minf.extend_from_slice(&stbl);
    let minf = box_bytes(b"minf", &minf);

    let mut mdia = Vec::new();
    mdia.extend_from_slice(&mdhd(config.timescale, video_duration as u32));
    mdia.extend_from_slice(&hdlr());
    mdia.extend_from_slice(&minf);
    let mdia = box_bytes(b"mdia", &mdia);

    let mut trak = Vec::new();
    trak.extend_from_slice(&tkhd(config.width, config.height, duration));
    trak.extend_from_slice(&mdia);
    let trak = box_bytes(b"trak", &trak);

    let next_track_id = if audio.is_some() { 3 } else { 2 };
    let mut payload = Vec::new();
    payload.extend_from_slice(&mvhd_tracks(config.timescale, duration, next_track_id));
    payload.extend_from_slice(&trak);
    if let Some((track, offset)) = audio {
        // `mp4a` writes the rate as 16.16 fixed point; a larger value would be
        // silently truncated and disagree with the `mdhd` timescale.
        if track.sample_rate > u32::from(u16::MAX) {
            return Err(format!("采样率 {} 超出 16.16 定点上限", track.sample_rate));
        }
        let media_duration = u32::try_from(track.samples.len())
            .ok()
            .and_then(|count| count.checked_mul(1024))
            .ok_or_else(|| "音轨时长超出 32 位上限".to_string())?;
        payload.extend_from_slice(&audio_trak(track, offset, media_duration, duration));
    }
    Ok(box_bytes(b"moov", &payload))
}

/// `mdat` 的 16 字节头（64 位 `largesize`）；流式写盘时先写它，再逐帧 append。
///
/// 长度先写 0 占位，收尾时回填真实值——`largesize` 覆盖整个 box，所以既不
/// 需要预先知道成片多大，也不受 4 GiB 限制。
pub fn mdat_header(payload_len: u64) -> Vec<u8> {
    let total = payload_len.saturating_add(MDAT_HEADER_LEN as u64);
    let mut out = Vec::with_capacity(MDAT_HEADER_LEN);
    push_u32(&mut out, 1);
    out.extend_from_slice(b"mdat");
    out.extend_from_slice(&total.to_be_bytes());
    out
}

/// 内存版封装：把拼接好的编码帧一次性写成完整 MP4（moov 在前，便于起播）。
pub fn mux(config: &Mp4Config, samples: &[Sample], encoded: &[u8]) -> Result<Vec<u8>, String> {
    let expected: u64 = samples.iter().map(|sample| u64::from(sample.size)).sum();
    if expected != encoded.len() as u64 {
        return Err("样本尺寸之和与编码数据长度不一致".to_string());
    }
    let header = mdat_header(encoded.len() as u64);
    let ftyp = ftyp();

    // 先用占位 offset 求 moov 长度，再算真实 offset 重新生成。
    let probe = moov(config, samples, 0)?;
    let offset = mdat_offset_checked(ftyp.len(), probe.len())?;
    let moov = moov(config, samples, offset)?;
    debug_assert_eq!(moov.len(), probe.len());

    let mut out = Vec::with_capacity(ftyp.len() + moov.len() + header.len() + encoded.len());
    out.extend_from_slice(&ftyp);
    out.extend_from_slice(&moov);
    out.extend_from_slice(&header);
    out.extend_from_slice(encoded);
    Ok(out)
}

/// 流式布局（`ftyp + mdat + moov`）中 `mdat` payload 的绝对偏移。
///
/// `moov` 的长度随帧数变化（`stsz` / `stss` 每帧一条），无法在写第一帧前
/// 预留固定空间，所以流式写盘把它放在文件尾；播放器读本地文件不受影响。
pub fn streaming_mdat_offset(ftyp_len: usize) -> u32 {
    (ftyp_len + MDAT_HEADER_LEN) as u32
}

/// 音频 `mdat` payload 的绝对偏移：紧跟视频 `mdat` 之后。
///
/// 音频整段在收尾时写入，此时视频字节数已知，所以偏移可以直接算出来。两个
/// `mdat` 分开写、各自只有一个 chunk，`stco` 因此各自只需一条记录。
pub fn audio_mdat_offset(ftyp_len: usize, video_bytes: u64) -> Result<u32, String> {
    let offset = ftyp_len as u64 + MDAT_HEADER_LEN as u64 + video_bytes + MDAT_HEADER_LEN as u64;
    if offset > u64::from(u32::MAX) {
        return Err("文件偏移超过 32 位 stco 上限".to_string());
    }
    Ok(offset as u32)
}

/// 与流式写盘完全相同的布局，供纯函数测试与导出会话共用同一套字节顺序。
pub fn mux_streaming(
    config: &Mp4Config,
    samples: &[Sample],
    encoded: &[u8],
) -> Result<Vec<u8>, String> {
    mux_streaming_audio(config, samples, encoded, None)
}

/// 流式布局 + 可选音轨：`ftyp + mdat(video) + [mdat(audio)] + moov`。
///
/// `audio` 是 `(音轨, 拼接好的 AAC 帧字节)`。样本尺寸之和必须与字节数一致，
/// 否则 `stsz` 与实际数据错位，播放器会读到别的帧边界上。
pub fn mux_streaming_audio(
    config: &Mp4Config,
    samples: &[Sample],
    encoded: &[u8],
    audio: Option<(&AudioAac, &[u8])>,
) -> Result<Vec<u8>, String> {
    let expected: u64 = samples.iter().map(|sample| u64::from(sample.size)).sum();
    if expected != encoded.len() as u64 {
        return Err("样本尺寸之和与编码数据长度不一致".to_string());
    }
    let audio_offset = match audio {
        Some((track, bytes)) => {
            let expected: u64 = track.samples.iter().map(|size| u64::from(*size)).sum();
            if expected != bytes.len() as u64 {
                return Err("音频样本尺寸之和与编码数据长度不一致".to_string());
            }
            Some(audio_mdat_offset(ftyp().len(), encoded.len() as u64)?)
        }
        None => None,
    };

    let header = mdat_header(encoded.len() as u64);
    let ftyp = ftyp();
    let video_offset = streaming_mdat_offset(ftyp.len());
    let with_offset = match (audio, audio_offset) {
        (Some((track, _)), Some(offset)) => Some((track, offset)),
        _ => None,
    };
    let moov = moov_with_audio(config, samples, video_offset, with_offset)?;

    let audio_bytes = audio.map(|(_, bytes)| bytes);
    let capacity = ftyp.len()
        + header.len()
        + encoded.len()
        + audio_bytes
            .map(|bytes| MDAT_HEADER_LEN + bytes.len())
            .unwrap_or(0)
        + moov.len();
    let mut out = Vec::with_capacity(capacity);
    out.extend_from_slice(&ftyp);
    out.extend_from_slice(&header);
    out.extend_from_slice(encoded);
    if let Some(bytes) = audio_bytes {
        out.extend_from_slice(&mdat_header(bytes.len() as u64));
        out.extend_from_slice(bytes);
    }
    out.extend_from_slice(&moov);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Mp4Config {
        Mp4Config {
            width: 1920,
            height: 1080,
            timescale: 30000,
            sample_delta: 1000,
            avcc: vec![1, 0x42, 0xe0, 0x1e, 0xff, 0xe1, 0, 3, 0x67, 0x42, 0x00],
        }
    }

    fn be32(bytes: &[u8], at: usize) -> u32 {
        u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
    }

    fn be64(bytes: &[u8], at: usize) -> u64 {
        u64::from_be_bytes([
            bytes[at],
            bytes[at + 1],
            bytes[at + 2],
            bytes[at + 3],
            bytes[at + 4],
            bytes[at + 5],
            bytes[at + 6],
            bytes[at + 7],
        ])
    }

    /// 逐字节找 box 类型；测试里也要能找到嵌套在 `moov` 里的 `stco` 等。
    fn find_box(bytes: &[u8], kind: &[u8; 4]) -> usize {
        for at in 0..bytes.len().saturating_sub(7) {
            if &bytes[at + 4..at + 8] == kind {
                return at;
            }
        }
        panic!("找不到 box {kind:?}");
    }

    #[test]
    fn box_bytes_has_a_big_endian_size_and_type() {
        let boxed = box_bytes(b"test", &[1, 2, 3]);
        assert_eq!(boxed.len(), 11);
        assert_eq!(be32(&boxed, 0), 11);
        assert_eq!(&boxed[4..8], b"test");
        assert_eq!(&boxed[8..], &[1, 2, 3]);
    }

    #[test]
    fn ftyp_declares_isom_and_compatible_brands() {
        let bytes = ftyp();
        assert_eq!(&bytes[4..8], b"ftyp");
        assert_eq!(&bytes[8..12], b"isom");
        assert_eq!(be32(&bytes, 0), bytes.len() as u32);
    }

    #[test]
    fn fixed_size_boxes_match_the_spec() {
        assert_eq!(be32(&mvhd(30000, 1000), 0), 108); // 100 + 8 头
        assert_eq!(be32(&tkhd(1920, 1080, 1000), 0), 92); // 84 + 8
        assert_eq!(be32(&mdhd(30000, 1000), 0), 32); // 24 + 8
        assert_eq!(be32(&avc1(1920, 1080, &[1, 2, 3]), 0), 8 + 78 + 8 + 3);
    }

    #[test]
    fn mux_writes_a_playable_box_order_and_correct_sample_tables() {
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
        let encoded = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
        let bytes = mux(&config(), &samples, &encoded).unwrap();

        assert_eq!(&bytes[4..8], b"ftyp");
        assert_eq!(find_box(&bytes, b"moov"), ftyp().len());
        let moov_at = find_box(&bytes, b"moov");
        let mdat_at = moov_at + be32(&bytes, moov_at) as usize;
        assert_eq!(&bytes[mdat_at + 4..mdat_at + 8], b"mdat");
        assert_eq!(&bytes[mdat_at + MDAT_HEADER_LEN..], &encoded);
        // 64 位 box：size 字段是 1，真实长度在 largesize 里。
        assert_eq!(be32(&bytes, mdat_at), 1);
        assert_eq!(
            be64(&bytes, mdat_at + 8),
            MDAT_HEADER_LEN as u64 + encoded.len() as u64
        );

        // stco 指向 mdat 的 payload 起点。
        let stco_at = find_box(&bytes[moov_at..mdat_at], b"stco") + moov_at;
        assert_eq!(
            be32(&bytes, stco_at + 16),
            (mdat_at + MDAT_HEADER_LEN) as u32
        );

        // stsz 逐帧尺寸、stss 关键帧编号（1-based）、stts 等长帧。
        let stsz_at = find_box(&bytes[moov_at..mdat_at], b"stsz") + moov_at;
        assert_eq!(be32(&bytes, stsz_at + 12), 0); // sample_size = 0
        assert_eq!(be32(&bytes, stsz_at + 16), 3); // sample_count
        assert_eq!(be32(&bytes, stsz_at + 20), 4);
        assert_eq!(be32(&bytes, stsz_at + 24), 3);
        assert_eq!(be32(&bytes, stsz_at + 28), 5);

        let stss_at = find_box(&bytes[moov_at..mdat_at], b"stss") + moov_at;
        assert_eq!(be32(&bytes, stss_at + 12), 2);
        assert_eq!(be32(&bytes, stss_at + 16), 1);
        assert_eq!(be32(&bytes, stss_at + 20), 3);

        let stts_at = find_box(&bytes[moov_at..mdat_at], b"stts") + moov_at;
        assert_eq!(be32(&bytes, stts_at + 16), 3);
        assert_eq!(be32(&bytes, stts_at + 20), 1000);

        // 时长 = 3 帧 * 1000 ticks，timescale = 30000。
        let mvhd_at = find_box(&bytes[moov_at..mdat_at], b"mvhd") + moov_at;
        assert_eq!(be32(&bytes, mvhd_at + 20), 30000);
        assert_eq!(be32(&bytes, mvhd_at + 24), 3000);
    }

    #[test]
    fn mux_streaming_puts_moov_last_with_a_valid_offset() {
        let samples = vec![
            Sample {
                size: 4,
                is_keyframe: true,
            },
            Sample {
                size: 6,
                is_keyframe: false,
            },
        ];
        let encoded = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        let bytes = mux_streaming(&config(), &samples, &encoded).unwrap();
        assert_eq!(&bytes[4..8], b"ftyp");
        let mdat_at = find_box(&bytes, b"mdat");
        assert_eq!(mdat_at, ftyp().len());
        let payload = mdat_at + MDAT_HEADER_LEN;
        assert_eq!(&bytes[payload..payload + encoded.len()], &encoded);
        let moov_at = find_box(&bytes, b"moov");
        assert!(moov_at > mdat_at);
        let stco_at = find_box(&bytes[moov_at..], b"stco") + moov_at;
        assert_eq!(be32(&bytes, stco_at + 16), payload as u32);
        let mvhd_at = find_box(&bytes[moov_at..], b"mvhd") + moov_at;
        assert_eq!(be32(&bytes, mvhd_at + 24), 2000);
    }

    #[test]
    fn mux_rejects_bad_inputs() {
        let sample = Sample {
            size: 4,
            is_keyframe: true,
        };
        assert!(mux(&config(), &[], &[]).is_err());
        assert!(mux(&config(), std::slice::from_ref(&sample), &[1, 2, 3]).is_err());
        let no_avcc = Mp4Config {
            avcc: Vec::new(),
            ..config()
        };
        assert!(moov(&no_avcc, std::slice::from_ref(&sample), 0).is_err());
        let zero_delta = Mp4Config {
            sample_delta: 0,
            ..config()
        };
        assert!(moov(&zero_delta, &[sample], 0).is_err());
    }

    fn find_all_boxes(bytes: &[u8], kind: &[u8; 4]) -> Vec<usize> {
        let mut found = Vec::new();
        for at in 0..bytes.len().saturating_sub(7) {
            if &bytes[at + 4..at + 8] == kind {
                found.push(at);
            }
        }
        found
    }

    fn aac() -> AudioAac {
        AudioAac {
            samples: vec![3, 4, 5],
            sample_rate: 48_000,
            channels: 2,
            bitrate: 128_000,
            asc: vec![0x11, 0x90],
        }
    }

    #[test]
    fn an_audio_track_gets_its_own_trak_and_mdat() {
        let samples = vec![
            Sample {
                size: 4,
                is_keyframe: true,
            },
            Sample {
                size: 4,
                is_keyframe: false,
            },
        ];
        let encoded = [1, 2, 3, 4, 5, 6, 7, 8];
        let track = aac();
        let audio = [9u8; 12];
        let bytes =
            mux_streaming_audio(&config(), &samples, &encoded, Some((&track, &audio))).unwrap();

        assert_eq!(&bytes[4..8], b"ftyp");
        let moov_at = find_box(&bytes, b"moov");
        let moov = &bytes[moov_at..];

        // 两条轨：视频（vide）+ 声音（soun），各自的 stco 一条。
        assert_eq!(find_all_boxes(moov, b"trak").len(), 2);
        assert_eq!(find_all_boxes(moov, b"vide").len(), 1);
        assert_eq!(find_all_boxes(moov, b"soun").len(), 1);
        assert_eq!(find_all_boxes(moov, b"stco").len(), 2);
        // AudioSpecificConfig 原样进了 esds。
        assert!(find_all_boxes(moov, b"esds").len() == 1);
        assert!(moov.windows(2).any(|pair| pair == [0x11, 0x90]));

        // 音频自己的 mdat 紧跟在视频之后，stco 指向它的 payload。
        let audio_at = ftyp().len() + MDAT_HEADER_LEN + encoded.len();
        assert_eq!(&bytes[audio_at + 4..audio_at + 8], b"mdat");
        assert_eq!(
            be64(&bytes, audio_at + 8),
            (MDAT_HEADER_LEN + audio.len()) as u64
        );
        let audio_payload = audio_at + MDAT_HEADER_LEN;
        assert_eq!(&bytes[audio_payload..audio_payload + audio.len()], &audio);

        let stco = find_all_boxes(moov, b"stco");
        assert_eq!(
            be32(moov, stco[1] + 16),
            (audio_at + MDAT_HEADER_LEN) as u32
        );
        // 音频样本表：3 帧、每帧 1024 个采样点、timescale 是采样率。
        let stts = find_all_boxes(moov, b"stts");
        assert_eq!(be32(moov, stts[1] + 16), 3);
        assert_eq!(be32(moov, stts[1] + 20), 1024);
        let mdhd = find_all_boxes(moov, b"mdhd");
        assert_eq!(be32(moov, mdhd[1] + 20), 48_000);
        // 有音轨时 next_track_ID 至少是 3。
        assert_eq!(be32(moov, find_box(moov, b"mvhd") + 104), 3);
    }

    #[test]
    fn the_movie_runs_as_long_as_the_longest_track() {
        let sample = Sample {
            size: 2,
            is_keyframe: true,
        };
        let mut track = aac();
        // 100 帧 AAC ≈ 2.13 s，比两帧视频长得多。
        track.samples = vec![1; 100];
        let bytes = mux_streaming_audio(
            &config(),
            &[
                sample,
                Sample {
                    size: 2,
                    is_keyframe: false,
                },
            ],
            &[1, 2, 3, 4],
            Some((&track, &[0u8; 100])),
        )
        .unwrap();
        let moov_at = find_box(&bytes, b"moov");
        let mvhd_at = find_box(&bytes[moov_at..], b"mvhd") + moov_at;
        let duration = be32(&bytes, mvhd_at + 24);
        // 100 * 1024 / 48000 s * 30000 ticks/s = 64000。
        assert_eq!(duration, 64_000);
    }

    #[test]
    fn an_audio_track_rejects_mismatched_or_missing_input() {
        let sample = Sample {
            size: 2,
            is_keyframe: true,
        };
        let track = aac();
        let mismatch = mux_streaming_audio(
            &config(),
            std::slice::from_ref(&sample),
            &[1, 2],
            Some((&track, &[0u8; 11])),
        );
        assert!(mismatch.is_err());

        let empty = AudioAac {
            samples: Vec::new(),
            ..aac()
        };
        assert!(mux_streaming_audio(
            &config(),
            std::slice::from_ref(&sample),
            &[1, 2],
            Some((&empty, &[])),
        )
        .is_err());

        let no_asc = AudioAac {
            asc: Vec::new(),
            ..aac()
        };
        let bytes = mux_streaming_audio(
            &config(),
            std::slice::from_ref(&sample),
            &[1, 2],
            Some((&no_asc, &[0u8; 12])),
        );
        assert!(bytes.is_err());
    }

    /// 写一个探针文件给 `ffprobe` 看容器语法（帧数据是占位字节，不能当成品播放）。
    ///
    /// ```text
    /// cargo test --lib write_a_probe_file_for_ffprobe -- --ignored --nocapture
    /// ffprobe -v error -show_streams -show_format target/mp4-audio-probe.mp4
    /// ```
    #[test]
    #[ignore]
    fn write_a_probe_file_for_ffprobe() {
        let samples: Vec<Sample> = (0..30)
            .map(|index| Sample {
                size: 900,
                is_keyframe: index % 15 == 0,
            })
            .collect();
        let encoded = vec![0u8; 900 * 30];
        let track = AudioAac {
            samples: vec![200; 94],
            sample_rate: 48_000,
            channels: 2,
            bitrate: 128_000,
            asc: vec![0x11, 0x90],
        };
        let audio = vec![0u8; 200 * 94];
        let bytes =
            mux_streaming_audio(&config(), &samples, &encoded, Some((&track, &audio))).unwrap();
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mp4-audio-probe.mp4");
        std::fs::write(&path, bytes).unwrap();
        println!("probe written: {}", path.display());
    }

    #[test]
    fn mdat_header_uses_a_64_bit_length() {
        let header = mdat_header(100);
        assert_eq!(header.len(), MDAT_HEADER_LEN);
        assert_eq!(&header[4..8], b"mdat");
        // size = 1 是「真实长度在后面 8 字节」的约定，不是 1 字节的 box。
        assert_eq!(be32(&header, 0), 1);
        assert_eq!(be64(&header, 8), 116);

        // 超过 4 GiB 的成片不再是错误：largesize 记的就是 64 位长度。
        let huge = mdat_header(5 * 1024 * 1024 * 1024);
        assert_eq!(
            be64(&huge, 8),
            5 * 1024 * 1024 * 1024 + MDAT_HEADER_LEN as u64
        );
    }
}
