import http from "./axios.tsx";
import {TagLevelOne, TagLevelTwo} from "../interface/TagType";
import React from "react";
import {Popover, Tag} from "antd";

interface addNewTagOne{
    title: string,
    color: string,
}
interface addNewTagTwo{
    title: string,
    color: string,
    /** 父标签 id（后端字段名沿用了 fatherTag，值其实是 `tag_one.id`） */
    fatherTag: number
}

/** 标签 id 可能在两级里重号（两张表各自自增），所以"按 id 找名字"以一级优先 —— 与旧行为一致 */
export interface TagOption {
    value: number;
    /** **显示用的名字 = 标签自己的名字**，两级一视同仁（见 `flattenTagOptions` 头注） */
    label: string;
    /** **搜索用的词**（二级额外带上父名，所以搜父名也能命中它）。`NoteTagSelect` 靠它过滤 */
    keywords: string;
    color?: string;
    level: 1 | 2;
}

// 获取一级标签
async function getTagOne() {
    try {
        const response = await http({
            url: '/api/public/tagone',
            method: 'GET'
        });
        return response.data.data.map((item: { tagKey: number; title: string; level: number; color: string; }) => ({
            key: item.tagKey,
            title: item.title,
            level: item.level,
            color: item.color,
            children: []
        }));
    } catch (error) {
        console.error("Error fetching tag one data:", error);
        return [];
    }
}
// 新增一级标签
function addTagOne(newTag: addNewTagOne){
    return http({
        url: '/api/protected/tagone',
        method: 'POST',
        data: newTag
    })
}
// 获取二级标签
async function getTagTwo() {
    try {
        const response = await http({
            url: '/api/public/tagtwo',
            method: 'GET'
        });
        return response.data.data.map((item: { tagKey: number; title: string; level: number; color: string; fatherTag: string; fatherKey?: number }) => ({
            key: item.tagKey,
            title: item.title,
            level: item.level,
            color: item.color,
            fatherTag: item.fatherTag,
            // 父标签 **id**（20260919 后端新增）。建树用这个，**不要**用 fatherTag（父标签名字）
            // —— 按名字建树的后果是「一级标签一改名，其下所有二级标签集体从树里消失」，
            // 两个同名一级标签还会共享子标签。
            fatherKey: item.fatherKey
        }));
    } catch (error) {
        console.error("Error fetching tag two data:", error);
        return []; // or handle error as needed
    }
}
// 新增二级标签
async function addTagTwo(newTag: addNewTagTwo){
    return http({
        url: '/api/protected/tagtwo',
        method: 'POST',
        data: newTag
    })
}
/**
 * 建立标签嵌套树：**按父 id（fatherKey）挂载**。
 *
 * 兜底：`fatherKey` 缺失时（新前端撞上旧后端的那一小段窗口）退回按名字匹配，
 * 免得标签树整片空掉 —— 但这是降级路径，不是主路径。
 */
function buildTagTree(tagOneData: TagLevelOne[],tagTwoData: TagLevelTwo[]){
    return tagOneData.map(item => {
        item.children = tagTwoData.filter(child =>
            child.fatherKey !== undefined && child.fatherKey !== null
                ? child.fatherKey === item.key
                : child.fatherTag === item.title
        );
        return item;
    });
}
// 初始化树
async function initTree(){
    const tagOneData: TagLevelOne[] = await getTagOne();
    const tagTwoData: TagLevelTwo[] = await getTagTwo();
    return buildTagTree(tagOneData,tagTwoData)
}
/**
 * 删除标签。**必须带 level**：后端旧接口只收一个 id 数组、然后同时去两张表删，
 * 而两级 id 是各自自增的（删一级 #13 会连带删掉二级 #13）。现在按层级分流，
 * 只删指定表；删完后端会顺手把 `note.tags` 里指向这些 id 的引用摘掉。
 */
function delTag(level: 'one' | 'two', ids: React.Key[]) {
    return http({
        url: '/api/protected/tag',
        method: 'DELETE',
        data: { level, ids }
    })
}

/**
 * 标签树（redux 里那一棵）→ 扁平选项表。
 *
 * 两级拍平成一层，**名字就是标签自己的名字**：一级 `编程`、二级 `Python`。
 * 20261001 改版前二级显示成 `编程 / Python`（父名 / 子名），用户原话「二级标签和一级
 * 标签一样显示，不需要一级标签/二级标签这样显示二级标签」—— 标签挂在文章卡片上时，
 * 读者看到的是标签本身，层级是**管理页**的事，不该跟着上卡片。
 *
 * ⚠️ 但"搜父名也能搜到子标签"这条能力要留着（原来靠 `编程 / Python` 这个拼接串白捡）。
 * 所以显示名与搜索词**分成两个字段**：`label` = 自己的名字，`keywords` = 自己的名字
 * + 父名。`NoteTagSelect` 的 `optionFilterProp` 因此指到 `keywords` 上，
 * 而不是像以前那样指 `label`（指错了等于"搜父名搜不到任何子标签"）。
 *
 * id 重号时**后面的条目会被丢掉**（antd Select 不允许两个 option 同 value——
 * 点一个会同时选中两个），并打一条 warn 留痕。现有数据两级无交集，迁移
 * `tag_autoincrement_20260919` 之后新标签也不会再撞。
 */
