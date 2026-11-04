export const fmtMinute = (s?: string): string => (s ? s.slice(0, 16) : '')

export const TALK_STATUS: Record<number, { text: string; color: string }> = {
    1: { text: '已通过', color: 'green' },
    0: { text: '待审核', color: 'gold' },
    2: { text: '未通过', color: 'red' },
}

export const MAIL_SNIPPET_CHARS = 40

export const snippet = (s?: string): string => {
    const t = (s || '').replace(/\s+/g, ' ').trim()
    if (!t) return '（无正文）'
    const cut = t.length > MAIL_SNIPPET_CHARS ? `${t.slice(0, MAIL_SNIPPET_CHARS)}…` : t
    // 正文自己就以「…」收尾时（很多人写信就这么断句）不再补第二个，免得出现「………」
    return cut.endsWith('…') ? cut : `${cut}…`
}
