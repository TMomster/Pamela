//! 系统字体枚举，供对白设计器的字体选择器使用。
//! System font enumeration for the dialogue designer's font pickers.

use std::collections::BTreeSet;
use std::sync::OnceLock;

/// 本次进程内扫描到的字体族。扫描一次即可：字体不会在进程运行期间安装。
static FAMILIES: OnceLock<Vec<String>> = OnceLock::new();

/// 返回系统已安装的全部字体族，结果排序并去重。
///
/// 第一次调用扫描平台字体目录，之后的调用复用同一份结果：设计器每打开一个
/// 标签都会问一次，重复扫描只会让窗口卡住。
pub fn list_families() -> Vec<String> {
    FAMILIES.get_or_init(scan_families).clone()
}

fn scan_families() -> Vec<String> {
    let mut database = fontdb::Database::new();
    database.load_system_fonts();

    let mut families: BTreeSet<String> = BTreeSet::new();
    for face in database.faces() {
        for (name, _) in &face.families {
            let name = name.trim();
            if !name.is_empty() {
                families.insert(name.to_string());
            }
        }
    }

    families.into_iter().collect()
}
