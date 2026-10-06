import './index.css';
import img from '../../../assets/uploadImg.png'
interface UpLoadButtonProps {
    onClick: () => void;
    /**
     * 置灰（20261006 加）：图库切到 R2 之后，**配额满了或用量读不出来时不许再传**
     * （服务端那条路是 fail-closed 的，点了也只会拿到一句拒绝）。留着可点的按钮
     * 让人反复白点，比灰掉它更糟。
     *
     * `title` 是必需的搭配：按钮不能点却不说为什么，是本仓最容易被当成 bug 报的
     * 那类界面（调用方传的是服务端给的拒绝原因原文）。
     */
    disabled?: boolean;
    title?: string;
    /**
     * 按钮上的字（20261006 加，为了图库页并排的两颗上传钮）。不给 = 「上传」，
     * **且不带任何修饰类** —— 几何与从前逐字节相同（编辑器/封面那几处的调用方
     * 一个都不用改）。
     */
    label?: string;
    /**
     * 底色档（20261006 加）：不给 = 手账主色（粉）；`alt` = 墨色那一档。
     * 只有"两颗并排、必须一眼分出谁是谁"的场合才用（图库页：本站服务器 / R2 图床）。
     */
    tone?: 'alt';
}

/** 类名拼接。顺序固定，避免同一份类拼出两串不同的字符串（测试按 class 找元素）。 */
const classes = (parts: Array<string | undefined | false>) =>
    ['select', ...parts].filter(Boolean).join(' ');

const UpLoadButton = ({ onClick, disabled, title, label, tone }: UpLoadButtonProps) => {
    return (
        <button
            className={classes([
                label ? 'select-labeled' : '',
                tone === 'alt' ? 'select-alt' : '',
                disabled ? 'select-disabled' : '',
            ])}
            onClick={disabled ? undefined : onClick}
            disabled={disabled}
            title={title}
        >
            <span className="text">{label || '上传'}</span>
            <span className="icon">
                <img src={img} alt="" />
            </span>
        </button>
    );
};

export default UpLoadButton;
