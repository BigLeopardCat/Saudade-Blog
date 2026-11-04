import './index.css';
import img from '../../../assets/uploadImg.png'
interface UpLoadButtonProps {
    onClick: () => void;
    disabled?: boolean;
    title?: string;
    label?: string;
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
