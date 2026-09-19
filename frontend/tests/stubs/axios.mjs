// 测试用 axios 单例 stub：TagMethods 的纯函数不碰网络。
export default function http() { throw new Error('http stub: 纯函数测试不该发请求'); }
