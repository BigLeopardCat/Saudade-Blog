# 站内表情素材

2026-11-02 更新为24款日系动漫透明贴纸：针织衫、卫衣、休闲夹克三套服饰各8款。
旧12个中文别名继续使用，新目录位于 `frontend/public/stickers/v2/`；旧PNG路径同步更新。

- 网页素材为256px透明WebP，共664,118字节，表情选择器按需加载。
- 24张原始PNG已归档至博客R2图库，共48,991,596字节。
- 全部原图上传后重新下载，与生成文件逐字节及SHA-256比对一致，并确认图库记录存在。
- [原图下载与校验清单](assets/sticker-originals-20261102.json)保存各表情的原始URL、字节数和SHA-256。
- `frontend/public/stickers/v2/manifest.json`保存内置image_gen生成方式、提示词集、服饰、姿势及素材哈希。

Markdown和普通文本都使用 `:名字:`；目录定义在 `frontend/src/utils/stickers.ts`。
未知别名按原文显示，代码中的记号不转换；不依靠修补模型文本生成动作。
图库单图上限20MiB，请求体留有有限multipart开销；图片校验、管理员鉴权与R2配额继续生效。
