use axum::{
    extract::{Multipart, State},
    Json,
};
use std::sync::Arc;
use crate::routes::AppState;
use crate::utils::{
    image_ext_ok, sniff_image_ext, upload_dir, ApiResponse, ALLOWED_IMAGE_EXTS_TEXT,
};
use std::path::Path;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use sea_orm::{ActiveModelTrait, EntityTrait, Set, QueryOrder, ColumnTrait, QueryFilter, Condition};
use crate::entity::image;
use crate::entity::note;
use crate::r2;
// LIKE 通配符转义：20261006 起唯一实现在 search_core（原先本文件与 conversation.rs 各一份）。
use crate::search_core::like_escape;
use sha2::{Digest, Sha256};

// ── 同一份字节重复上传 ⇒ 复用已有文件（20260924，用户拍板的 A 方案）─────────────
// 事故现象：博主在文章里"用一张图库里已有的图"，图库里就多出一张重复的图。
// 根因有两条，缺一不可：
//   ① 正文插图只有一条通道 = bytemd 的 uploadImages → 本接口（前端有"从图库选图"
//      的入口，但只接了封面，见 NewNotes 的 selectGalleryImage）；
//   ② 本接口对任何一次 POST 都**无条件**落新文件 + 无条件 INSERT 一行，因为文件名
//      带了秒级时间戳前缀，同一张图重传永不重名、也永远查不出重复。
// 于是"复用"实际变成"再上传一份"。取证：uploads/ 里 EMQX.png 有 4 份、agent_2.png
// 有 2 份，md5 逐字节相同、只有时间戳前缀不同。
//
// 现在的判据 = **字节相同就复用**（sha256 比对已有文件），不写盘、不新增行，
// 直接把已有 URL 还回去 —— 前端零改动、表结构零改动，一次覆盖正文/封面/图库页
// 三条上传路径。
//
// 已知盲区（不要当 bug 报）：
//   · 只按**原始文件名**筛候选（`{14位时间戳}_原名` 去掉前缀后同名）再比内容。
//     这是为了避免每次上传都把整个 uploads/ 读一遍算哈希（文件数会一直涨）；
//     代价是"同一张图改了文件名再传"仍会存两份。要连那种也去掉，把
//     `strip_timestamp_prefix` 那道 continue 删掉即可（当前目录规模下开销可忽略）。
//   · 封面/图库页上传会先经前端 `ImageCompression` 压成 800×600 q0.7（有损），
//     同一张原图走"正文（不压缩）"与"封面（压缩）"两条路会得到**不同字节**，
//     哈希不同 ⇒ 去不掉，这是有损编码的固有结果，不是判据漏洞。
//   · 历史重复行不清理（要清得先读库看引用，本批不动存量）。

/// 一次上传的候选筛选用：把 `20260912013218_EMQX.png` 还原成 `EMQX.png`。
/// 不是"时间戳_原名"形状的原样返回（手工放进 uploads/ 的文件也算候选）。
fn strip_timestamp_prefix(name: &str) -> &str {
    let bytes = name.as_bytes();
    // 14 位数字 + 下划线；前 15 字节全是 ASCII ⇒ 这里一定是字符边界
    if bytes.len() > 15 && bytes[14] == b'_' && bytes[..14].iter().all(|b| b.is_ascii_digit()) {
        &name[15..]
    } else {
        name
    }
}

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

/// 在 uploads/ 里找一份与 `digest` 逐字节相同的已有文件，返回它的站内 URL。
async fn find_duplicate_url(dir: &Path, file_name: &str, digest: &str) -> Option<String> {
    let mut entries = fs::read_dir(dir).await.ok()?;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        if strip_timestamp_prefix(&name) != file_name {
            continue;
        }
        let Ok(bytes) = fs::read(entry.path()).await else { continue };
        if sha256_hex(&bytes) == digest {
            return Some(format!("/api/protect/download/{}", name));
        }
    }
    None
}

