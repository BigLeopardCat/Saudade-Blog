import React, {useMemo, useState} from "react";
import {Button, Divider, Input, Select, Space, Tag, message} from "antd";
import {useDispatch, useSelector} from "react-redux";
import {addTagOne, flattenTagOptions} from "../../apis/TagMethods.tsx";
import {fetchTags} from "../../store/components/tags.tsx";

/**
 * 文章标签选择控件（编辑器 / 后台列表行内弹窗 / 搜索表单 三处共用）。
 *
 * 为什么重写：原来的入口是编辑器里那个两级 `TreeSelect` —— 只能从既有字典里挑、
 * **不能就地新建**（要新建得先跑一趟标签管理页，回来文章还没存）、还带 `required`
 * 强制必填。用户的原话是「非常难用而且有错误」。
 *
 * 现在是一层扁平多选（一级 `编程`、二级 `Python` 都直接可搜），下拉底部可以
 * 就地新建一级标签并**自动选中刚建的那个**（需要后端返回新 id，20260919 起支持）。
 *
 * ⚠️ 过滤走 option 的 `keywords` 而不是 `label`（20261001）：二级标签的**显示名**已经从
 * `编程 / Python` 改回它自己的名字（见 `flattenTagOptions` 头注），而"搜父名也能搜到子标签"
 * 这条能力要留着 —— 于是搜索词单列一个字段。谁把 `optionFilterProp` 改回 `"label"`，
 * 谁就把"搜「编程」列不出它下面的子标签"这个退化带回来。
 *
 * 与 `Form.Item` 兼容：受控 `value` + `onChange`，直接 `name="noteTags"` 用即可。
 */
interface NoteTagSelectProps {
    value?: number[];
    onChange?: (value: number[]) => void;
    /** 是否允许就地新建（搜索表单这种纯筛选场景传 false） */
    allowCreate?: boolean;
    placeholder?: string;
    style?: React.CSSProperties;
    disabled?: boolean;
}

// 新建标签的配色：按名字哈希取，同一个词永远同一个颜色（不是随机，免得每次刷新都在变）
const NEW_TAG_COLORS = ['#1677ff', '#52c41a', '#fa8c16', '#eb2f96', '#722ed1', '#13c2c2', '#f5222d', '#a0d911'];

function colorForName(name: string): string {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = (hash * 31 + name.charCodeAt(i)) % 100000;
    }
    return NEW_TAG_COLORS[hash % NEW_TAG_COLORS.length];
}

const NoteTagSelect: React.FC<NoteTagSelectProps> = ({
    value,
    onChange,
    allowCreate = true,
    placeholder = '请选择文章标签（可搜索，也可直接新建）',
    style,
    disabled,
}) => {
    const dispatch = useDispatch();
    const tagList = useSelector((state: {tags: any}) => state.tags.tag);
    const [newTagName, setNewTagName] = useState('');
    const [creating, setCreating] = useState(false);

    const options = useMemo(() => flattenTagOptions(tagList), [tagList]);
    const colorOf = useMemo(() => {
        const map = new Map<number, string | undefined>();
        options.forEach(opt => map.set(opt.value, opt.color));
        return map;
    }, [options]);

    /**
     * 干净的受控值：丢掉字典里已经不存在的 id。
     *
     * 悬空 id（标签已被删、文章的 `note.tags` 还留着）在旧界面上渲染成**空白标签块**。
     * 这里直接不显示，于是「打开配置弹窗 → 保存」就顺手把这一行清干净了；
     * 注意空数组**必须**照原样回传（后端 `noteTags: ""` 就是"清空标签"的语义），
     * 所以不能因为"看起来是空的"就跳过 onChange。
     */
    const safeValue = useMemo(
        () => (Array.isArray(value) ? value.filter(v => colorOf.has(v)) : []),
        [value, colorOf],
    );

    const handleCreate = async () => {
        const title = newTagName.trim();
        if (!title) {
            message.warning('请输入标签名');
            return;
        }
        setCreating(true);
        try {
            const res = await addTagOne({title, color: colorForName(title)});
            const newId = Number(res?.data?.data);
            await dispatch<any>(fetchTags());
            if (Number.isInteger(newId) && newId > 0) {
                onChange?.([...safeValue, newId]);
            } else {
                // 后端没回 id（旧版返回的死字符串 "Created"）：标签建出来了但选不上，
                // 如实提示，别让用户以为没建成。
                message.warning(`标签「${title}」已创建，请在下拉里再次选择它`);
            }
            setNewTagName('');
            message.success(`已新建标签「${title}」`);
        } catch (error) {
            message.error('新建失败（标签名可能已存在）');
        } finally {
            setCreating(false);
        }
    };

    return (
        <Select
            mode="multiple"
            value={safeValue}
            onChange={(v) => onChange?.(v as number[])}
            options={options}
            optionFilterProp="keywords"
            placeholder={placeholder}
            style={{width: '100%', ...style}}
            disabled={disabled}
            maxTagCount="responsive"
            allowClear
            showSearch
            // 标签按字典里的颜色上色，与文章卡片上的观感一致
            tagRender={(props) => {
                const {label, value: id, closable, onClose} = props;
                return (
                    <Tag
                        color={colorOf.get(id as number)}
                        closable={closable}
                        onClose={onClose}
                        style={{marginInlineEnd: 4}}
                    >
                        {label}
                    </Tag>
                );
            }}
            // antd 5.29 起 dropdownRender 已弃用（控制台 warn），popupRender 是等价替代
            popupRender={(menu) => (
                <>
                    {menu}
                    {allowCreate && (
                        <>
                            <Divider style={{margin: '4px 0'}}/>
                            <Space style={{padding: '0 8px 8px'}}>
                                {/* onMouseDown 阻止默认：不拦住的话点输入框会让下拉先失焦关闭 */}
                                <Input
                                    size="small"
                                    value={newTagName}
                                    placeholder="新建一级标签，如「后端」"
                                    onChange={(e) => setNewTagName(e.target.value)}
                                    onPressEnter={handleCreate}
                                    onMouseDown={(e) => e.preventDefault()}
                                    style={{width: 200}}
                                />
                                <Button size="small" type="primary" loading={creating} onClick={handleCreate}>
                                    新建
                                </Button>
                            </Space>
                        </>
                    )}
                </>
            )}
        />
    );
};

export default NoteTagSelect;
