import {useEffect, useRef, useState} from 'react';

type Section = {id: string; label: string; level: number};
const slug = (text: string) => text.trim().replace(/[#?&=%/\s]+/g, '-').replace(/-{2,}/g, '-') || 'section';
const hashId = () => { try { return decodeURIComponent(location.hash.slice(1)); } catch { return ''; } };

/** One heading map drives the outline, deep links, and the Agent's current_url. */
export default function ReadingOutline({sourceKey}: {sourceKey: string}) {
    const [sections, setSections] = useState<Section[]>([]);
    const [active, setActive] = useState('');
    const nav = useRef<HTMLElement>(null);
    useEffect(() => {
        const content = document.getElementById('content');
        if (!content) return;
        let headings: HTMLElement[] = [], frame = 0, initialHash = hashId();
        const header = document.querySelector<HTMLElement>('.headContainer');
        const offset = () => header?.dataset.hidden === 'true' ? 24 : Math.max(24, (header?.getBoundingClientRect().bottom || 76) + 24);
        const scrollToHeading = (id: string) => {
            const heading = headings.find(item => item.id === id);
            if (heading) window.scrollTo({top: window.scrollY + heading.getBoundingClientRect().top - offset(), behavior: 'instant'});
        };
        const update = () => {
            frame = 0;
            if (!headings.length) { setActive(''); return; }
            const top = offset();
            content.style.setProperty('--reading-offset', `${top}px`);
            let current = headings[0];
            for (const heading of headings) {
                if (heading.getBoundingClientRect().top <= top + 2) current = heading;
                else break;
            }
            if (content.getBoundingClientRect().top < top && content.getBoundingClientRect().bottom <= innerHeight + 2)
                current = headings[headings.length - 1];
            setActive(current.id);
            // Do not replace an incoming deep link before its heading exists.
            if (!initialHash && content.getBoundingClientRect().top <= top && hashId() !== current.id)
                history.replaceState(history.state, '', location.pathname + location.search + '#' + encodeURIComponent(current.id));
        };
        const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
        const collect = () => {
            const used = new Set<string>();
            headings = [...content.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')];
            const entries = headings.map(heading => {
                const base = heading.dataset.readingId || heading.id || slug(heading.textContent || '');
                let id = base, suffix = 2;
                while (used.has(id)) id = `${base}-${suffix++}`;
                used.add(id);
                heading.id = id;
                heading.dataset.readingId = id;
                return {id, label: heading.textContent?.trim() || '未命名章节', level: Number(heading.tagName.slice(1))};
            });
            setSections(entries);
            if (initialHash && headings.some(heading => heading.id === initialHash)) {
                scrollToHeading(initialHash);
                initialHash = '';
            }
            schedule();
        };
        const onHash = () => { initialHash = ''; scrollToHeading(hashId()); schedule(); };
        const onUserScroll = () => { initialHash = ''; schedule(); };
        const mutation = new MutationObserver(collect);
        mutation.observe(content, {childList: true, subtree: true, characterData: true});
        const resize = new ResizeObserver(schedule);
        resize.observe(content);
        if (header) resize.observe(header);
        collect();
        header?.addEventListener('transitionend', schedule);
        const headerState = new MutationObserver(schedule);
        if (header) headerState.observe(header, {attributes: true, attributeFilter: ['data-hidden']});
        window.addEventListener('scroll', schedule, {passive: true});
        window.addEventListener('resize', schedule);
        window.addEventListener('hashchange', onHash);
        window.addEventListener('wheel', onUserScroll, {passive: true});
        window.addEventListener('touchmove', onUserScroll, {passive: true});
        content.addEventListener('load', schedule, true);
        return () => {
            cancelAnimationFrame(frame);
            mutation.disconnect(); resize.disconnect();
            header?.removeEventListener('transitionend', schedule); headerState.disconnect();
            window.removeEventListener('scroll', schedule);
            window.removeEventListener('resize', schedule);
            window.removeEventListener('hashchange', onHash);
            window.removeEventListener('wheel', onUserScroll);
            window.removeEventListener('touchmove', onUserScroll);
            content.removeEventListener('load', schedule, true);
        };
    }, [sourceKey]);
    useEffect(() => {
        const container = nav.current;
        const selected = container?.querySelector<HTMLElement>('[aria-current="location"]');
        if (!container || !selected) return;
        const bounds = container.getBoundingClientRect(), item = selected.getBoundingClientRect();
        if (item.top < bounds.top || item.bottom > bounds.bottom)
            container.scrollTop += item.top - bounds.top - 20;
    }, [active]);
    return <nav ref={nav} className="markdown-navigation" aria-label="文章目录">
        <strong className="outlineHeading">本文目录</strong>
        {sections.length ? sections.map(section => <a key={section.id} href={`#${encodeURIComponent(section.id)}`}
            className={`title-anchor${active === section.id ? ' active' : ''}`}
            aria-current={active === section.id ? 'location' : undefined}
            style={{paddingInlineStart: `${8 + (section.level - 1) * 12}px`}}>{section.label}</a>) : <span className="outlineEmpty">本文暂无小节</span>}
    </nav>;
}
