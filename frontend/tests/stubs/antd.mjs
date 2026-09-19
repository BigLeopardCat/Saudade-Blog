// 测试用极简 antd stub：只为让 TagMethods.tsx 能在 node 里加载。
// 不渲染、只当哨兵类型用（React 元素是普通对象，测试直接走 props）。
// ⚠️ 打标记属性而不是靠函数名认：esbuild 打包时会把重名的内部函数重命名（Tag → Tag2）。
export const Tag = function Tag() { return null; };
Tag.__isTag = true;
export const Popover = function Popover() { return null; };
Popover.__isPopover = true;
