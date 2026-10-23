// ═ 会话级联删的清单只有一份（20261018）══
//   node tests/chat-cascade-single-source.test.mjs
//
// ## 盯的是什么
//
// 「删一个会话/删一个账号时，该跟着走的表有哪些」这份清单，此前在**两处各写一遍**，而两处
// 写的不是同一份：`routes/conversation.rs::delete_conversation` 删五张子表，
// `routes/temp_user.rs::delete_temp_user` 只删三张 —— 漏掉的 `execution_log` /
// `pending_action` / `agent_task` 在账号删除后全部变成**孤儿**：这三张表都按
// `conversation_id` 读，会话没了就再也没有任何读取路径，**也没有任何东西会红**。
//
// 修法不是"给漏的那处补三行"（那只是把同一份清单再抄一遍、等下一次再漏），是把清单收成
// 一处 `conversation::purge_conversation_data`，两处都调它。本文件锁住"收成一处"这件事。
//
// ## ⚠️ 源码锁**单独不算数**
//
// 本文件只证明"没有第二份清单"，**证明不了"清单本身是全的"** —— 一份漏了某张表的
// 唯一清单照样能让本文件全绿。所以它必须与行为判据**配对**：
// `tests/pg_integration.rs` 里"删临时账号后六张表该 uid 计数全 0"那条（它在收口之前是红的）。
// 只留源码锁 = 把"函数被调用了"当成"表被删干净了"，那是本仓明确不要的那种假绿。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};

const rust = (rel) => readFileSync(path.join(root, '..', rel), 'utf8');

/**
 * 切出顶层函数的函数体（到下一个行首 `}` 为止——本仓顶层函数都这么收尾）。
 * 名字后面紧跟 `(` 或 `<`（泛型参数，如 `purge_conversation_data<C: …>`）都算命中。
 */
const fnBody = (src, name) => {
    const i = src.indexOf(`fn ${name}`);
    if (i < 0) return null;
    const next = src[i + 3 + name.length];
    if (next !== '(' && next !== '<') return null;
    const j = src.indexOf('\n}', i);
    return j < 0 ? null : src.slice(i, j);
};

// 六张表：五张子表 + conversation 本体。改这里必须同时改
// `purge_conversation_data` 与 `tests/pg_integration.rs` 那条行为判据。
const TABLES = [
    'chat_history',
    'chat_summary',
    'execution_log',
    'pending_action',
    'agent_task',
    'conversation',
];

console.log('\n① 共用删除入口与数据库级联覆盖全部聊天表');
{
    const conv = rust('src/routes/conversation.rs');
    const body = fnBody(conv, 'purge_conversation_data');
    ok(body !== null, '`conversation.rs::purge_conversation_data` 还在');
    if (body) {
        const migration = rust('scripts/migration/pg/0013_conversation_foreign_keys.sql');
        const missing = TABLES.filter((t) => t !== 'conversation' && !migration.includes(`'${t}'`));
        ok(missing.length === 0, `  外键级联覆盖五张派生表（缺：${missing.join(', ') || '无'}）`, missing);
        ok(/FOREIGN KEY \(conversation_id\) REFERENCES conversation\(id\) ON DELETE CASCADE/.test(migration),
            '  数据库按会话编号级联，拒绝孤儿记录');
        ok(/conversation::Entity::delete/.test(body), '  共用入口实际删除会话本体');
        ok(/checkpoint_cleanup::enqueue\(db, row\.id, row\.user_id\)/.test(body),
            '  删除前登记跨服务持久清理任务');
        // 两个范围（按会话 / 按用户）都必须落地：只写一个的话，另一条调用路会静默空转。
        ok(/ConvScope::ConversationId/.test(body), '  按会话那一支在');
        ok(/ConvScope::UserId/.test(body), '  按用户那一支在（删账号走这条）');
        // 按用户那一支必须真的按 user_id 过滤（`ConversationId` 那支的过滤列是另一种）。
        ok(/conversation::Column::UserId\.eq\(uid\)/.test(body),
            '  按用户范围删除会话，派生记录通过外键级联');
    }
}

console.log('\n② 两个调用方都调它，且没有谁自己再抄一份');
{
    const sites = [
        ['src/routes/conversation.rs', 'delete_conversation', 'ConvScope::ConversationId'],
        ['src/routes/temp_user.rs', 'delete_temp_user', 'ConvScope::UserId'],
    ];
    for (const [rel, fn, scope] of sites) {
        const src = rust(rel);
        const body = fnBody(src, fn);
        ok(body !== null, `\`${rel}::${fn}\` 还在`);
        if (!body) continue;
        ok(/purge_conversation_data\(/.test(body), `  ${fn} 调了 \`purge_conversation_data\``);
        ok(body.includes(scope), `  ${fn} 用的是 ${scope}`);
        // 内联一份 = 第二份清单回来了。六张表一个都不许在这个函数体里手写。
        const inlined = TABLES.filter((t) => new RegExp(`${t}::Entity::delete`).test(body));
        ok(inlined.length === 0,
            `  ${fn} 里没有内联的级联删（有：${inlined.join(', ') || '无'}）`, inlined);
    }
}

console.log('\n③ 三张"曾经漏掉"的表在整个 routes 里只有清单一处能删');
{
    // 这三张表此前只被 `delete_conversation` 删；漏掉它们的那一处（temp_user）就是本 bug。
    // 现在全仓（routes 下）删这三张表的地方只该有 `purge_conversation_data`。
    const conv = rust('src/routes/conversation.rs');
    const body = fnBody(conv, 'purge_conversation_data') || '';
    const rest = conv.replace(body, '');
    for (const t of ['execution_log', 'pending_action', 'agent_task']) {
        const outside = (rest.match(new RegExp(`${t}::Entity::delete`, 'g')) || []).length;
        ok(outside === 0, `  conversation.rs 里 ${t} 的级联删只出现在清单里（清单外 ${outside} 处）`);
    }
    // temp_user.rs 里一张都不该有（它必须走清单）。
    const tu = rust('src/routes/temp_user.rs');
    const tuHits = ['execution_log', 'pending_action', 'agent_task']
        .filter((t) => new RegExp(`${t}::Entity::delete`).test(tu));
    ok(tuHits.length === 0, `  temp_user.rs 里没有这三张表的内联删除`, tuHits);
}

console.log(`\n${fail === 0 ? '全部通过' : `失败 ${fail} 项`}（通过 ${pass}）`);
console.log('⚠️ 本文件只证明"清单只有一份"，证明不了"清单是全的"——后者靠 tests/pg_integration.rs 那条行为判据。');
process.exit(fail === 0 ? 0 : 1);
