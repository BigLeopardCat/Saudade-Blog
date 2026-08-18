import './index.sass'
import ChatBox from "../../../components/ChatBox.tsx";
import SeoHelmet from "../../../components/SeoHelmet";

const AboutMe = () => {
    return <>
        <SeoHelmet title="关于本站" url="/about" />
        <div className="AboutContainer">
            <ChatBox />
        </div>
    </>
}

export default AboutMe