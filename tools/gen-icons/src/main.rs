// Pamela 占位图标生成器。
// Pamela — placeholder icon generator.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use flate2::write::ZlibEncoder;
use flate2::Compression;

/// 嵌入图标的尺寸集合；256 为 Windows Shell 必需，其余尺寸用于不同显示场景。
const SIZES: [u32; 6] = [16, 24, 32, 48, 64, 256];

const BACKGROUND: [u8; 3] = [14, 14, 16];
const GLYPH: [u8; 3] = [232, 232, 236];

const GLYPH_COLUMNS: &[&str] = &[
    "#######.",
    "##....##",
    "##....##",
    "##....##",
    "#######.",
    "##......",
    "##......",
    "##......",
];

fn main() -> std::io::Result<()> {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("tools/gen-icons must live two levels below the crate root")
        .to_path_buf();

    let icons_dir = repo_root.join("icons");
    fs::create_dir_all(&icons_dir)?;

    let mut images = Vec::new();
    for size in SIZES {
        images.push((size, render(size)));
    }

    let ico = encode_ico(&images);
    fs::write(icons_dir.join("icon.ico"), &ico)?;
    fs::write(
        icons_dir.join("icon.png"),
        encode_png(256, 256, &images.last().expect("256px image").1),
    )?;

    println!(
        "wrote {} ({} bytes) and icon.png to {}",
        icons_dir.join("icon.ico").display(),
        ico.len(),
        icons_dir.display()
    );
    Ok(())
}

/// 把图标渲染为直通（非预乘）RGBA8 像素。
fn render(size: u32) -> Vec<u8> {
    let mut pixels = vec![0u8; (size * size * 4) as usize];
    let radius = size as f32 * 0.22;
    let s = size as f32;

    for y in 0..size {
        for x in 0..size {
            // 计算到铺满画布的圆角正方形的有符号距离。
            let inset = (s * 0.03).max(0.5);
            let cx = x as f32 + 0.5;
            let cy = y as f32 + 0.5;
            let half = s / 2.0 - inset;
            let dx = (cx - s / 2.0).abs() - (half - radius);
            let dy = (cy - s / 2.0).abs() - (half - radius);
            let outside = (dx.max(0.0).powi(2) + dy.max(0.0).powi(2)).sqrt();
            let distance = outside + dx.max(dy).min(0.0) - radius;
            let coverage = (0.5 - distance).clamp(0.0, 1.0);

            let rgb = if glyph_covers(x, y, size) { GLYPH } else { BACKGROUND };
            let alpha = (coverage * 255.0).round() as u8;

            let offset = ((y * size + x) * 4) as usize;
            pixels[offset] = rgb[0];
            pixels[offset + 1] = rgb[1];
            pixels[offset + 2] = rgb[2];
            pixels[offset + 3] = alpha;
        }
    }

    pixels
}

/// 像素中心落在字母 P 字形内时返回 true。
fn glyph_covers(x: u32, y: u32, size: u32) -> bool {
    let s = size as f32;
    let glyph_w = s * 0.30;
    let glyph_h = glyph_w * (GLYPH_COLUMNS.len() as f32 / 8.0);
    let left = (s - glyph_w) / 2.0;
    let top = (s - glyph_h) / 2.0 + s * 0.01;

    let cx = x as f32 + 0.5;
    let cy = y as f32 + 0.5;
    if cx < left || cy < top {
        return false;
    }

    let col = ((cx - left) / glyph_w * 8.0) as usize;
    let row = ((cy - top) / glyph_h * GLYPH_COLUMNS.len() as f32) as usize;
    match GLYPH_COLUMNS.get(row.min(GLYPH_COLUMNS.len() - 1)) {
        Some(line) => line.as_bytes().get(col.min(7)) == Some(&b'#'),
        None => false,
    }
}

/// 构造包含 PNG 压缩帧的 ICO 容器。
fn encode_ico(images: &[(u32, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&0u16.to_le_bytes()); // reserved
    out.extend_from_slice(&1u16.to_le_bytes()); // type: icon
    out.extend_from_slice(&(images.len() as u16).to_le_bytes());

    // 目录条目排在前面，因此数据偏移从目录之后开始。
    let mut offset = 6 + images.len() * 16;
    let mut payload = Vec::new();

    for (size, pixels) in images {
        let png = encode_png(*size, *size, pixels);

        // ICO 目录中 256px 以 0 编码。
        let dimension = if *size >= 256 { 0u8 } else { *size as u8 };
        out.push(dimension); // width
        out.push(dimension); // height
        out.push(0); // palette colours
        out.push(0); // reserved
        out.extend_from_slice(&1u16.to_le_bytes()); // colour planes
        out.extend_from_slice(&32u16.to_le_bytes()); // bits per pixel
        out.extend_from_slice(&(png.len() as u32).to_le_bytes());
        out.extend_from_slice(&(offset as u32).to_le_bytes());

        offset += png.len();
        payload.extend_from_slice(&png);
    }

    out.extend_from_slice(&payload);
    out
}

/// 最小 PNG 编码器：8 位 RGBA，每条扫描线使用过滤类型 0。
fn encode_png(width: u32, height: u32, pixels: &[u8]) -> Vec<u8> {
    let mut raw = Vec::with_capacity((height * (1 + width * 4)) as usize);
    for y in 0..height {
        raw.push(0); // filter: None
        let start = (y * width * 4) as usize;
        raw.extend_from_slice(&pixels[start..start + (width * 4) as usize]);
    }

    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::best());
    encoder
        .write_all(&raw)
        .expect("zlib compression of image data cannot fail");
    let compressed = encoder.finish().expect("finishing the zlib stream");

    let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.push(8); // bit depth
    ihdr.push(6); // colour type: truecolour with alpha
    ihdr.push(0); // compression
    ihdr.push(0); // filter
    ihdr.push(0); // interlace
    push_chunk(&mut png, b"IHDR", &ihdr);

    push_chunk(&mut png, b"IDAT", &compressed);
    push_chunk(&mut png, b"IEND", &[]);
    png
}

fn push_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);

    let mut crc = Crc32::new();
    crc.update(kind);
    crc.update(data);
    out.extend_from_slice(&crc.finish().to_be_bytes());
}

/// 按 PNG 规范计算 CRC-32（IEEE 802.3）。
struct Crc32 {
    value: u32,
}

impl Crc32 {
    fn new() -> Self {
        Self { value: 0xffff_ffff }
    }

    fn update(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            let mut acc = (self.value ^ byte as u32) & 0xff;
            for _ in 0..8 {
                acc = if acc & 1 == 1 {
                    0xedb8_8320 ^ (acc >> 1)
                } else {
                    acc >> 1
                };
            }
            self.value = acc ^ (self.value >> 8);
        }
    }

    fn finish(&self) -> u32 {
        self.value ^ 0xffff_ffff
    }
}
