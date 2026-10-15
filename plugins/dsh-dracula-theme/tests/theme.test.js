// dsh-dracula-theme 自检：不联网、不需要浏览器，直接喂一个假的 window.__ModuleLoader__
// 与假的 ctx，验证浏览器半部的行为，并校验 token 表对官方暗色变量的覆盖率。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

// 必须在 import 之前挂上：lib/client.js 顶部就是 window.__ModuleLoader__.load(...)
let spec;
globalThis.window = { __ModuleLoader__: { load: (s) => { spec = s; } } };
await import('../lib/client.js');

const exported = spec.factory(() => { throw new Error('本插件不 require 任何模块'); });
const TOKENS = exported.TOKENS;

/** 跑一次 apply，记录 register / setTheme 收到的参数，并暴露 theme/change 监听器。 */
function run(preference = 'system') {
	const calls = { preference, selected: [] };
	const ctx = {
		effect(fn, label) { calls.label = label; calls.dispose = fn(); },
		on(event, listener) { calls.events = { ...calls.events, [event]: listener }; return () => {}; },
		theme: {
			register(def) { calls.definition = def; return () => {}; },
			getTheme() { return { preference: calls.preference }; },
			setTheme(id) { calls.selected.push(id); calls.preference = id; },
		},
	};
	exported.apply(ctx);
	return calls;
}

test('主机行可被扫描，浏览器半部导出 apply/inject', () => {
	assert.equal(spec.id, 'dsh-dracula-theme');
	assert.deepEqual(exported.inject, ['theme']);
	assert.equal(typeof exported.apply, 'function');
});

test('apply 注册 dracula 主题并选中它', async () => {
	const calls = run();
	assert.equal(calls.definition.id, 'dracula');
	assert.equal(calls.definition.colorScheme, 'dark');
	assert.equal(calls.definition.tokens, TOKENS);
	assert.match(calls.label, /dracula/);
	assert.deepEqual(calls.selected, [], '选中要排到微任务，不能在 apply 里同步写');
	await Promise.resolve();
	assert.deepEqual(calls.selected, ['dracula']);
});

test('已选中时不再重复写设置', async () => {
	const calls = run('dracula');
	await Promise.resolve();
	assert.deepEqual(calls.selected, []);
});

// settings scope 异步 adopt() 会把偏好复位成 'system'（自定义 id 不是合法持久值），
// theme/change 上的补选必须把它拉回来，且相等时不能重复下单（否则死循环）。
// 补选还必须是延迟的：在本轮 theme/change 派发里同步 setTheme 会让 publish() 重入
// emit，重入内层先让后注册的监听者（ui-layout 的 ThemePresenter）写上 dracula token，
// 外层继续派发时又拿旧快照（system/dark）把它擦掉 —— 症状是主题服务 active=dracula、
// DOM 上却一个 token 都没有（2026-10-14 实况，靠 queueMicrotask 修掉）。
test('偏好被 adopt 复位后延迟补选，且收敛', async () => {
	const calls = run();
	const change = calls.events['theme/change'];
	assert.equal(typeof change, 'function');
	await Promise.resolve();
	calls.preference = 'system';
	change();
	assert.deepEqual(calls.selected, ['dracula'], '补选必须在本轮派发之后，不能同步写');
	await Promise.resolve();
	assert.deepEqual(calls.selected, ['dracula', 'dracula']);
	change();
	await Promise.resolve();
	assert.deepEqual(calls.selected, ['dracula', 'dracula'], '相等时又写了一次，会死循环');
});

test('token 表是干净的 CSS 变量', () => {
	const entries = Object.entries(TOKENS);
	assert.ok(entries.length > 60, `token 太少：${entries.length}`);
	for (const [name, value] of entries) {
		assert.match(name, /^--[a-z0-9-]+$/, `非法变量名：${name}`);
		assert.match(value, /^#[0-9a-f]{6}$/i, `非法颜色值：${name}=${value}`);
	}
	// 抽查关键语义色（Atom Dracula）
	assert.equal(TOKENS['--dsw-alias-bg-base'], '#282a36');
	assert.equal(TOKENS['--dsw-alias-bg-layer-1'], '#21222c');
	assert.equal(TOKENS['--dsw-specific-sidebar-fill'], '#21222c');
	assert.equal(TOKENS['--dsw-alias-label-primary'], '#f8f8f2');
	assert.equal(TOKENS['--dsw-alias-brand-primary'], '#bd93f9');
	assert.equal(TOKENS['--dsw-alias-state-error-primary'], '#ff5555');
	assert.equal(TOKENS['--shiki-background'], '#21222c');
	assert.equal(TOKENS['--shiki-token-keyword'], '#ff79c6');
});

// 覆盖率检查：官方暗色别名块里出现的每一条变量，要么本插件直接覆盖，要么它引用的
// 色阶被覆盖。少一条就意味着界面上会残留官方配色 —— 改 token 表后必须重跑。
const DARK_BLOCK = '/home/sx/projects/MyAI/deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css';
test('覆盖官方暗色别名块的全部变量', { skip: !existsSync(DARK_BLOCK) && '找不到官方 CSS（非本机开发环境）' }, () => {
	const lines = readFileSync(DARK_BLOCK, 'utf8').split('\n');
	// 文件里有静态色阶块与语义别名块各两份（light/dark），取最后一份 dark 别名块。
	const start = lines.map((l) => l.includes('body[data-ds-dark-theme]')).lastIndexOf(true);
	assert.ok(start >= 0, '找不到暗色块');
	const missing = [];
	for (const [, name, value] of lines.slice(start).join('\n').matchAll(/--dsw-([a-z0-9-]+):\s*([^;]+);/g)) {
		const token = `--dsw-${name}`;
		if (TOKENS[token]) continue;
		const value2 = value.trim();
		// 半透明遮罩/描边（rgba）在任意暗底上观感一致，官方值照留，不算漏覆盖。
		if (/^rgba\(/.test(value2)) continue;
		const ramp = value2.match(/^var\((--[a-z0-9-]+)\)$/);
		if (ramp && TOKENS[ramp[1]]) continue;
		missing.push(`${token} -> ${value2}`);
	}
	assert.deepEqual(missing, [], `以下变量没被 Dracula 覆盖：\n${missing.join('\n')}`);
});
