import './index.sass'
import {useEffect, useRef} from 'react';
import {Link, useSearchParams} from 'react-router-dom';
import {Avatar, Button, Card} from 'antd';
import {motion} from 'framer-motion';
import dayjs from 'dayjs';
import scrollToTop from '../../../utils/scrollToTop';
import {usePublicTalkQuery, useTalkFeedInfiniteQuery} from '../../../store/publicContentApi';
import SeoHelmet from '../../../components/SeoHelmet';

const TalkList = () => {
    const [searchParams] = useSearchParams();
    const requestedId = Number(searchParams.get('tk'));
    const tk = Number.isSafeInteger(requestedId) && requestedId > 0 && requestedId <= 2147483647
        ? requestedId : 0;
    const feed = useTalkFeedInfiniteQuery(undefined, {skip: !!tk});
    const detail = usePublicTalkQuery(tk, {skip: !tk});
    const talkList = tk ? (detail.currentData ? [detail.currentData] : [])
        : (feed.data?.pages.flatMap(page => page.items) ?? []);
    const loading = tk ? detail.isFetching : feed.isLoading;
    const failed = tk ? detail.isError : feed.isError;
    const locatedRef = useRef<number | null>(null);

    useEffect(() => { scrollToTop(); locatedRef.current = null; }, [tk]);
    useEffect(() => {
        if (!tk || !detail.currentData || locatedRef.current === tk) return;
        const el = document.getElementById(`t-${tk}`);
        if (!el) return;
        locatedRef.current = tk;
        const frame = requestAnimationFrame(() => el.scrollIntoView({block: 'center', behavior: 'auto'}));
        el.classList.add('talk-hit');
        const timer = window.setTimeout(() => el.classList.remove('talk-hit'), 1800);
        return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
    }, [tk, detail.currentData]);

    const retry = () => {
        if (tk) return detail.refetch();
        return feed.isFetchNextPageError ? feed.fetchNextPage() : feed.refetch();
    };
    return <div className='TalkContainer'>
        <SeoHelmet title='说说' url='/talk' />
        <h2>说说</h2>
        {tk > 0 && <Link className='talkBrowseAll' to='/talk'>查看全部说说</Link>}
        {loading && <div className='talkEmpty' role='status'>正在加载说说…</div>}
        {failed && <div className='talkEmpty' role='alert'>
            <span>{tk ? '这条说说不存在或暂时无法读取' : '说说没能读取出来，请稍后再试'}</span>
            <Button onClick={retry} loading={tk ? detail.isFetching : feed.isFetching}>重试</Button>
        </div>}
        {!loading && !failed && talkList.length === 0 && <div className='talkEmpty'>还没有说说</div>}
        {talkList.map((talk, index) => {
            const at = dayjs(talk.createTime);
            return <motion.div key={talk.talkKey}
                initial={tk ? false : {opacity: 0, y: -20}} animate={{opacity: 1, y: 0}}
                transition={{duration: 0.3, delay: tk ? 0 : Math.min(index % 20, 3) * 0.05}}
                className='article' style={{position: 'relative'}}>
                <h3 className='talkTime'>
                    <span className='talkTime-year'>{at.format('YYYY')}</span>
                    <span className='talkTime-day'>{at.format('MM.DD')}</span>
                </h3>
                <Card id={`t-${talk.talkKey}`} hoverable
                    style={{width: 700, marginTop: 25, fontWeight: 600}} className='talk'>
                    <Card.Meta avatar={<Avatar src={talk.avatar || undefined} />} description={<>
                        <div className='talk-head'><span className='talk-who'>{talk.nickname}</span>
                            <span className='talk-clock'>{at.format('HH:mm:ss')}</span></div>
                        <div className='talk-title'>{talk.talkTitle}</div>
                        <div className='talk-content'>{talk.content}</div>
                    </>} />
                </Card>
            </motion.div>;
        })}
        {!tk && feed.hasNextPage && !failed && <Button className='talkLoadMore'
            loading={feed.isFetching} onClick={() => feed.fetchNextPage()}>加载更多说说</Button>}
    </div>;
};

export default TalkList;
