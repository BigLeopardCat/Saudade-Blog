import {t as tr, useLocale} from '../../../i18n';
import './index.sass'
import ChatBox from "../../../components/ChatBox.tsx";
import SeoHelmet from "../../../components/SeoHelmet";

const AboutMe = () => {
    useLocale();
    return <>
        <SeoHelmet title={tr("关于本站")} url="/about" />
        <div className="AboutContainer">
            <ChatBox />
        </div>
    </>
}

export default AboutMe