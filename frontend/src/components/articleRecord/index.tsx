import './index.sass'
import {Space} from "antd";
import {useSelector} from "react-redux";
import {useEffect, useState} from "react";
import {NoteType} from "../../interface/NoteType";
import dayjs from "dayjs";
import {renderNoteTags} from "../../apis/TagMethods.tsx";
import {getAllNotes} from "../../apis/NoteMethods.tsx";
import {parseNoteTags} from "../../utils/noteTags";
import {useNavigate} from "react-router-dom";
import {SocialType} from "../../interface/SocialType";

/**
 * 从站点设置的 Github 链接里取出**用户名**——ghchart 那个服务只认用户名，
 * 不接受整条 URL。
 *
 * 只认 `github.com/<用户名>` 这种干净的个人主页链接：多一段路径（仓库页、`/orgs/`、
 * 带 query 或 hash）一律返回空串。**宁可不显示，也不猜**——把 `github.com/foo/repo`
 * 里的 "foo" 猜出来、或拿整条 URL 去拼，得到的都是一张必然 404 的图，比不显示更糟。
 */
const githubUserOf = (url?: string): string =>
    (/^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/?$/.exec((url || '').trim()) || [])[1] || '';

interface ArticleRecordProps {
    // 明暗开关：调用方（Dashboard/Home）传的是布尔值，这里按实际类型收口
    isDark: boolean
}
const ArticleRecord = ({isDark}: ArticleRecordProps) => {
    const navigate = useNavigate();
    const [newNotes,setNewNotes] = useState<NoteType[]>([]);
    const tagList = useSelector((state: {tags: any}) => state.tags.tag)
    const socialGithub = useSelector((state: {user: {social: SocialType}}) => state.user.social?.socialGithub)
    const githubUser = githubUserOf(socialGithub)

    useEffect(() => {
        getAllNotes().then((res) => {
            setNewNotes(res.data.data.map((item: { noteTags: string; }) => {
                return {
                    ...item,
                    noteTags: parseNoteTags(item.noteTags),
                }
            }))
        })
    }, []);

    return <div className="articleRecord">
        <div className="articleRecordImg">
            {githubUser && (
                <img src={`https://ghchart.rshah.org/409ba5/${githubUser}`} alt={`${githubUser} 的 GitHub 贡献图`} />
            )}
        </div>
        <div className="articleRecordBox" style={{overflowY:"auto"}}>
            <h3>最新文章</h3>
            {newNotes.map(item => (
                <div 
                    className="articleRecordCard in" 
                    key={item.key} 
                    style={{
                        background: isDark ? 'rgba(0,0,0,0.33)' : 'rgba(255,255,255,0.33)',
                        cursor: 'pointer'
                    }}
                    onClick={() => navigate('/article/' + item.key)}
                >
                    <div className="post-date">
                        <span><i className="iconfont icon-naozhong icon" style={{ fontSize: 22, display: 'inline',verticalAlign: 'middle' }}></i>
                                         {dayjs(item.updateTime).format('YYYY-MM-DD')}</span>
                    </div>
                    <div className="article_cord">
                        <h3>" {item.noteTitle} "</h3>
                        <div style={{
                            textAlign: "left",
                            marginLeft: 25,
                            marginTop: 8,
                            marginRight: 60,
                            textIndent: '2em',
                            whiteSpace: "normal",
                            maxHeight: '2.5em',
                            lineHeight: '1.3em', /* 行高 */
                            overflow: 'hidden',
                            fontWeight: 500,
                            textOverflow: 'ellipsis'
                        }}>
                            <p>{item.description}</p>
                        </div>

                        <div className="tags">
                            <Space size={[0, 8]} wrap>
                            {renderNoteTags(item.noteTags,tagList,item.noteTagRefs)}
                            </Space>
                        </div>
                    </div>
                </div>
            ))}
        </div>
    </div>
}

export default ArticleRecord;
