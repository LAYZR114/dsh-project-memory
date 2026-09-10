window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-project-memory",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const { useState, useEffect, useCallback, useRef, useMemo } = react;
		const h = react.createElement;

		const inject = ["slots"];
		const API = "/project-memory/api";
		function fetchJson(path, init) {
			return fetch(API + path, {
				headers: { "content-type": "application/json" },
				...init
			}).then((r) => r.json());
		}

		// 黑灰配色 + 大量圆角 + 系统黑体
		const CSS = `
.pm{font-family:-apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;color:#e6e6e6;font-size:13px;line-height:1.6;padding:18px 22px;max-width:860px;overflow:visible;scrollbar-gutter:stable}
.pm::-webkit-scrollbar{width:5px}
.pm::-webkit-scrollbar-track{background:transparent}
.pm::-webkit-scrollbar-thumb{background:#3a3a3a;border-radius:5px}
.pm::-webkit-scrollbar-thumb:hover{background:#4a4a4a}
.pm-top{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:16px}
.pm-title{font-size:16px;font-weight:700;color:#f0f0f0;margin:0 0 4px}
.pm-sub{color:#9a9a9a;font-size:12px;margin:0}
.pm-stats{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;align-items:center}
.pm-stat{background:#1d1d1d;border:1px solid #2c2c2c;border-radius:10px;padding:6px 12px;font-size:12px;color:#b5b5b5}
.pm-stat b{color:#e6e6e6;font-weight:600;margin-left:3px}
.pm-stat .pm-st{color:#8a8a8a;margin-left:4px}
.pm-stat .pm-recent{color:#c9c9c9;font-weight:600}
.pm-add{background:#3a3a3a;color:#f0f0f0;border:none;border-radius:10px;padding:8px 16px;font-size:13px;cursor:pointer}
.pm-add:hover{background:#4a4a4a}
.pm-sub-btn{background:#262626;color:#ccc;border:1px solid #333;border-radius:10px;padding:8px 14px;font-size:13px;cursor:pointer}
.pm-sub-btn:hover{background:#333}
.pm-field{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.pm-label{color:#c9c9c9;font-size:13px;white-space:nowrap}
.pm-input{flex:1;background:#1a1a1a;color:#e6e6e6;border:1px solid #333;border-radius:10px;padding:9px 12px;font-size:13px;outline:none}
.pm-input:focus{border-color:#555}
.pm-save{background:#3a3a3a;color:#f0f0f0;border:none;border-radius:10px;padding:8px 18px;font-size:13px;cursor:pointer}
.pm-bar{display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap}
.pm-tab{background:#1f1f1f;color:#b5b5b5;border:1px solid #2c2c2c;border-radius:20px;padding:5px 14px;font-size:12px;cursor:pointer}
.pm-tab.on{background:#3a3a3a;color:#f0f0f0;border-color:#3a3a3a}
.pm-tab .pm-n{font-size:11px;font-weight:600;color:#8f8f8f;margin-left:5px;background:#2a2a2a;border-radius:10px;padding:1px 7px}
.pm-tab.on .pm-n{color:#0e0e0e;background:#d8d8d8}
.pm-group{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 14px;background:#1d1d1d;border:1px solid #333;border-radius:12px;cursor:pointer;margin-top:2px;transition:background .2s ease,color .2s ease;position:sticky;top:0;z-index:5;width:100%;box-sizing:border-box}
.pm-group:hover{background:#262626}
.pm-group-collapsed{background:#232323}
.pm-group-t{font-size:13px;font-weight:700;color:#e6e6e6;display:flex;align-items:center;gap:8px}
.pm-group-n{font-size:11px;font-weight:600;color:#9a9a9a;background:#2a2a2a;border-radius:10px;padding:1px 8px}
.pm-group-c{font-size:13px;color:#8f8f8f;transition:transform .25s ease;display:inline-block}
.pm-group-collapsed .pm-group-c{transform:rotate(-90deg)}
.pm-group-items{list-style:none;margin:0;padding:0;display:grid;grid-template-rows:1fr;transition:grid-template-rows .3s ease;}
.pm-group-items.pm-group-hide{grid-template-rows:0fr;}
.pm-group-inner{overflow:hidden;display:flex;flex-direction:column;gap:10px;min-height:0;}
.pm-group-items::-webkit-scrollbar{width:0;height:0}
.pm-search{flex:1;min-width:140px;background:#1a1a1a;color:#e6e6e6;border:1px solid #333;border-radius:10px;padding:9px 12px;font-size:13px;outline:none}
.pm-list{list-style:none;margin:0;padding:0 6px 0 2px;display:flex;flex-direction:column;gap:10px;position:relative;overflow:visible}
.pm-item{display:flex;flex-direction:column;gap:8px;padding:12px 40px 12px 16px;background:#191919;border:1px solid #2c2c2c;border-radius:12px;position:relative;z-index:1;box-sizing:border-box;height:144px;min-height:144px;overflow:hidden;transition:transform .2s cubic-bezier(.2,.8,.2,1),box-shadow .2s ease,border-color .2s ease}
.pm-item .pm-head{flex:1;min-height:0}
.pm-item .pm-foot{flex:none}
.pm-head{display:flex;align-items:flex-start;gap:10px;min-width:0}
.pm-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;min-width:0}
.pm-tags{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.pm-actions{display:flex;gap:6px;align-items:center;flex:none}
.pm-item:hover{border-color:#3a3a3a}
.pm-item.pm-yield{transform:translateY(var(--pm-shift,0));will-change:transform}
.pm-item.pm-ghost{position:fixed;z-index:100;margin:0;pointer-events:none;box-shadow:0 16px 36px rgba(0,0,0,.5);opacity:.92;left:var(--pm-x,0);top:var(--pm-y,0);will-change:left,top;transition:box-shadow .12s ease}
.pm-item.pm-ghost .pm-grip{cursor:grabbing}
.pm-item.pm-selected{border-color:#3f3f3f;background:#1c1c1c}
.pm-dot{width:6px;height:6px;border-radius:50%;background:#4a4a4a;flex:none}
.pm-body{flex:1;min-width:0;overflow:hidden;cursor:pointer}
.pm-t{font-weight:600;color:#eee;font-size:14px;margin:0;overflow-wrap:break-word}
.pm-d{color:#8a8a8a;font-size:12px;margin:2px 0 0;overflow-wrap:break-word;white-space:pre-wrap}
.pm-heat{font-size:10px;color:#d8a83a;background:#2a2416;border:1px solid #3a3320;border-radius:8px;padding:0 6px;white-space:nowrap;flex:none;line-height:18px;max-width:48px;overflow:hidden;text-overflow:ellipsis}
.pm-last{font-size:10px;color:#7a9a8a;background:#16241f;border:1px solid #233430;border-radius:8px;padding:0 6px;white-space:nowrap;flex:none;line-height:18px;max-width:64px;overflow:hidden;text-overflow:ellipsis}
.pm-badge{font-size:10px;color:#b5b5b5;background:#262626;border:1px solid #333;border-radius:8px;padding:1px 6px;white-space:nowrap;flex:none}
.pm-btn{background:#262626;color:#ddd;border:1px solid #333;border-radius:10px;padding:6px 12px;font-size:12px;cursor:pointer;flex:none;white-space:nowrap}
.pm-btn:hover{background:#333}
.pm-btn.danger{color:#e08a8a;border-color:#3a2a2a}
.pm-btn.danger:hover{background:#2a1f1f}
.pm-grip{cursor:grab;color:#555;font-size:15px;user-select:none;touch-action:none;flex:none;line-height:1;position:absolute;right:10px;top:50%;transform:translateY(-50%)}
.pm-empty{color:#777;font-size:13px;text-align:center;padding:22px 0;border:1px dashed #2c2c2c;border-radius:12px}
.pm-msg{margin:12px 0 0;padding:10px 14px;border-radius:10px;background:#1d1d1d;border:1px solid #2c2c2c;font-size:12px;color:#bbb}
/* ==== 展开区块（正文 / 编辑表单）：贴在卡片下方 ==== */
.pm-ext{background:#161616;border:1px solid #2c2c2c;border-radius:12px;padding:12px 16px;margin:0;overflow:hidden;position:relative;z-index:2;box-sizing:border-box;animation:pm-ext-in .18s ease}
@keyframes pm-ext-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}
.pm-ext-scroll{max-height:225px;overflow-y:auto;padding-right:6px}
.pm-ext-body{color:#c5c5c5;font-size:13px;line-height:1.7;white-space:pre-wrap;overflow-wrap:break-word}
.pm-ext-body p{margin:0 0 8px}
.pm-ext-body p:last-child{margin-bottom:0}
.pm-ext-meta{color:#7a7a7a;font-size:11px;margin:0 0 8px;padding-bottom:8px;border-bottom:1px solid #232323}
/* 细滚动条（参考图四） */
.pm-ext-scroll::-webkit-scrollbar{width:7px;height:7px}
.pm-ext-scroll::-webkit-scrollbar-track{background:#141414;border-radius:8px}
.pm-ext-scroll::-webkit-scrollbar-thumb{background:#3a3a3a;border-radius:8px;border:1px solid #1c1c1c}
.pm-ext-scroll::-webkit-scrollbar-thumb:hover{background:#4a4a4a}
/* 编辑 / 新增表单 */
.pm-edit{display:grid;gap:10px}
.pm-edit h4{margin:0;font-size:13px;color:#eee}
.pm-edit .row{display:flex;gap:8px;justify-content:flex-end}
.pm-edit textarea{font-family:inherit;background:#1a1a1a;color:#e6e6e6;border:1px solid #333;border-radius:10px;padding:9px 12px;font-size:13px;min-height:60px;resize:vertical;outline:none}
.pm-edit textarea:focus{border-color:#555}
.pm-list.pm-dragging .pm-item{cursor:grabbing}
.pm-placeholder{position:relative;z-index:0;border:1px dashed #333;border-radius:12px;background:#141414;flex:none;transition:transform .2s cubic-bezier(.2,.8,.2,1)}
.pm-placeholder.pm-ph-move{transform:translateY(var(--pm-ph-shift,0))}
/* 删除二次确认弹层 */
.pm-confirm-overlay{position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;animation:pm-fade .15s ease}
@keyframes pm-fade{from{opacity:0}to{opacity:1}}
.pm-confirm{background:#1c1c1c;border:1px solid #333;border-radius:14px;padding:20px 22px;width:320px;max-width:88vw;box-shadow:0 22px 60px rgba(0,0,0,.5);animation:pm-pop .16s cubic-bezier(.2,.8,.2,1)}
@keyframes pm-pop{from{transform:scale(.96);opacity:0}to{transform:scale(1);opacity:1}}
.pm-confirm h4{margin:0 0 6px;font-size:15px;color:#f0f0f0}
.pm-confirm p{margin:0 0 4px;font-size:13px;color:#b5b5b5;line-height:1.6;overflow-wrap:break-word}
.pm-confirm .pm-cmsg{color:#8a8a8a;font-size:12px;margin:0 0 16px}
.pm-confirm .pm-crow{display:flex;gap:10px;justify-content:flex-end}
.pm-confirm .pm-cbtn{background:#3a3a3a;color:#f0f0f0;border:none;border-radius:10px;padding:8px 18px;font-size:13px;cursor:pointer}
.pm-confirm .pm-cbtn:hover{background:#4a4a4a}
.pm-confirm .pm-cbtn.danger{background:#3a2020;color:#e08a8a;border:1px solid #4a2a2a}
.pm-confirm .pm-cbtn.danger:hover{background:#4a2525}
/* —— 卡片防重叠（GLM 任务1）：flex 纵向 + 标题单行省略 + 简介两行截断 + 标签底部固定区 —— */
.pm-item{display:flex;flex-direction:column}
.pm-head{flex:1 1 auto;min-height:0;overflow:hidden}
.pm-t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pm-d{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin:2px 0 0}
.pm-foot{flex:0 0 auto;margin-top:6px}
/* —— 类型下拉（GLM 任务2） —— */
.pm-select{background:#262626;color:#f0f0f0;border:1px solid #3a3a3a;border-radius:10px;padding:6px 10px;font-size:13px;outline:none;cursor:pointer}
.pm-select:focus{border-color:#555}
.pm-cat-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;color:#9a9a9a;font-size:12px}
.pm-cat-hint{color:#7a7a7a;font-size:11px}
/* —— 类型 dropdown（dropdown 动画） —— */
.pm-dd{display:inline-block}
.pm-dd-btn{display:flex;align-items:center;gap:8px;background:#1d1d1d;color:#e6e6e6;border:1px solid #2c2c2c;border-radius:10px;padding:7px 14px;font-size:13px;cursor:pointer}
.pm-dd-btn:hover{background:#262626}
.pm-dd-caret{color:#8a8a8a;font-size:11px}
.pm-dd-menu{position:absolute;left:0;top:calc(100% + 6px);z-index:50;list-style:none;margin:0;padding:4px;background:#1c1c1c;border:1px solid #333;border-radius:10px;min-width:120px;box-shadow:0 12px 30px rgba(0,0,0,.5);animation:pm-pop .14s cubic-bezier(.2,.8,.2,1)}
.pm-dd-menu li{padding:6px 10px;font-size:13px;color:#cfcfcf;cursor:pointer;border-radius:6px}
.pm-dd-menu li:hover{background:#2a2a2a}
.pm-dd-menu li.on{color:#fff;background:#3a3a3a}
`;

		const labels = { project: "项目", reference: "参考", feedback: "反馈", user: "用户", skill: "技能", knowledge: "知识" };

		// 相对时间：避免长文本标签撑大卡片
		function relTime(iso) {
			try {
				const t = new Date(iso).getTime();
				if (isNaN(t)) return "";
				const diff = Date.now() - t;
				if (diff < 60000) return "刚刚";
				if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
				if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
				if (diff < 7 * 86400000) return Math.floor(diff / 86400000) + " 天前";
				return new Date(t).toLocaleDateString();
			} catch (e) { return ""; }
		}

		// 正文自动整理：分段 + 自动编号。返回整理后的段落数组。
		// 分段点：双换行 / 数字编号行（1、/1.）/ 列表行（- • *）。列表子项保持原样不编号。
		function organizeBody(body) {
			if (!body) return [];
			const raw = String(body).trim();
			if (!raw) return [];
			const hasNumbering = /(^|\n)\s*\d+[\.\、\)]/.test(raw);
			const isList = (s) => /^\s*[-•*]\s/.test(s);
			const isNum = (s) => /^\s*\d+[\.\、\)]/.test(s);
			let segs = raw.split(hasNumbering
				? /\n\s*\n|\n(?=\s*\d+[\.\、\)])|\n(?=\s*[-•*]\s)/
				: /\n\s*\n|\n(?=\s*[-•*]\s)/);
			// 无编号且无双换行/列表符时，退化为按单换行拆，保证多行纯文字也能分段
			if (!hasNumbering && segs.length <= 1) segs = raw.split('\n');
			segs = segs.map((s) => s.replace(/^(\s*\d+[\.\、\)])\s*\1\s*/g, '$1').trim()).filter(Boolean);
			if (segs.length === 0) return [raw];
			if (!hasNumbering) {
				// 无编号：只给非列表的纯文字段自动编号
				const plain = segs.filter((s) => !isList(s) && !isNum(s));
				if (plain.length > 1) {
					let n = 1;
					segs = segs.map((s) => isList(s) || isNum(s) ? s : (n++ + '、' + s));
				}
			} else {
				// 已编号：若数字主段编号重复，按连续序重排（列表子项不动）
				const numSegs = segs.filter(isNum);
				const nums = numSegs.map((s) => parseInt(s.match(/^(\s*\d+)/)[1], 10));
				const uniq = new Set(nums);
				if (uniq.size < nums.length) {
					let n = 1;
					segs = segs.map((s) => {
						if (!isNum(s)) return s;
						const sepMatch = s.match(/^\s*\d+[\.\、\)]/);
						const sep = sepMatch ? sepMatch[0].slice(-1) : '、';
						return (n++) + sep + s.replace(/^\s*\d+[\.\、\)]\s*/, '').trim();
					});
				}
			}
			return segs;
		}
		// 整理后的连续文本（段间空行），用于保存
		function organizedText(body) { return organizeBody(body).join('\n\n'); }

		// 排序规则（default=手动，不重排）。列表渲染与「保存排序」共用同一套比较器，避免两处规则漂移。
		function sortList(list, mode) {
			if (mode === "newest") return [...list].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
			if (mode === "important") return [...list].sort((a, b) => (b.heat || 0) - (a.heat || 0) || (b.proofCount || 0) - (a.proofCount || 0));
			if (mode === "inject") return [...list].sort((a, b) => (b.sources ? b.sources.length : 0) - (a.sources ? a.sources.length : 0));
			return list;
		}
		const SORT_LABEL = { newest: "从新到旧", important: "重要等级高→低", inject: "自动注入次数多→少" };

		function MemorySection() {
			const [cwd, setCwd] = useState("D:/DeepSeek");
			const [memories, setMemories] = useState([]);
			const [filter, setFilter] = useState("all");
			const [sort, setSort] = useState("default"); // 排序：default(手动)/newest(从新到旧)/important(重要等级)/inject(自动注入次数)
			const [undoOrder, setUndoOrder] = useState(null); // 「保存排序」后 10 秒内可撤销：暂存保存前的顺序（仅内存，不写盘）
			const [collapsedType, setCollapsedType] = useState(() => new Set(["project", "reference", "feedback", "user", "skill", "knowledge"])); // 按类型折叠的 Set（默认全收起）
			const [q, setQ] = useState("");
			const [msg, setMsg] = useState("");
			const [expandedId, setExpandedId] = useState(null);
			const [editingId, setEditingId] = useState(null);
			const [draft, setDraft] = useState(null);
			const [pendingDeleteId, setPendingDeleteId] = useState(null);

			// 拖拽状态
			const [drag, setDrag] = useState(null); // { id }
			// D 分组折叠（GLM 按页签分流）：只在"全部"页签生效；collapsed=已折叠的状态集合（默认全部收起）
			const [collapsed, setCollapsed] = useState(() => new Set(["active", "candidate", "archived"]));
			const dragRef = useRef(null); // { id, offsetX, offsetY, insertIndex, ph }
			const listRef = useRef(null);
			const itemRefs = useRef({});

			const fdataRef = useRef({ filtered: [], memories: [] });
			const fileRef = useRef(null);

			const load = useCallback((c) => {
				fetchJson("/list", { method: "POST", body: JSON.stringify({ action: "list", cwd: c }) })
					.then((r) => { setMemories(r.ok ? (r.memories || []) : []); setMsg(r.ok ? "" : "加载失败: " + (r.error || "?")); })
					.catch((err) => setMsg("加载失败: " + err));
			}, []);
			useEffect(() => { load(cwd); }, [cwd, load]);

			const persist = (next) => fetchJson("/save", { method: "POST", body: JSON.stringify({ action: "save", cwd, memories: next }) })
				.then((r) => { if (!r.ok) setMsg("保存失败: " + (r.error || "?")); return r; });

			// 「保存排序」：把当前排序规则固化成"默认（手动）顺序"，之后仍可拖动手柄微调。
			// 走与拖动排序完全相同的写盘路径（persist → /save），并同样先过 checkSanity 体检；只改数组顺序，不动任何记忆内容。
			const saveSortedOrder = () => {
				if (sort === "default") return;
				const label = SORT_LABEL[sort] || sort;
				const next = sortList(memories, sort);
				const ids = new Set(memories.map((m) => m.id));
				const bad = checkSanity(next, memories, ids);
				if (bad) { setMsg("保存排序未执行：" + bad); return; }
				const prev = memories;
				setMemories(next);
				setUndoOrder(prev);
				setSort("default");
				setMsg("已按「" + label + "」保存为默认顺序（共 " + next.length + " 条）· 10 秒内可撤销");
				persist(next).then((r) => { if (r && r.ok) setMsg("已按「" + label + "」保存为默认顺序（共 " + next.length + " 条）· 10 秒内可撤销"); });
			};
			// 撤销「保存排序」：把保存前的顺序写回去（同一路径 + 同一体检）
			const undoSortedOrder = () => {
				if (!undoOrder) return;
				const back = undoOrder;
				const ids = new Set(back.map((m) => m.id));
				const bad = checkSanity(back, memories, ids);
				setUndoOrder(null);
				if (bad) { setMsg("撤销未执行：" + bad); return; }
				setMemories(back);
				persist(back).then((r) => { if (r && r.ok) setMsg("已撤销，顺序恢复为保存前"); });
			};
			// 撤销窗口 10 秒后自动关闭（只清内存标记，不写盘）
			useEffect(() => {
				if (!undoOrder) return undefined;
				const t = setTimeout(() => setUndoOrder(null), 10000);
				return () => clearTimeout(t);
			}, [undoOrder]);

			const exportJson = () => {
				const data = JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), memories }, null, 2);
				try {
					const blob = new Blob([data], { type: "application/json" });
					const url = URL.createObjectURL(blob);
					const a = document.createElement("a");
					a.href = url; a.download = "dsh-memory-" + new Date().toISOString().slice(0, 10) + ".json";
					document.body.appendChild(a); a.click(); document.body.removeChild(a);
					URL.revokeObjectURL(url);
					setMsg("已导出 " + memories.length + " 条记忆");
				} catch (e) { setMsg("导出失败: " + e); }
			};
			const onImportFile = (e) => {
				const file = e.target.files && e.target.files[0];
				if (!file) return;
				const reader = new FileReader();
				reader.onload = () => {
					try {
						const parsed = JSON.parse(String(reader.result));
						const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.memories) ? parsed.memories : []);
						if (!list.length) { setMsg("导入失败: 未找到记忆数据"); return; }
						const now = new Date().toISOString();
						const imported = list.map((m) => ({
							id: (m && typeof m.id === 'string') ? m.id : "mem-" + Math.random().toString(36).slice(2, 10),
							title: (m && m.title) || "未命名",
							description: (m && m.description) || (m && m.title) || "未命名",
							type: (m && m.type && labels[m.type]) ? m.type : "project",
							body: organizedText((m && m.body) || ""),
							source: (m && m.source) || "import",
							tags: Array.isArray(m && m.tags) ? m.tags : [],
							scope: "project",
							status: (m && m.status) || "active",
							heat: typeof (m && m.heat) === 'number' ? m.heat : 0,
							createdAt: (m && m.createdAt) || now,
							updatedAt: (m && m.updatedAt) || now,
						}));
						const next = imported.concat(memories);
						persist(next).then((r) => { setMemories(next); setMsg("已导入 " + imported.length + " 条记忆"); });
					} catch (err) { setMsg("导入失败: " + err); }
				};
				reader.readAsText(file);
				e.target.value = "";
			};

			const filtered = useMemo(() => {
				const base = memories.filter((m) => {
					// 状态筛选：已归档筛选只含 archived；其余（全部/活跃/待审/类型）不含 archived
					const st = m.status || "active";
					if (filter === "archived") { if (st !== "archived") return false; }
					else if (st === "archived") return false;
					if (filter !== "all" && filter !== "archived" && st !== filter) return false;
					if (q && !(m.title + " " + (m.description || "") + " " + (m.body || "")).toLowerCase().includes(q.toLowerCase())) return false;
					return true;
				});
				// 排序（default=手动不重排；其余按 sortList 规则——与「保存排序」共用同一套比较器，避免漂移）
				return sortList(base, sort);
			}, [memories, filter, q, sort]);
			fdataRef.current.filtered = filtered;
			fdataRef.current.memories = memories;

			const knownId = (id) => filtered.some((m) => m.id === id);
			const visibleExpanded = expandedId && knownId(expandedId) ? expandedId : null;
			const visibleEditing = editingId && editingId !== "__new__" && knownId(editingId) ? editingId : null;

			const measureGap = () => {
				const list = listRef.current;
				if (!list) return 10;
				return parseFloat(getComputedStyle(list).rowGap || getComputedStyle(list).gap || 10) || 10;
			};

			// 拖拽期间的显示顺序 + 让位（逐格：每项最多 ±1 格）
			const dragView = useMemo(() => {
				const run = dragRef.current;
				if (!run) return null;
				const members = filtered.filter((m) => (m.type || "project") === run.tp);
				const ids = members.map((m) => m.id);
				const di = ids.indexOf(run.id);
				if (di === -1) return null;
				const rest = ids.filter((x) => x !== run.id);
				rest.splice(run.insertIndex, 0, run.id);
				const shift = {};
				for (let i = 0; i < ids.length; i++) {
					const id = ids[i];
					if (id === run.id) continue;
					shift[id] = rest.indexOf(id) - i;
				}
				return { order: rest, shift };
			}, [filtered, drag]);

			const shoePx = (id, grid) => {
				const st = dragRef.current;
				const h = st && st.heights && st.heights[id] != null
					? st.heights[id]
					: (itemRefs.current[id] ? itemRefs.current[id].getBoundingClientRect().height : 0);
				const gap = st && st.gap != null ? st.gap : measureGap();
				return grid * (h + gap);
			};

			const beginDrag = (e, id, tp) => {
				if (e.button !== 0) return;
				e.preventDefault();
				const item = itemRefs.current[id];
				if (!item) return;

				setExpandedId(null);
				setEditingId(null);
				setDraft(null);

				// 块容器 = 被拖卡所在的 .pm-group-inner（几何基准，免 ref 布线）
				const blockEl = item.closest(".pm-group-inner");
				if (!blockEl) return;
				const members = filtered.filter((m) => (m.type || "project") === tp);
				const n = members.length;
				const di = Math.max(members.findIndex((m) => m.id === id), 0);
				// 真正滚动容器：从 .pm-list 向上找第一个可滚（scrollHeight>clientHeight）的祖先（整页一起滚，无内部独立滚动区）。
				const list = (function () { let e = listRef.current; while (e) { if (e.scrollHeight > e.clientHeight) return e; e = e.parentElement; } return listRef.current; })();

				const rect = item.getBoundingClientRect();
				const br = blockEl.getBoundingClientRect();
				const gap = measureGap();

				// 块内卡片缓存（heights 给 shoePx；GBCR 全场仅此一轮）
				const heights = {}; const offsets = {}; let items = [];
				items = Array.prototype.slice.call(blockEl.querySelectorAll(".pm-item"))
					.filter((el) => !el.classList.contains("pm-ghost"));
				items.forEach((el) => { const d = el.dataset.id; heights[d] = el.getBoundingClientRect().height; offsets[d] = el.offsetTop; });

				const listTop = list ? list.getBoundingClientRect().top : 0;
				const listHeight = list ? list.getBoundingClientRect().height : 0;

				dragRef.current = {
					id, tp,
					offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top,
					insertIndex: di, di, n,
					width: rect.width, height: rect.height,
					gap, slotH: rect.height + gap,
					blockEl, blockTop: br.top,
					listTop, listHeight, list, // 存 list 引用，供 onWheel 滚列表 + scrollCur 同步
					scrollTop0: list ? list.scrollTop : 0, scrollCur: list ? list.scrollTop : 0,
					heights, offsets, items,
					raf: null, lx: e.clientX, ly: e.clientY, item,
				};
				setDrag({ id, tp, x: rect.left, y: rect.top });
				document.body.style.userSelect = "none";

				// 插入点重算（块内缝隙 g ∈ [0, n]；计入拖拽期滚动量；跨块自动吸顶/底缝）
				const recalcInsert = () => {
					const st = dragRef.current; if (!st) return;
					const centerY = st.ly - st.offsetY + st.height / 2;
					const rel = centerY - st.blockTop + (st.scrollCur - st.scrollTop0);
					let g = Math.round((rel - st.height / 2) / st.slotH);
					g = Math.max(0, Math.min(st.n, g));
					if (g !== st.insertIndex) { st.insertIndex = g; setDrag((d) => (d ? { ...d } : d)); }
				};

				const processMove = () => {
					const st = dragRef.current;
					if (!st) return;
					st.raf = null;
					if (st.item) {
						st.item.style.left = (st.lx - st.offsetX) + "px";
						st.item.style.top = (st.ly - st.offsetY) + "px";
					}
					const margin = 44;
					if (st.ly < st.listTop + margin) {
						st.list.scrollTop -= 8; st.scrollCur = st.list.scrollTop; recalcInsert();
					} else if (st.ly > st.listTop + st.listHeight - margin) {
						st.list.scrollTop += 8; st.scrollCur = st.list.scrollTop; recalcInsert();
					} else {
						recalcInsert();
					}
				};
				const move = (ev) => {
					const st = dragRef.current; if (!st) return;
					st.lx = ev.clientX; st.ly = ev.clientY;
					if (st.raf == null) st.raf = requestAnimationFrame(processMove);
				};

				// 拖拽时滚轮：滚动列表 + scrollCur 同步 + 插入点实时重算（让位/占位符经既有 React 路径跟随）
				const onWheel = (ev) => {
					const st = dragRef.current; if (!st) return;
					ev.preventDefault();
					if (!st.list) return;
					st.list.scrollTop += ev.deltaY;
					st.scrollCur = st.list.scrollTop;
					recalcInsert();
				};
				if (list) document.addEventListener("wheel", onWheel, { passive: false });

				// ===== 数据安全：写回前五项 sanity check（事故防线，任一不过整体放弃） =====
				const checkSanity = (next, mem, idSet) => {
					if (next.length !== mem.length) return "count changed";
					for (const m of next) {
						if (!m || typeof m !== "object") return "non-object entry";
						if (typeof m.id !== "string" || typeof m.title !== "string" || typeof m.body !== "string") return "malformed record";
					}
					const idsA = mem.map((m) => m.id).sort().join("|");
					const idsB = next.map((m) => m.id).sort().join("|");
					if (idsA !== idsB) return "id set changed";
					for (let i = 0; i < next.length; i++) {
						const a = mem.find((x) => x.id === next[i].id);
						if (a && a.type !== next[i].type) return "type changed: " + next[i].id;
					}
					const othersA = mem.filter((m) => !idSet.has(m.id)).map((m) => m.id).join("|");
					const othersB = next.filter((m) => !idSet.has(m.id)).map((m) => m.id).join("|");
					if (othersA !== othersB) return "cross-block order changed";
					return "";
				};

				const finish = (commit) => {
					document.removeEventListener("pointermove", move);
					document.removeEventListener("pointerup", up);
					document.removeEventListener("pointercancel", up);
					if (list) document.removeEventListener("wheel", onWheel);
					document.body.style.userSelect = "";

					const st = dragRef.current;
					if (!st) { setDrag(null); return; }
					if (st.raf != null) { cancelAnimationFrame(st.raf); st.raf = null; }
					// 清 ghost 定位 + 块内所有卡片的让位 transform，避免松手后卡片残留在 fixed 位置而"消失"。
					if (st.item) { st.item.style.left = ""; st.item.style.top = ""; }
					if (st.items) for (const el of st.items) { if (el) el.style.transform = ""; }
					setDrag(null);

					if (commit) {
						const { filtered: f, memories: mem } = fdataRef.current;
						const blockIds = f.filter((m) => (m.type || "project") === st.tp).map((m) => m.id);
						const idSet = new Set(blockIds);
						const from = blockIds.indexOf(st.id);
						if (from !== -1) {
							const rest = blockIds.filter((x) => x !== st.id);
							rest.splice(st.insertIndex, 0, st.id);
							// id → 对象映射（事故修复：绝不 q.shift() 出字符串）
							const byId = new Map();
							f.forEach((m) => byId.set(m.id, m));
							const newOrderObjs = rest.map((rid) => byId.get(rid)).filter(Boolean);
							const next = mem.map((m) => (idSet.has(m.id) ? newOrderObjs.shift() : m));
							const bad = checkSanity(next, mem, idSet);
							if (bad) {
								console.log("[project-memory] drag commit ABORTED: " + bad);
							} else if (JSON.stringify(next.map((m) => m.id)) !== JSON.stringify(mem.map((m) => m.id))) {
								setMemories(next);
								persist(next);
							}
						}
					}
					dragRef.current = null;
				};
				const up = () => finish(true);
				document.addEventListener("pointermove", move);
				document.addEventListener("pointerup", up);
				document.addEventListener("pointercancel", up);
			};

			// 展开 / 编辑区块
			const renderExt = (m) => {
				if (visibleExpanded === m.id) {
					const paras = organizeBody(m.body);
					const meta = "更新于 " + new Date(m.updatedAt || Date.now()).toLocaleString() + (m.description ? " · " + m.description : "");
					return {
						li: h("li", { className: "pm-ext", key: "ext-" + m.id },
							h("p", { className: "pm-ext-meta" }, meta),
							h("div", { className: "pm-ext-scroll" },
								h("div", { className: "pm-ext-body" }, paras.map((p, i) => h("p", { key: i }, p))))),
						kind: "expand",
					};
				}
				if (visibleEditing === m.id) {
					const d = draft && draft.id === m.id ? draft : { id: m.id, title: m.title, description: m.description || "", body: organizedText(m.body), type: m.type || "project", status: m.status || "active", ttl: m.ttl || "event", obligation: m.obligation === true, pinned: m.pinned === true };
					return {
						li: h("li", { className: "pm-ext", key: "edit-" + m.id },
							h("div", { className: "pm-edit" },
								h("h4", null, "编辑记忆"),
								h("input", { className: "pm-input", value: d.title, placeholder: "标题*", onChange: (e) => setDraft({ ...d, title: e.target.value }) }),
								h("input", { className: "pm-input", value: d.description, placeholder: "描述（可选）", onChange: (e) => setDraft({ ...d, description: e.target.value }) }),
								h("textarea", { value: d.body, placeholder: "正文*", onChange: (e) => setDraft({ ...d, body: e.target.value }) }),
								h("div", { className: "row" },
									h("button", { className: "pm-save", onClick: () => {
										if (!d.title || !d.body) { setMsg("标题和正文必填"); return; }
										const now = new Date().toISOString();
										const next = memories.map((x) => x.id === m.id ? { ...x, title: d.title, description: d.description || d.title, body: organizedText(d.body), type: d.type, status: d.status, ttl: d.ttl || x.ttl || "event", obligation: d.obligation === true, pinned: d.pinned === true, updatedAt: now } : x);
										persist(next).then(() => { setMemories(next); setEditingId(null); setDraft(null); setMsg("已保存"); });
									} }, "保存修改"),
									h("button", { className: "pm-btn", onClick: () => { setEditingId(null); setDraft(null); } }, "取消")))),
						kind: "edit",
					};
				}
				return null;
			};

			const row = (m, tp) => {
				const isGhost = drag && drag.id === m.id;
				const isSelected = visibleExpanded === m.id || visibleEditing === m.id;
				const dv = dragView;
				let shiftPxVal = 0;
				if (!isGhost && dv && dv.shift[m.id]) {
					shiftPxVal = shoePx(m.id, dv.shift[m.id]);
				}
				const toggleExpand = () => {
					if (editingId === m.id) { setEditingId(null); setDraft(null); }
					setExpandedId((cur) => (cur === m.id ? null : m.id));
				};
				return h("li", {
					key: m.id, "data-id": m.id,
					ref: (el) => { if (el) itemRefs.current[m.id] = el; },
					className: "pm-item" + (isGhost ? " pm-ghost" : "") + (isGhost ? "" : (dv && dv.shift[m.id] ? " pm-yield" : "")) + (isSelected ? " pm-selected" : ""),
					style: isGhost
						? { width: (dragRef.current && dragRef.current.width) + "px", height: (dragRef.current && dragRef.current.height) + "px", "--pm-x": (drag && drag.x) + "px", "--pm-y": (drag && drag.y) + "px" }
						: (dv && dv.shift[m.id] ? { "--pm-shift": shiftPxVal + "px" } : undefined),
					onClick: toggleExpand, // 整卡点击展开正文（编辑/删除按钮 stopPropagation）
				},
					// 上段：点 + 标题 + 简介（占满宽，不压缩）
					h("div", { className: "pm-head" },
						h("span", { className: "pm-dot" }),
						h("div", { className: "pm-body" },
							h("div", { className: "pm-t" }, m.title),
							h("div", { className: "pm-d" }, "更新于 " + new Date(m.updatedAt || Date.now()).toLocaleString() + " · " + (m.description || "")))),
					// 下段：标签竖向（堆叠）+ 按钮 + 拖拽柄，不挤标题
					h("div", { className: "pm-foot" },
						h("div", { className: "pm-tags" },
							h("span", { className: "pm-badge" }, labels[m.type] || m.type || "项目"),
							(m.heat > 0) ? h("span", { className: "pm-heat" }, h("svg", { width: "12", height: "12", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", style: { verticalAlign: "-1px", marginRight: "3px" } }, h("path", { d: "M12 21c4.4 0 8-3.1 8-7 0-2.8-1.4-4.7-2.9-6.2C15.5 6.2 14 4 13.5 2c-2.5 1.5-3.5 4.5-3.5 6.5 0 1-.2 2-1 3C8 10 7 9 7 7c0 0-3 2-3 6 0 4 3.6 8 8 8z" })), m.heat) : null,
							m.lastRecalledAt ? h("span", { className: "pm-last" }, "召回 " + relTime(m.lastRecalledAt)) : null),
						h("div", { className: "pm-actions" },
							h("button", { className: "pm-btn", onClick: (e) => { e.stopPropagation(); setExpandedId(null); setDraft({ id: m.id, title: m.title, description: m.description || "", body: organizedText(m.body), type: m.type || "project", status: m.status || "active" }); setEditingId(m.id); } }, "编辑记忆"),
							h("button", { className: "pm-btn danger", onClick: (e) => { e.stopPropagation(); setPendingDeleteId(m.id); } }, "删除"),
							(filter !== "archived" && sort === "default") ? h("span", { className: "pm-grip", onPointerDown: (e) => beginDrag(e, m.id, tp) }, "⋮⋮") : null)));
			};

			// 组装列表：DOM 顺序保持 filtered 不变（引用稳定），拖拽让位 / 占位符用 translateY 位移模拟，
			// 松手后再把新顺序写回并持久化。占位符跟随即目标位置（--pm-ph-shift）。
			const cells = [];
			const statusLabel = { all: "全部", active: "活跃", candidate: "待审", archived: "已归档" };
			// GLM 裁定「按页签分流」：分组折叠只在"全部"页签(filter==='all')做（无拖拽，卡片自由包容器）；
			// 卡片区：按类型分块（Q 方案，删"全部"）。每个类型一块，块头(类型名+数量+折叠)+块内该类型卡片。
			Object.keys(labels).forEach((tp) => {
				const members = filtered.filter((m) => (m.type || "project") === tp);
				if (!members.length) return;
				const isCollapsed = collapsedType.has(tp);
				cells.push(h("li", { key: "tp-" + tp, className: "pm-group" + (isCollapsed ? " pm-group-collapsed" : ""), onPointerDown: (e) => { e.stopPropagation(); setCollapsedType((s) => { const n = new Set(s); if (n.has(tp)) n.delete(tp); else n.add(tp); return n; }); } },
					h("span", { className: "pm-group-t" }, labels[tp], h("b", { className: "pm-group-n" }, members.length)),
					h("span", { className: "pm-group-c" }, isCollapsed ? "▸" : "▾")));
				cells.push(h("li", { key: "tp-items-" + tp, className: "pm-group-items" + (isCollapsed ? " pm-group-hide" : "") },
					h("div", { className: "pm-group-inner" }, (() => {
						const blockCells = [];
						members.forEach((m) => {
							const isDragTarget = drag && drag.tp === tp && drag.id === m.id;
							if (isDragTarget) {
								const gh = itemRefs.current[m.id];
								const phH = gh ? gh.getBoundingClientRect().height : (dragRef.current ? dragRef.current.height : 144);
								const di = members.findIndex((x) => x.id === m.id);
								const toIndex = dragRef.current ? dragRef.current.insertIndex : di;
								const single = (dragRef.current ? dragRef.current.height : phH) + measureGap();
								const phShift = Math.max(-di * single, Math.min((members.length - 1 - di) * single, (toIndex - di) * single)); // clamp 吸在组边界（底/顶不超出）
								const phStyle = { height: phH + "px" };
								if (phShift) { phStyle["--pm-ph-shift"] = phShift + "px"; blockCells.push(h("li", { key: m.id + "-ph", className: "pm-placeholder pm-ph-move", style: phStyle })); }
								else { blockCells.push(h("li", { key: m.id + "-ph", className: "pm-placeholder", style: phStyle })); }
							}
							blockCells.push(row(m, tp));
							if (!isDragTarget) {
								const ext = renderExt(m);
								if (ext) blockCells.push(ext.li);
							}
						});
						return blockCells;
					})())));
			});

			// 新增记忆区块
			const isAdding = editingId === "__new__";
			const addBlock = isAdding && draft ? h("li", { className: "pm-ext", key: "new-mem" },
				h("div", { className: "pm-edit" },
					h("h4", null, "新增记忆"),
					h("input", { className: "pm-input", value: draft.title, placeholder: "标题（可空，自动取首行）", onChange: (e) => setDraft({ ...draft, title: e.target.value }) }),
					h("textarea", { value: draft.body, placeholder: "正文*", onChange: (e) => setDraft({ ...draft, body: e.target.value }) }),
					h("div", { className: "pm-cat-row" },
						h("span", null, "系统识别："),
						h("select", { className: "pm-select", value: draft.type || "project", onChange: (e) => setDraft({ ...draft, type: e.target.value }) },
							h("option", { value: "project" }, "项目（这个项目的决定/进展）"),
							h("option", { value: "reference" }, "参考（文档/规范）"),
							h("option", { value: "feedback" }, "反馈（踩坑/心得）"),
							h("option", { value: "user" }, "用户（您的偏好习惯）"),
							h("option", { value: "skill" }, "技能（操作方法）"),
							h("option", { value: "knowledge" }, "知识（通用概念）")),
						h("select", { className: "pm-select", value: draft.ttl || "event", onChange: (e) => setDraft({ ...draft, ttl: e.target.value }) },
							h("option", { value: "event" }, "特定情况才想起"),
							h("option", { value: "permanent" }, "长期有效"),
							h("option", { value: "phase" }, "跟某个阶段有关")),
						h("span", { className: "pm-cat-hint" }, "分类只影响它出现在哪、何时被想起——拿不准就保持默认。")),
					h("div", { className: "row" },
						h("button", { className: "pm-save", onClick: () => {
							if (!draft.body) { setMsg("正文必填"); return; }
							const now = new Date().toISOString();
							const firstLine = (draft.body || "").split("\n").map((s) => s.trim()).filter(Boolean)[0] || "未命名";
							const nm = { id: "mem-" + Date.now().toString(36), title: (draft.title || "").trim() || firstLine, description: draft.description || (draft.title || "").trim() || firstLine, type: draft.type || "project", body: organizedText(draft.body), scope: "project", status: draft.status || "active", ttl: draft.ttl || "event", obligation: draft.obligation === true, pinned: draft.pinned === true, heat: 0, source: "manual", tags: [], createdAt: now, updatedAt: now };
							const next = [nm, ...memories];
							persist(next).then(() => { setMemories(next); setEditingId(null); setDraft(null); setMsg("已新增"); });
						} }, "新增"),
						h("button", { className: "pm-btn", onClick: () => { setEditingId(null); setDraft(null); } }, "取消")))) : null;

			const listChildren = (isAdding ? [addBlock] : []).concat(cells.length ? cells : [h("li", { className: "pm-empty" }, "暂无记忆——可新增，或让 AI 用 memory_write/imagine 记录")]);

			return h("div", { className: "pm" },
				h("style", null, CSS),
				h("div", { className: "pm-top" },
					h("div", null,
						h("h2", { className: "pm-title" }, "北极星 · 项目记忆"),
						h("p", { className: "pm-sub" }, "按项目独立存放 · 点击卡片展开正文 · 拖动手柄可排序")),
					h("button", { className: "pm-sub-btn", onClick: exportJson }, "导出"),
					h("button", { className: "pm-sub-btn", onClick: () => { if (fileRef.current) fileRef.current.click(); } }, "导入"),
					h("input", { ref: fileRef, type: "file", accept: ".json,application/json", style: { display: "none" }, onChange: onImportFile }),
					h("button", { className: "pm-add", onClick: () => { setExpandedId(null); setEditingId("__new__"); setDraft({ title: "", description: "", body: "", type: "project", status: "active" }); } }, "新增记忆")),
				h("div", { className: "pm-stats" },
					h("span", { className: "pm-stat" }, "记忆", h("b", null, memories.length)),
					(function () {
						const recent = [...memories].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
						return recent ? h("span", { className: "pm-stat" }, "最近: ", h("span", { className: "pm-recent" }, recent.title)) : null;
					})()),
				h("div", { className: "pm-field" },
					h("span", { className: "pm-label" }, "项目目录"),
					h("input", { className: "pm-input", value: cwd, placeholder: "d:/deepseek", onChange: (e) => setCwd(e.target.value) }),
					h("button", { className: "pm-save", onClick: () => load(cwd) }, "保存")),
				h("div", { className: "pm-bar" },
					["all", "active", "candidate", "archived"].map((k) => h("button", { key: k, className: "pm-tab" + (filter === k ? " on" : ""), onClick: () => setFilter(k) }, k === "all" ? "全部" : ({ active: "活跃", candidate: "待审", archived: "已归档" }[k] || k))),
					h("input", { className: "pm-search", value: q, placeholder: "搜索标题、描述或正文…", onChange: (e) => setQ(e.target.value) }),
					(filter !== "archived") ? h("span", { style: { marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: "8px" } },
						h("select", { className: "pm-select", value: sort, onChange: (e) => setSort(e.target.value) },
							h("option", { value: "default" }, "排序：默认"),
							h("option", { value: "newest" }, "从新到旧"),
							h("option", { value: "important" }, "重要等级高→低"),
							h("option", { value: "inject" }, "自动注入次数多→少")),
						// 保存排序：仅在自动排序（非默认/手动）时出现；点了就把当前规则固化成默认（手动）顺序
						(sort !== "default") ? h("button", { className: "pm-btn", onClick: saveSortedOrder, title: "把当前排序固化为默认（手动）顺序，之后仍可拖动微调" }, "保存排序") : null) : null),
				h("ul", { className: "pm-list", ref: listRef }, listChildren),
				msg ? h("div", { className: "pm-msg" }, msg, undoOrder ? h("button", { className: "pm-btn", style: { marginLeft: "8px" }, onClick: undoSortedOrder, title: "恢复保存排序之前的顺序" }, "撤销") : null) : null,
				pendingDeleteId ? (function () {
					const target = memories.find((x) => x.id === pendingDeleteId);
					const title = target ? target.title : "";
					const confirmDelete = () => {
						const next = memories.filter((x) => x.id !== pendingDeleteId);
						persist(next).then(() => { setMemories(next); setPendingDeleteId(null); setMsg("已删除"); });
					};
					return h("div", { className: "pm-confirm-overlay", onClick: (e) => { if (e.target === e.currentTarget) setPendingDeleteId(null); } },
						h("div", { className: "pm-confirm" },
							h("h4", null, "确认删除"),
							h("p", null, "确定要删除这条项目记忆吗？"),
							h("p", { className: "pm-cmsg" }, "「" + title + "」此操作不可撤销。"),
							h("div", { className: "pm-crow" },
								h("button", { className: "pm-cbtn danger", onClick: confirmDelete }, "确认删除"),
								h("button", { className: "pm-cbtn", onClick: () => setPendingDeleteId(null) }, "取消"))));
				})() : null
			);
		}

		function apply(ctx) {
			ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "project-memory",
				order: 20,
				label: () => "北极星 · 项目记忆",
			}, MemorySection)), "project-memory: settings page");
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
