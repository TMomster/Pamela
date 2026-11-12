//! 校验生成的图标集可解码且像素值合理。
//! Verifies the generated icon set decodes and carries sane pixels.

use std::fs;
use std::path::PathBuf;

fn icons_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("two levels below the crate root")
        .join("icons")
}

#[test]
fn ico_contains_every_expected_size_and_alpha() {
    let path = icons_dir().join("icon.ico");
    let bytes = fs::read(&path).expect("icon.ico should exist");

    let dir = ico::IconDir::read(std::io::Cursor::new(bytes)).expect("icon.ico should decode");

    let mut sizes: Vec<u32> = dir.entries().iter().map(|e| e.width()).collect();
    sizes.sort_unstable();
    assert_eq!(sizes, vec![16, 24, 32, 48, 64, 256], "unexpected frame sizes");

    for entry in dir.entries() {
        let image = entry.decode().expect("each frame should decode");
        assert_eq!(image.width(), entry.width());
        assert_eq!(image.height(), entry.height());

        let alphas: Vec<u8> = image.rgba_data().iter().skip(3).step_by(4).copied().collect();
        assert!(alphas.contains(&0), "frame should have transparent corners");
        assert!(alphas.contains(&255), "frame should have an opaque body");
    }
}

#[test]
fn png_is_a_rgba_256_square() {
    let path = icons_dir().join("icon.png");
    let bytes = fs::read(&path).expect("icon.png should exist");

    assert_eq!(
        &bytes[..8],
        &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
        "PNG signature"
    );

    // IHDR 位于签名之后，依次为长度、类型与按大端序排列的宽高。
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    assert_eq!((width, height), (256, 256));
    assert_eq!(bytes[24], 8, "bit depth");
    assert_eq!(bytes[25], 6, "colour type should be RGBA");
    assert!(bytes.ends_with(&[0xae, 0x42, 0x60, 0x82]), "IEND CRC");
}
