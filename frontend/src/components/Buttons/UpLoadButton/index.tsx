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
}

const UpLoadButton = ({ onClick, disabled, title }: UpLoadButtonProps) => {
    return (
        <button
            className={disabled ? 'select select-disabled' : 'select'}
            onClick={disabled ? undefined : onClick}
            disabled={disabled}
            title={title}
        >
            <span className="text">上传</span>
            <span className="icon">
                <img src={img} alt="" />
            </span>
        </button>
    );
};

export default UpLoadButton;