/// 表盘一致：复用盘上已有文件时，若 `images` 里还没有指向它的行，补一条。
/// （盘上有文件而表里没行是可能的——早年上传不落库时留下的存量。）
async fn ensure_image_row(state: &Arc<AppState>, url: &str) {
    let exists = image::Entity::find()
        .filter(image::Column::ImageUrl.eq(url))
        .one(&state.db)
        .await
        .ok()
        .flatten()
        .is_some();
    if !exists {
        let _ = image::ActiveModel {
            image_url: Set(url.to_string()),
            ..Default::default()
        }
        .insert(&state.db)
        .await;
    }
}

// LIKE 的通配符转义：图库 URL 里几乎每张图都带 `_`（`20260912013218_EMQX.png`），
// 而 `_` 在 LIKE 里是"任意单字符"——不转义的话 `a_b.png` 会命中 `axb.png`。
// 这里原先有一份私有实现（与 `routes/conversation.rs` 的同名函数同款，注释写着"没合并到
// 一处是为了不动那条链路"）。20261006 聚合搜索要用第三处 ⇒ 三处一份，实现在
// `crate::search_core::like_escape`。两份旧实现语义逐字等价（链式 replace 与逐字符遍历同结果）。

/// 这张图还有哪些文章在用（封面字段 / 正文文本）。返回 (文章 id, 标题)。
async fn notes_using(state: &Arc<AppState>, url: &str) -> Vec<(i32, String)> {
    note::Entity::find()
        .filter(
            Condition::any()
                .add(note::Column::Cover.eq(url))
                .add(note::Column::Content.like(format!("%{}%", like_escape(url)))),
        )
        .all(&state.db)
        .await
        .map(|rows| {
            rows.into_iter()
                .map(|n| {
                    let title: String = n.title.chars().take(20).collect();
                    (n.id, title)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `/api/protect/download/20260912013218_EMQX.png` → `20260912013218_EMQX.png`
/// （报错信息里给人看的短名）。
fn image_short_name(url: &str) -> String {
    url.rsplit('/').next().unwrap_or(url).to_string()
}

// ── 这次上传落到哪儿（20261006，用户第 1 条：图库页两颗按钮）───────────────────
// 事故形状：图库页只有一颗上传钮，而它被 `uploadBlocked()` 按 R2 的状态灰掉 ——
// R2 一开、用量又读不出来（令牌没配好时的常态），**本机盘那条路明明是好的却点不动**。
// 根因不是前端那一颗钮，是**后端没有任何"这次走哪条"的显式入口**：`try_r2_upload`
// 在 `cfg.active()` 为真时永不返回 `None`，于是"存本机盘"这件事在 R2 开着的时候就
// 没有一条能走的路（静默改道，不是报错）。这个枚举就是把那个入口补出来。

/// 一次上传的目标。**缺省 = 跟面板开关走**，所以编辑器插图 / 文章封面 / bytemd 拖拽
/// 粘贴（都不传 `target`）的行为与从前逐字节相同。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum UploadTarget {
    /// 缺省：面板说存 R2 就存 R2，否则落本机盘。
    FollowPanel,
    /// 这次**一定**落本机盘，即使 R2 开着。
    Local,
    /// 这次**一定**进桶，**没配好就报错**（绝不回落本机盘）。
    R2,
}

impl UploadTarget {
    /// `None`/空串 = 跟面板走；**认不出的值返回 `None`（调用方据此报错）** ——
    /// 打错一个字就悄悄按缺省处理，是这一族里最贵的错（人以为传到了 R2，图躺在服务器上）。
    fn parse(raw: Option<&str>) -> Option<Self> {
        match raw.map(str::trim) {
            None | Some("") => Some(UploadTarget::FollowPanel),
            Some("local") => Some(UploadTarget::Local),
            Some("r2") => Some(UploadTarget::R2),
            Some(_) => None,
        }
    }
}

/// 客户端给的后缀与**字节头认出来的**类型是否相容。`jpg`/`jpeg` 是同一个东西的两种
/// 写法，其余必须逐字相同（大小写不敏感）。不相容时调用方按认出来的类型改名 ——
/// 出图那侧加了 `nosniff` 之后，"后缀说 png、字节是 jpeg"的表现就是**图打不开**。
fn ext_matches_content(name: &str, sniffed: &str) -> bool {
    let Some((_, ext)) = name.rsplit_once('.') else {
        return false;
    };
    if ext.eq_ignore_ascii_case(sniffed) {
        return true;
    }
    let jpeg = |s: &str| s.eq_ignore_ascii_case("jpg") || s.eq_ignore_ascii_case("jpeg");
    jpeg(ext) && jpeg(sniffed)
}

/// 落盘 / 进桶用的名字：原名（已取 basename）在**后缀与内容相容**时原样保留，
/// 否则把后缀换成认出来的那个。名字为空则退回 `image`。
///
/// 为什么不是无条件改名：`find_duplicate_url` 是按**去掉时间戳前缀后的原名**筛候选的
/// （20260924 那条去重判据），改名的范围越宽，同一张图重传时越容易筛不中而存成两份。
fn normalize_file_name(raw: &str, sniffed: &str) -> String {
    let stem = match raw.rsplit_once('.') {
        Some((s, _)) => s,
        None => raw,
    };
    let stem = if stem.is_empty() { "image" } else { stem };
    if ext_matches_content(raw, sniffed) {
        raw.to_string()
    } else {
        format!("{}.{}", stem, sniffed)
    }
}

// ── R2 图床路径（20261006，用户第 3 条）─────────────────────────────────────
// 目标不是"存得下"，是**出图带宽离开这台 3M 上行的机器**（`/api/protect/download/`
// 是上行大头）；用户另有一条硬要求：用量超 9.5G 就停传，防止产生账单。
//
// 一条铁律贯穿这个文件：**面板上写着存 R2 的时候，图绝不许悄悄落回本地盘**。
// 所以这里只有"走 R2"和"这不是 R2 的活（`None`）"两种返回，没有"R2 失败就回落"——
// 回落的后果是图库页面显示着一堆 `https://…` 地址、文件却躺在服务器上，
// 而这件事没有任何人会看出来（直到盘满）。
//
// 本地那条路径**一行都没改**：`try_r2_upload` 返回 `None` 时控制流原样继续。
// 这样"没配 R2 的部署行为与今天逐字节相同"是由结构保证的，不是靠人记住。

/// 上传临界区：`列桶 → 判定 → PUT` 三步必须**串行**。两个并发上传各自读到
/// "还剩 1MB"，就会一起写进去、一起超限 —— 配额判定读的是一个共享的外部状态，
/// 它天然需要临界区。静态量而不是 `AppState` 字段：这是进程级互斥，与请求无关。
static R2_UPLOAD_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// 体积给人看的 GB（GiB 口径，与面板上的 `r2ImageQuotaGB` 同一把尺子）。
fn gib(bytes: u64) -> f64 {
    bytes as f64 / (1024.0 * 1024.0 * 1024.0)
}

/// 按扩展名给 content-type。**不能省**：R2 会把上传时存的类型原样回给浏览器，
/// 给错了就是"图能下、但浏览器当文件下载"或者不显示。
///
/// 20261006 起 `svg` 的分支删掉了：上传口只收白名单里的后缀（`utils::ALLOWED_IMAGE_EXTS`，
/// SVG 故意不在里面 —— 它由本站同源直出时会带脚本），所以 `.svg` 到不了这里；
/// 留着那条分支等于给"哪天白名单松了"预备一条同源 XSS 的出图口。
/// 末尾那个 `_` 分支同理：正常路径下不可达，兜底给 `octet-stream` 是"宁可下载不可内联"。
fn guess_content_type(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

/// 走 R2 的整条上传路径。`None` = **这次不该走 R2**（开关关着 / 桶名·前缀·域名没配全）
/// ⇒ 调用方原样走本地盘。
///
/// `required` = 调用方是不是**点名**要 R2 的（`target=r2`）。点名了却没配全时返回
/// `Some(错误)` 而不是 `None` —— 与文件头那条铁律同一个取向：**面板/用户说了 R2，
/// 图就绝不许悄悄落回本地盘**，宁可这次传不成。缺省（`target` 不传）时仍是 `None`，
/// "没配 R2 的部署行为与从前逐字节相同"因此由结构保证。
async fn try_r2_upload(
    state: &Arc<AppState>,
    file_name: &str,
    data: &[u8],
    digest: &str,
    required: bool,
) -> Option<ApiResponse<String>> {
    let cfg = r2::load_config(&state.db).await;
    if !cfg.active() {
        if required {
            return Some(ApiResponse::error(
                "这次指定了上传到 R2，但面板里的 R2 图床没有配全（开关 / 桶名 / 前缀 / \
                 公开域名四项缺一不可）。这次没有上传任何文件：请到「站点设置 → 图库存储」\
                 补齐，或改传本站服务器。",
            ));
        }
        return None;
    }
    let Some(creds) = r2::load_creds() else {
        // 面板说"存 R2"、服务端却没有凭据：**报错而不是偷偷落本地盘**。
        // 这一条是"面板与事实不符"里最容易发生也最难发现的一种。
        return Some(ApiResponse::error(
            "图库已切到 R2，但服务端没有 R2 凭据（.env 缺 R2_ENDPOINT / R2_ACCESS_KEY / \
             R2_SECRET_KEY）。这次没有上传任何文件：请补齐凭据，或先关掉面板里的 R2 开关。",
        ));
    };

    let key = r2::object_key(&cfg.prefix, digest, file_name);
    let url = r2::public_url(&cfg.public_base, &key);

    // ① 同一份字节传过没有。对象键是内容寻址的（`<前缀>/<sha256 前 16 位>/<原名>`），
    //    所以"同一个键"就是"同一份字节 + 同一个名字"——与本地那条
    //    「同一份字节重复上传 ⇒ 复用」（20260924 用户拍板）判据逐字同形。
    match r2::head_object(&creds, &cfg.bucket, &key).await {
        Ok(true) => {
            ensure_image_row(state, &url).await;
            return Some(ApiResponse {
                code: 200,
                message: "这张图在 R2 上已经存在，已复用（未重复上传）".to_string(),
                data: url,
            });
        }
        Ok(false) => {}
        Err(e) => {
            return Some(ApiResponse::error(&format!(
                "R2 探测对象失败，本次未上传（没有回落本地盘）：{e}"
            )))
        }
    }

    // ② 用量判定与写入在同一临界区里
    let _guard = R2_UPLOAD_LOCK.lock().await;
    let used = match r2::list_used_bytes(&creds, &cfg.bucket, &cfg.prefix).await {
        Ok(v) => v,
        Err(e) => {
            // fail-closed：读不出用量就不写。最坏是"这会儿传不了图"，
            // 绝不会是"漏算用量、账单照跑"（用户要防的就是后者）。
            return Some(ApiResponse::error(&format!(
                "R2 用量读不出来，本次未上传（宁可暂时传不了，也不冒超配额的风险）：{e}"
            )));
        }
    };
    if r2::quota_exceeded(used, data.len() as u64, cfg.quota_bytes) {
        return Some(ApiResponse::error(&format!(
            "R2 已用 {:.2} GB / 上限 {:.2} GB，再传这张会超限，已拒绝。请先清理，或在面板里调高配额。",
            gib(used),
            gib(cfg.quota_bytes)
        )));
    }

    if let Err(e) =
        r2::put_object(&creds, &cfg.bucket, &key, data.to_vec(), guess_content_type(file_name)).await
    {
        return Some(ApiResponse::error(&format!(
            "上传到 R2 失败，本次未上传（没有回落本地盘）：{e}"
        )));
    }

    ensure_image_row(state, &url).await;
    Some(ApiResponse::success(url))
}

// POST /api/protect/upload
//
// multipart 字段：`file`（必给，第一个带 file_name 的段）+ 可选的 `target`
// （`local` / `r2`；不传 = 跟面板开关走）。**先收字段、后处理**：各段的顺序由客户端
// 决定，而这里原来是一边收一边处理、碰到第一个文件段就 `return` —— 那样"target 必须
// 排在 file 前面"就成了一个没人写下来的隐式契约，前端换个 append 顺序就静默失效。
pub async fn upload_image(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Json<ApiResponse<String>> {
    let upload_dir = upload_dir();

    let mut target_raw: Option<String> = None;
    let mut received: Option<(String, axum::body::Bytes)> = None;
    loop {
        let field = match multipart.next_field().await {
            Ok(Some(f)) => f,
            Ok(None) => break,
            Err(e) => {
                tracing::warn!("[upload] 读取 multipart 失败：{}", e);
                return Json(ApiResponse::error("读取上传内容失败（可能超过大小上限）"));
            }
        };
        let part_name = field.name().unwrap_or_default().to_string();
        let file_name = field.file_name().map(|s| s.to_string());

        if let Some(raw_name) = file_name {
            // 只取第一个文件段（与从前"碰到第一个文件段就处理"的行为一致）。
            // 其余的段必须读掉：不读完，后面的段边界解析不出来。
            let data = match field.bytes().await {
                Ok(b) => b,
                Err(e) => {
                    tracing::warn!("[upload] 读文件体失败：{}", e);
                    return Json(ApiResponse::error("文件读取失败（可能超过大小上限）"));
                }
            };
            if received.is_none() {
                // 只保留 basename：客户端给的名字里可能带路径
                let base = Path::new(&raw_name)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                received = Some((base, data));
            }
        } else if part_name == "target" {
            match field.text().await {
                Ok(t) => target_raw = Some(t),
                Err(e) => {
                    tracing::warn!("[upload] 读 target 失败：{}", e);
                    return Json(ApiResponse::error("读取上传目标失败"));
                }
            }
        } else {
            let _ = field.bytes().await; // 无关字段：读掉即可
        }
    }

    let Some((raw_name, data)) = received else {
        return Json(ApiResponse::error("没有收到文件"));
    };

    // 非法 target ⇒ 明确报错，**不静默当代缺省**（打错一个字就进桶是最贵的错）
    let Some(target) = UploadTarget::parse(target_raw.as_deref()) else {
        return Json(ApiResponse::error(
            "上传目标只认 local（本站服务器）或 r2（R2 图床）。这次没有上传任何文件。",
        ));
    };

    // ① 只收图片：**后缀**在名单里。名单住在 `utils`（与头像那扇门共用一把尺子）。
    if !image_ext_ok(&raw_name) {
        return Json(ApiResponse::error(&format!(
            "只收图片（{ALLOWED_IMAGE_EXTS_TEXT}）。这次没有上传任何文件。"
        )));
    }
    // ② 只收图片：**内容**得真是图片。名字是客户端说了算的，不参与判定。
    let Some(sniffed) = sniff_image_ext(&data) else {
        return Json(ApiResponse::error(&format!(
            "这个文件的内容不是图片（只收 {ALLOWED_IMAGE_EXTS_TEXT}）。这次没有上传任何文件。"
        )));
    };
    // ③ 落盘名/对象键的后缀以**认出来的**类型为准 —— 后缀与字节从此不会打架
    //    （出图那侧带 `nosniff`，打架的表现是图打不开）
    let file_name = normalize_file_name(&raw_name, sniffed);

    // 命中已有文件 = 这次上传根本不需要发生：不写盘、不新增行
    let digest = sha256_hex(&data);

    // R2 图床。`Local` 整段跳过（**即使面板开着 R2** —— 这正是本轮补上的那条路）；
    // 缺省/`r2` 才问 `try_r2_upload`，它返回 `None` 时才继续往下走本机盘。
    if target != UploadTarget::Local {
        let required = target == UploadTarget::R2;
        if let Some(resp) = try_r2_upload(&state, &file_name, &data, &digest, required).await {
            return Json(resp);
        }
    }

    // ── 本机盘 ────────────────────────────────────────────────────────────
    if let Err(e) = fs::create_dir_all(&upload_dir).await {
        tracing::error!("[upload] 建上传目录失败 {:?}: {}", upload_dir, e);
        return Json(ApiResponse::error("服务端存储不可用，请稍后再试"));
    }
    if let Some(existing) = find_duplicate_url(&upload_dir, &file_name, &digest).await {
        ensure_image_row(&state, &existing).await;
        return Json(ApiResponse::success(existing));
    }

    // Prepend timestamp to avoid collision（本地时区钟面，与 DB 时间约定一致）
    let timestamp = chrono::Local::now().format("%Y%m%d%H%M%S").to_string();
    let new_name = format!("{}_{}", timestamp, file_name);
    let file_path = upload_dir.join(&new_name);

    let mut file = match fs::File::create(&file_path).await {
        Ok(f) => f,
        Err(e) => {
            tracing::error!("[upload] 建文件失败 {:?}: {}", file_path, e);
            return Json(ApiResponse::error("保存失败，请稍后再试"));
        }
    };
    if let Err(e) = file.write_all(&data).await {
        tracing::error!("[upload] 写文件失败 {:?}: {}", file_path, e);
        let _ = fs::remove_file(&file_path).await; // 半截文件不留在盘上
        return Json(ApiResponse::error("保存失败，请稍后再试"));
    }

    // Use relative path matching the ServeDir route
    let url = format!("/api/protect/download/{}", new_name);

    // Insert to DB
    let new_image = image::ActiveModel {
        image_url: Set(url.clone()),
        ..Default::default()
    };
    let _ = new_image.insert(&state.db).await;

    Json(ApiResponse::success(url))
}

// GET /api/protect/images
pub async fn list_images(
    State(state): State<Arc<AppState>>,
) -> Json<ApiResponse<Vec<image::Model>>> {
    let images = image::Entity::find()
        .order_by_desc(image::Column::ImageKey)
        .all(&state.db)
        .await
        .unwrap_or_default();

    Json(ApiResponse::success(images))
}

// DELETE /api/protect/delImg
pub async fn delete_images(
    State(state): State<Arc<AppState>>,
    Json(urls): Json<Vec<String>>,
) -> Json<ApiResponse<String>> {
    // ── 引用检查（20260924）────────────────────────────────────────────────
    // 上传去重之后，"同一张图被多篇文章共用"会成为常态，而删除一直是**裸删**：
    // 直接 remove_file + delete_by_id，不看还有谁在用它 —— 那意味着在图库里删一次，
    // 可能同时把好几篇文章的正文/封面删成裂图，且不可逆（文件是真删）。
    // 判据：note.cover 等于该 URL，或 note.content 里出现该 URL（封面与正文都是字符串）。
    //
    // 有任一被引用就**整体不删**：批量勾选时"删一半留一半"既难解释也难回滚，
    // 宁可让博主先去文章里换掉那张图，再回来删。message 里报清是哪几张、被谁用。
    let mut blockers: Vec<String> = Vec::new();
    for url in &urls {
        let users = notes_using(&state, url).await;
        if !users.is_empty() {
            let shown: Vec<String> = users.iter().take(3)
                .map(|(id, title)| format!("#{} {}", id, title))
                .collect();
            let more = if users.len() > 3 { format!(" 等 {} 篇", users.len()) } else { String::new() };
            blockers.push(format!("{} ← {}{}", image_short_name(url), shown.join("、"), more));
        }
    }
    if !blockers.is_empty() {
        return Json(ApiResponse::error(&format!(
            "这些图片还有文章在用，已全部跳过（未删除任何图片）：{}",
            blockers.join("；")
        )));
    }

    // R2 的两样东西在循环外各取一次（每张图都读一遍库/环境没意义）
    let r2cfg = r2::load_config(&state.db).await;
    let r2creds = r2::load_creds();
    // R2 侧删除失败的那些（非 404）。有就整体报错——**但库里成功的那些已经删了**，
    // 报错文案要把这件事说清楚（不然博主会以为一张都没删）。
    let mut r2_failed: Vec<String> = Vec::new();

    let upload_dir = upload_dir();
    for url in urls {
        // Find in DB
        if let Ok(Some(img)) = image::Entity::find()
            .filter(image::Column::ImageUrl.eq(&url))
            .one(&state.db)
            .await
        {
            // ── R2 的图（20261006）──────────────────────────────────────────
            // **必须走这里**：R2 的 URL 是绝对地址，下面的本地分支既找不到
            // `/upload/` 也找不到 `/download/`，会直接跳过删文件那步、把库里的行删掉
            // —— 对象于是永远留在桶里，没有任何入口能再看见它（盘看不见、账单看得见）。
            // 顺序也与本地相反：**先删对象，成功才删行**（404 也算成功：本来就没了）。
            if let Some(key) = r2::r2_key_of(&url, &r2cfg) {
                match r2creds.as_ref() {
                    None => r2_failed.push(format!(
                        "{}（服务端没有 R2 凭据，无法删除对象）",
                        image_short_name(&url)
                    )),
                    Some(creds) => match r2::delete_object(creds, &r2cfg.bucket, &key).await {
                        Ok(()) => {
                            let _ = image::Entity::delete_by_id(img.image_key).exec(&state.db).await;
                        }
                        Err(e) => r2_failed.push(format!("{}（{e}）", image_short_name(&url))),
                    },
                }
                continue;
            }
            // 绝对地址、却不是当前公开域名下的（多半是面板里换过域名）：
            // **不删行**——删了就等于把对象丢在桶里且再也没人看得见它。
            if url.starts_with("http://") || url.starts_with("https://") {
                r2_failed.push(format!(
                    "{}（不是当前 R2 公开域名下的地址，改过域名？）",
                    image_short_name(&url)
                ));
                continue;
            }

            // Delete file logic: Extract filename from URL
            let filename_opt = if let Some(part) = url.split("/upload/").nth(1) {
                Some(part)
            } else if let Some(part) = url.split("/download/").nth(1) {
                Some(part)
            } else {
                None
            };

            if let Some(filename) = filename_opt {
                 if let Some(safe_name) = std::path::Path::new(filename).file_name() {
                     let path = upload_dir.join(safe_name);
                     let _ = tokio::fs::remove_file(path).await;
                 }
            }
            
            // Delete from DB
            let _ = image::Entity::delete_by_id(img.image_key).exec(&state.db).await;
        }
    }
    if !r2_failed.is_empty() {
        return Json(ApiResponse::error(&format!(
            "这几张的 R2 对象没删掉，图库里的行也保留着（其余已删除）：{}",
            r2_failed.join("；")
        )));
    }
    Json(ApiResponse::success("Deleted".to_string()))
}

// ── R2 用量（面板用量条的数据源）────────────────────────────────────────────
/// ⚠️ `used_bytes` 在**列表失败时是 0**，而 `0` 不是"用量是 0"的意思 ——
/// 前端必须看 `list_error` 分支：非空 ⇒ 用量条转灰、显示原因，**不许**显示 0%。
/// （这是本仓反复出现过的那类坑：缺键/缺数当成 0，于是"读不到"被读成"很空"。）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct R2Usage {
    /// 面板里的总开关（用户点的那一个）
    pub enabled: bool,
    /// 四样是否齐备（开关 + 桶名 + 前缀 + 公开域名）——即"这次上传会不会走 R2"
    pub configured: bool,
    /// 服务端 .env 里的凭据在不在（不在 ⇒ 配了也传不上去）
    pub credentials: bool,
    /// 这对凭据取自哪一组变量（`R2_IMAGE_*` = 图库专用令牌 / `R2_*` = 部署令牌）。
    /// `credentials == false` 时为 `None`。**只报来源，不含任何密钥** —— 面板上那行
    /// 就是"列桶为什么 403"最省事的判据（见 `r2.rs` 文件头"令牌按桶授权"那一段）。
    pub creds_source: Option<String>,
    pub bucket: String,
    pub prefix: String,
    pub public_base: String,
    pub quota_gb: f64,
    pub limit_bytes: u64,
    pub used_bytes: u64,
    /// **为什么没有可信读数**（未启用 / 没配全 / 没凭据 / 列表失败）。
    /// `None` 才代表 `used_bytes` 可信；非 `None` 时前端据它分支（先看 enabled/configured）。
    pub list_error: Option<String>,
}

// GET /api/protect/images/r2
pub async fn r2_usage(State(state): State<Arc<AppState>>) -> Json<ApiResponse<R2Usage>> {
    let cfg = r2::load_config(&state.db).await;
    let creds = r2::load_creds();
    let mut used_bytes = 0u64;
    let mut list_error = None;
    if cfg.active() {
        match creds.as_ref() {
            None => {
                list_error = Some(
                    "服务端没有 R2 凭据（.env 里既没有 R2_IMAGE_ACCESS_KEY / R2_IMAGE_SECRET_KEY，\
                     也没有 R2_ACCESS_KEY / R2_SECRET_KEY）"
                        .to_string(),
                )
            }
            Some(c) => match r2::list_used_bytes(c, &cfg.bucket, &cfg.prefix).await {
                Ok(v) => used_bytes = v,
                Err(e) => list_error = Some(e),
            },
        }
    } else if !cfg.enabled {
        list_error = Some("R2 图床未启用（面板里关着开关）".to_string());
    } else {
        list_error = Some("R2 图床没配全（桶名 / 前缀 / 公开域名）".to_string());
    }
    Json(ApiResponse::success(R2Usage {
        enabled: cfg.enabled,
        configured: cfg.active(),
        credentials: creds.is_some(),
        creds_source: creds.as_ref().map(|c| {
            if c.image_token {
                "R2_IMAGE_*（图库专用令牌）".to_string()
            } else {
                "R2_*（部署令牌）".to_string()
            }
        }),
        bucket: cfg.bucket,
        prefix: cfg.prefix,
        public_base: cfg.public_base,
        quota_gb: gib(cfg.quota_bytes),
        limit_bytes: cfg.quota_bytes,
        used_bytes,
        list_error,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `target` 的三态 + **非法值必须能被认出来**（调用方据此报错而不是按缺省处理）。
    #[test]
    fn upload_target_parse() {
        assert_eq!(UploadTarget::parse(None), Some(UploadTarget::FollowPanel));
        assert_eq!(UploadTarget::parse(Some("")), Some(UploadTarget::FollowPanel));
        assert_eq!(UploadTarget::parse(Some(" local ")), Some(UploadTarget::Local));
        assert_eq!(UploadTarget::parse(Some("r2")), Some(UploadTarget::R2));
        assert_eq!(UploadTarget::parse(Some("LOCAL")), None, "大小写不宽容：认不出就报错");
        assert_eq!(UploadTarget::parse(Some("server")), None);
        assert_eq!(UploadTarget::parse(Some("r2 ")), Some(UploadTarget::R2));
    }

    #[test]
    fn ext_matches_content_rules() {
        assert!(ext_matches_content("a.png", "png"));
        assert!(ext_matches_content("a.PNG", "png"), "大小写不敏感");
        assert!(ext_matches_content("a.jpg", "jpg"));
        assert!(ext_matches_content("a.jpeg", "jpg"), "jpeg 与 jpg 是同一个东西");
        assert!(ext_matches_content("a.JPEG", "jpg"));
        assert!(!ext_matches_content("a.png", "jpg"));
        assert!(!ext_matches_content("a.webp", "png"));
        assert!(!ext_matches_content("a", "png"), "没有后缀 ⇒ 不相容");
    }

    #[test]
    fn normalize_file_name_rewrites_only_on_mismatch() {
        // 相容 ⇒ **原样保留**（尽量不动名字，`find_duplicate_url` 是按去掉时间戳前缀的
        // 原名筛候选的，改名范围越宽去重越容易失效）
        assert_eq!(normalize_file_name("photo.png", "png"), "photo.png");
        assert_eq!(normalize_file_name("photo.JPEG", "jpg"), "photo.JPEG");
        // 不相容 ⇒ 后缀按**认出来的**类型改写（`nosniff` 下后缀与字节必须一致）
        assert_eq!(normalize_file_name("photo.png", "jpg"), "photo.jpg");
        assert_eq!(normalize_file_name("photo.html", "png"), "photo.png");
        assert_eq!(normalize_file_name("noext", "png"), "noext.png");
        // 名字退化的情况不许产出 ".png" 这种无名文件
        assert_eq!(normalize_file_name(".png", "jpg"), "image.jpg");
        assert_eq!(normalize_file_name("", "png"), "image.png");
    }

    /// 出图侧的 content-type 只认白名单里的后缀；**`svg` 必须落到 `octet-stream`**
    /// （它由本站同源直出，当 `image/svg+xml` 出图就是一条同源 XSS）。
    #[test]
    fn guess_content_type_has_no_svg() {
        assert_eq!(guess_content_type("a.png"), "image/png");
        assert_eq!(guess_content_type("a.JPG"), "image/jpeg");
        assert_eq!(guess_content_type("a.jpeg"), "image/jpeg");
        assert_eq!(guess_content_type("a.svg"), "application/octet-stream");
        assert_eq!(guess_content_type("a.html"), "application/octet-stream");
        assert_eq!(guess_content_type("a"), "application/octet-stream");
    }
}
