export interface ViteEnv{
    readonly VITE_HTTP_BASEURL: string
    // 20260930：VITE_CHAT_GPT_TOKEN 随 src/apis/chatgpt.tsx 一起删除
    // （那个文件全仓无人 import，是早期"用 GPT 概括文章"方案的残留）。
    // .d.ts 里留着它会让后来人以为确实有这么个要配的环境变量。
}
