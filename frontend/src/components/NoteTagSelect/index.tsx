import React, {useMemo, useRef, useState} from "react";
import {Button, Divider, Input, Select, Space, Tag, message} from "antd";
import {useDispatch, useSelector} from "react-redux";
import {addTagOne, flattenTagOptions} from "../../apis/TagMethods.tsx";
import {fetchTags} from "../../store/components/tags.tsx";
import {catalogApi} from "../../store/catalogApi";
import {ok, errMsg} from "../../apis/ProfileMethods";

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

    const createLock = useRef(false);
    const handleCreate = async () => {
        if (createLock.current) return;
        const title = newTagName.trim();
        if (!title) {
            message.warning('请输入标签名');
            return;
        }
        createLock.current = true;
        setCreating(true);
        try {
            const res = await addTagOne({title, color: colorForName(title)});
            if (!ok(res)) { message.error(errMsg(res, '新建失败，请重试')); return; }
            const newId = Number(res?.data?.data);
            try {
                // A pre-write read must finish before requesting the dictionary
                // that contains the newly created ID (forceRefetch still dedupes).
                const pending = dispatch<any>(catalogApi.util.getRunningQueryThunk('tags', undefined));
                if (pending) await pending;
                await dispatch<any>(fetchTags(true)).unwrap();
            } catch {
                // The write is already confirmed. Never offer to repeat it just
                // because the following read failed.
                setNewTagName('');
                message.warning(`标签「${title}」已创建，列表刷新失败，请刷新后选择`);
                return;
            }
            if (Number.isInteger(newId) && newId > 0) {
                onChange?.([...safeValue, newId]);
            } else {
                // 后端没回 id（旧版返回的死字符串 "Created"）：标签建出来了但选不上，
                // 如实提示，别让用户以为没建成。
                message.warning(`标签「${title}」已创建，请在下拉里再次选择它`);
            }
            setNewTagName('');
            message.success(`已新建标签「${title}」`);
        } catch {
            message.error('新建失败（标签名可能已存在）');
        } finally {
            createLock.current = false;
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