function flattenTagOptions(tagList: any): TagOption[] {
    const out: TagOption[] = [];
    const seen = new Set<number>();
    const dup: number[] = [];
    const push = (id: number, label: string, color: string | undefined, level: 1 | 2,
                  keywords: string = label) => {
        if (!Number.isInteger(id) || id <= 0) return;
        if (seen.has(id)) { dup.push(id); return; }
        seen.add(id);
        out.push({ value: id, label, keywords, color, level });
    };
    (Array.isArray(tagList) ? tagList : []).forEach((one: any) => {
        const oneId = Number(one?.tagKey ?? one?.key);
        push(oneId, String(one?.title ?? ''), one?.color, 1);
        (Array.isArray(one?.children) ? one.children : []).forEach((two: any) => {
            const twoId = Number(two?.tagKey ?? two?.key);
            push(twoId, String(two?.title ?? ''), two?.color, 2, `${one?.title} ${two?.title}`);
        });
    });
    if (dup.length > 0) {
        console.warn('标签 id 在两级之间重号，已丢弃后出现的条目：', dup);
    }
    return out;
}

/** id → 标签（一级优先），渲染用 */
function tagLabelMap(tagList: any): Map<number, TagOption> {
    const map = new Map<number, TagOption>();
    flattenTagOptions(tagList).forEach(opt => map.set(opt.value, opt));
    return map;
}

/**
 * 渲染一篇文章的标签（公开页/卡片用）。
 *
 * 20260919 加固：**查不到的 id 直接不渲染**（旧版渲染 `<Tag>{undefined}</Tag>`，
 * 在列表上就是一个个空白标签小块 —— 线上 18 篇有标签的文章里 12 篇有这种悬空 id），
 * 并按 id 去重。签名保持不变（ContentHome/Article.tsx、articleRecord 都在用）。
 *
 * 20261001：**样式回到标签管理页那一套**（用户原话「标签在文章卡片的样式回到标签管理页的
 * 样式」）—— 就是 antd `<Tag color={标签自己的色}>`。20260930 那轮曾换成手账 chip
 * （纯 span + `--tg` 变量 + `.tagChip` 皮），理由是 `Tag` 的 `color` 会落成内联样式、
 * 换皮得 `!important`；现在既然要的就是管理页那副样子，那层皮整个撤掉：
 * 管理页树上的 `titleRender` 渲染的就是 `<Tag color={node.color}>{node.title}</Tag>`，
 * 与其把 chip 调到"像"它，不如直接用同一个组件 —— 这也是**同一份样式只有一处定义**。
 * `.tagChip` / `.tagChipDot` 两条 sass 规则随之删除（ContentHome/index.sass 文件尾）。
 */
function renderNoteTags(noteTags: number[],tagList: any){
    const labels = tagLabelMap(tagList);
    const seen = new Set<number>();
    const nodes: React.ReactNode[] = [];
    (Array.isArray(noteTags) ? noteTags : []).forEach(noteTag => {
        if (seen.has(noteTag)) return;
        seen.add(noteTag);
        const opt = labels.get(noteTag);
        if (!opt) return;   // 悬空 id：不渲染空白块
        nodes.push(
            // 与标签管理页树上那颗一模一样（没有 color 时不传，落回 antd 的默认灰）
            <Tag color={opt.color} key={noteTag}>
                {opt.label}
            </Tag>
        );
    });
    return nodes;
}

/**
 * 折叠渲染（后台列表的「文章标签」列用）：只显示前 `max` 个，其余收进 Popover。
 * 列宽只有 22%，不折叠的话三四个长标签名就能把这列挤爆（Tag 自带 margin 又加一层）。
 */
function renderNoteTagsCollapsed(noteTags: number[], tagList: any, max: number = 3){
    const labels = tagLabelMap(tagList);
    const ids: number[] = [];
    (Array.isArray(noteTags) ? noteTags : []).forEach(id => {
        if (!labels.has(id) || ids.includes(id)) return;   // 悬空 id 不计入、也不占名额
        ids.push(id);
    });
    if (ids.length === 0) return <span style={{opacity: .45}}>—</span>;
    const shown = ids.slice(0, max);
    const rest = ids.slice(max);
    return (
        <span style={{display: 'inline-flex', alignItems: 'center', flexWrap: 'nowrap', maxWidth: '100%', overflow: 'hidden'}}>
            {shown.map(id => {
                const opt = labels.get(id)!;
                return (
                    // margin 内联收窄：Tag 默认 8px inline-end，3 个标签光外边距就吃掉 24px
                    <Tag color={opt.color} key={id} style={{marginInlineEnd: 4, marginBottom: 0, maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis'}}>
                        {opt.label}
                    </Tag>
                );
            })}
            {rest.length > 0 && (
                <Popover
                    title="全部标签"
                    content={
                        <div style={{maxWidth: 260, display: 'flex', flexWrap: 'wrap', gap: 4}}>
                            {ids.map(id => {
                                const opt = labels.get(id)!;
                                return <Tag color={opt.color} key={id} style={{margin: 0}}>{opt.label}</Tag>;
                            })}
                        </div>
                    }
                >
                    <Tag style={{marginInlineEnd: 0, marginBottom: 0, cursor: 'pointer'}}>+{rest.length}</Tag>
                </Popover>
            )}
        </span>
    );
}


// 更新一级标签
function updateTagOne(id: number, data: { title: string; color: string }) {
    return http({
        url: `/api/protected/tagone/${id}`,
        method: 'PUT',
        data: data
    })
}

// 更新二级标签
function updateTagTwo(id: number, data: { title: string; color: string }) {
    return http({
        url: `/api/protected/tagtwo/${id}`,
        method: 'PUT',
        data: data
    })
}

export {getTagOne,getTagTwo,buildTagTree,delTag,initTree,addTagOne,addTagTwo,renderNoteTags,renderNoteTagsCollapsed,flattenTagOptions,tagLabelMap,updateTagOne,updateTagTwo}
