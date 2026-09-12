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
.pm{font-family:-apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;color:#e6e6e6;font-size:13px;line-height:1.6;padding:18px 22px;max-width:860px;overflow-x:hidden;overflow-y:visible;box-sizing:border-box;scrollbar-gutter:stable}
.pm::-webkit-scrollbar{width:5px}
.pm::-webkit-scrollbar-track{background:transparent}
.pm::-webkit-scrollbar-thumb{background:#3a3a3a;border-radius:5px}
.pm::-webkit-scrollbar-thumb:hover{background:#4a4a4a}
.pm-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:8px}
.pm-title{font-size:16px;font-weight:700;color:#f0f0f0;margin:0 0 4px}
.pm-sub{color:#9a9a9a;font-size:12px;margin:0}
.pm-stat{height:36px;box-sizing:border-box;display:inline-flex;align-items:center;flex:0 0 auto;background:#1d1d1d;border:1px solid #2c2c2c;border-radius:999px;padding:0 12px;font-size:12px;color:#b5b5b5;white-space:nowrap;transform:translateX(0);transition:transform .22s ease-out}
/* 目录行里的胶囊：**紧跟🔍/搜索框**（不再用 margin-left:auto 吸走空白飞到最后）。
   用户要求：收起时胶囊紧贴🔍；展开时被搜索框向右推开 130px（让位），但**始终留在可视区内**。
   行尾多余空间**留白**（不分配给任何控件）→ 胶囊永远不会被挤出屏幕。 */
.pm-toolbar .pm-stat{margin-left:0}
/* ⚠️ 展开搜索时**输入框宽度必须保持不变**（170px）。
   曾经写成缩到 130px「让位」——但输入框在🔍**左边**，缩窄会把它右边的
   保存/🔍 一起向左拽（静态算过：🔍 的 x 从 340 → 300，正好位移 40px），
   与用户硬约束「点搜索按钮，按钮自身位置不能移动」直接冲突。
   正确做法：唯一变化的只有🔍右侧的槽（0 → 210），左侧四个控件宽度全固定 →
   🔍 的 x 是常量，搜索框只向右长，胶囊自然让位。 */
.pm-stat b{color:#e6e6e6;font-weight:600;margin-left:3px}
.pm-stat .pm-recent{color:#c9c9c9;font-weight:600}
.pm-add{background:#3a3a3a;color:#f0f0f0;border:none;border-radius:10px;padding:8px 16px;font-size:13px;cursor:pointer}
.pm-add:hover{background:#4a4a4a}
.pm-sub-btn{background:#262626;color:#ccc;border:1px solid #333;border-radius:10px;padding:8px 14px;font-size:13px;cursor:pointer}
.pm-sub-btn:hover{background:#333}
/* —— 目录行（用户定案：**四个控件紧贴、行尾留白归胶囊**）——
   收起： 项目目录 [输入框]  [保存]  [🔍]            (记忆 63)
   展开： 项目目录 [输入框]  [保存]  [🔍][搜索框…]    (记忆 63)
   三条硬约束（用户原话）：
     ① 输入框、保存、🔍、胶囊在收起态**必须紧贴**（不能有空白）→ 输入框**不用 flex:1 抢空间**；
     ② 搜索框**只向🔍的右边**展开（方向向右）；
     ③ 展开过程中**🔍 的 x 坐标保持不变** → 实现方式不是"输入框缩窄让位"
        （输入框在🔍左边，缩它会把🔍一起拖左，实测位移 40px），
        而是**左侧四个控件宽度全部固定、唯一变化的是🔍右侧的槽**。
   行尾空白统一由 margin-left:auto 的胶囊吸收（这样前面四个紧贴左侧）。 */
.pm-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:nowrap;margin-bottom:8px}
/* 输入框外壳：**固定 170px、禁止伸缩**（flex:0 0 auto）。
   关键：绝不能写 flex:1（会吃掉全部剩余空间 → 把保存/🔍推到很右边，中间出现大段空白）。
   行尾多余空间交给最右的胶囊吸收（.pm-toolbar .pm-stat{margin-left:auto}），
   这样「输入框 / 保存 / 🔍」三者自然紧贴左侧、零空白；右侧留白。
   展开搜索时**此宽度不变**：宽度一旦随展开变化，🔍 的 x 就会被拖动，
   违反用户硬约束③「点搜索按钮，按钮自身位置不能移动」。 */
.pm-toolbar .pm-ac-wrap{flex:0 0 auto;width:170px}
.pm-top-actions{display:flex;gap:8px;flex:none;align-items:flex-start}
/* 「最近：xxx」单独一行（筛选胶囊上方）：inline-flex 居中对齐；**不要 display:block**（那会破坏垂直居中） */
.pm-recent-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.pm-stat-recent{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#c9c9c9}
.pm-label{color:#c9c9c9;font-size:13px;white-space:nowrap;flex:0 0 auto}
.pm-input{flex:1 1 auto;width:100%;min-width:0;max-width:100%;height:36px;box-sizing:border-box;background:#1a1a1a;color:#e6e6e6;border:1px solid #333;border-radius:10px;padding:0 12px;font-size:13px;line-height:34px;outline:none}
.pm-input:focus{border-color:#555}
.pm-save{height:36px;box-sizing:border-box;background:#3a3a3a;color:#f0f0f0;border:none;border-radius:10px;padding:0 18px;font-size:13px;cursor:pointer;white-space:nowrap;flex:0 0 auto}
.pm-bar{display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:nowrap}
/* 筛选胶囊：文字**必须单行横排**（用户反馈竖排）——不换行、不压缩 */
.pm-tab{background:#1f1f1f;color:#b5b5b5;border:1px solid #2c2c2c;border-radius:20px;padding:5px 14px;font-size:12px;cursor:pointer;white-space:nowrap;flex:0 0 auto;word-break:keep-all}
/* 搜索：图标按钮常驻；展开时输入框**向右推开**（宽度过渡），右侧「记忆 N」自然让位（零遮挡）。
   ① ⚠️ **收起态必须真的不占宽**：flex:0 0 auto（不可压缩）+ width:0 + overflow:hidden + padding:0。
      早期用 grid 0fr 的写法里，槽内固定宽 170px 的搜索框仍计入**最小内容宽度**，把行内预算吃光，
      结果「保存按钮被挤出可视区」（用户实测；宽度预算诊断确认缺口 170px）。
   ② 展开 130px（过渡 220ms ease-out；微交互 100–200ms、显隐 200–300ms，不用 ease-in）；
   ③ 展开时按钮 = 框内左端图标位（同底色同边框）→ 视觉上仍是一个胶囊。 */
.pm-search{display:inline-flex;align-items:center;flex:0 0 auto;min-width:0}
.pm-search-btn{display:inline-flex;align-items:center;justify-content:center;height:36px;width:40px;flex:0 0 auto;background:#141414;color:#b5b5b5;border:1px solid #141414;border-radius:10px;padding:0;cursor:pointer;font-size:13px;box-sizing:border-box;transition:background .15s ease,color .15s ease,border-radius .22s ease-out}
.pm-search-btn:hover{background:#1f1f1f;color:#e6e6e6}
/* 展开态：按钮右侧圆角归零（与输入框拼成**一个整体**，用户图里就是这个样子） */
.pm-search-btn.on{background:#141414;color:#8f8f8f;border-radius:10px 0 0 10px}
.pm-search-slot{flex:0 0 auto;width:0;overflow:hidden;transition:width .22s ease-out}
.pm-search-slot.open{width:130px}
.pm-search-inner{width:130px;display:flex;align-items:center}
.pm-search-box{display:inline-flex;align-items:center;gap:6px;height:36px;width:130px;background:#141414;border:1px solid #141414;border-left:none;border-radius:0 10px 10px 0;padding:0 10px 0 8px;box-sizing:border-box}
.pm-search-box input{flex:1 1 auto;min-width:0;background:transparent;border:none;color:#e6e6e6;font-size:13px;outline:none;padding:0}
.pm-search-box input::placeholder{color:#7a7a7a}
.pm-badge{flex:0 0 auto;font-size:10px;color:#b5b5b5;background:#262626;border:1px solid #333;border-radius:8px;padding:1px 6px;max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pm-search-clear{flex:0 0 auto;background:transparent;border:none;color:#8f8f8f;cursor:pointer;font-size:13px;line-height:1;padding:0 2px}
.pm-search-clear:hover{color:#e0e0e0}
.pm-sort{flex:0 0 auto;max-width:190px}
.pm-sort:focus{outline:none}
.pm-tab.on{background:#3a3a3a;color:#f0f0f0;border-color:#3a3a3a}
.pm-group{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;background:#1d1d1d;border:1px solid #333;border-radius:12px;cursor:pointer;margin-top:2px;transition:background .2s ease,color .2s ease;position:sticky;top:0;z-index:5;width:100%;box-sizing:border-box}
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
.pm-list{list-style:none;margin:0;padding:0 6px 0 2px;display:flex;flex-direction:column;gap:8px;position:relative;overflow:visible}
.pm-item{display:flex;flex-direction:column;gap:8px;padding:12px 40px 12px 16px;background:#191919;border:1px solid #2c2c2c;border-radius:12px;position:relative;z-index:1;box-sizing:border-box;height:144px;min-height:144px;overflow:hidden;transition:transform .2s cubic-bezier(.2,.8,.2,1),box-shadow .2s ease,border-color .2s ease}
/* 卡片内层结构：**每个选择器只保留一条规则**（原先分散两处、后者覆盖前者 → "改了不生效"）。
   合并要点（来自结构审计）：
   ① .pm-head 的 flex 用完整简写 1 1 auto（原处 flex:1 + 他处 flex:1 1 auto 两套写法并存）；
   ② .pm-foot 去掉 margin-top:6px（与 .pm-item 的 gap:8px 叠加会变成 14px 间距，改 gap 调不动）；
   ③ .pm-t 的 overflow-wrap 去掉（被 white-space:nowrap 架空，是死代码）；
   ④ .pm-d 去掉 white-space:pre-wrap（它会让 -webkit-line-clamp:2 的两行截断失效）。 */
.pm-item .pm-head{flex:1 1 auto;min-height:0;overflow:hidden}
.pm-head{display:flex;align-items:flex-start;gap:10px;min-width:0}
.pm-item .pm-foot{flex:0 0 auto}
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
.pm-t{font-weight:600;color:#eee;font-size:14px;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pm-d{color:#8a8a8a;font-size:12px;margin:2px 0 0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:break-word;word-break:break-word}
.pm-heat{font-size:10px;color:#d8a83a;background:#2a2416;border:1px solid #3a3320;border-radius:8px;padding:0 6px;white-space:nowrap;flex:none;line-height:18px;max-width:48px;overflow:hidden;text-overflow:ellipsis}
.pm-last{font-size:10px;color:#7a9a8a;background:#16241f;border:1px solid #233430;border-radius:8px;padding:0 6px;white-space:nowrap;flex:none;line-height:18px;max-width:64px;overflow:hidden;text-overflow:ellipsis}
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
/* —— 导入确认弹窗（自动判定分类/等级 + 生成标题简介，用户可改后二次确认）—— */
.pm-confirm.pm-import{width:580px;max-width:92vw;max-height:84vh;display:flex;flex-direction:column}
.pm-import-hint{color:#8a8a8a;font-size:12px;margin:0 0 10px;line-height:1.6}
.pm-import-list{list-style:none;margin:0 0 14px;padding:0;overflow:auto;max-height:52vh;display:flex;flex-direction:column;gap:10px}
.pm-import-row{display:flex;gap:10px;border:1px solid #2e2e2e;border-radius:10px;padding:10px;background:#191919}
.pm-import-idx{flex:0 0 auto;width:22px;height:22px;border-radius:50%;background:#2b2b2b;color:#9a9a9a;font-size:12px;display:flex;align-items:center;justify-content:center}
.pm-import-fields{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:6px}
.pm-import-fields .pm-cat-row{margin-top:2px}
.pm-input-sm{font-size:12px;color:#b5b5b5}
/* —— 项目目录 Typeahead（可搜索下拉：输入/回车加载 + 从现有项目里选）——
   ⚠️ 这里**只保留定位**（下拉菜单需要 position:relative 基准）；
   宽度/伸缩/最小宽度一律由工具条规则 .pm-toolbar .pm-ac-wrap 单独决定。
   教训：此处曾写 flex:1，与工具条规则竞争 → 外壳吃掉全部剩余空间，
   表现为「输入框右侧一大段空白、保存/🔍被推远」，排查多轮都没生效（改的是另一条规则）。 */
.pm-ac-wrap{position:relative}
.pm-ac{position:absolute;z-index:30;left:0;right:0;top:calc(100% + 4px);margin:0;padding:4px;list-style:none;background:#1c1c1c;border:1px solid #333;border-radius:10px;box-shadow:0 16px 40px rgba(0,0,0,.5);max-height:264px;overflow:auto}
.pm-ac-item{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:8px;cursor:pointer;font-size:12px}
.pm-ac-item.pm-ac-hi{background:#2a2a2a}
.pm-ac-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#dcdcdc}
.pm-ac-count{flex:0 0 auto;color:#8a8a8a}
.pm-ac-empty{padding:7px 9px;color:#7a7a7a;font-size:12px}

/* ═══ 下拉与表单控件 ═══
   注：原文件末尾曾有一组「补丁组」重复定义 .pm-item/.pm-head/.pm-foot/.pm-t/.pm-d，
   靠"写在后面"压住前面的定义 —— 那正是"改卡片样式不生效"的根源。现已**合并进上方卡片区**，
   每个选择器只保留一条规则；整套已废弃的自定义 dropdown（.pm-dd*）也已删除。 */
.pm-select{background:#262626;color:#f0f0f0;border:1px solid #3a3a3a;border-radius:10px;padding:6px 10px;font-size:13px;outline:none;cursor:pointer}
.pm-select:focus{border-color:#555}
.pm-cat-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;color:#9a9a9a;font-size:12px}
.pm-cat-hint{color:#7a7a7a;font-size:11px}
/* 已废弃：自定义 dropdown（.pm-dd*）全面改用原生 select.pm-select → 8 条规则已删除；.pm-pop 动画也一并移除 */
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

		// ===== 导入自动判定（纯函数：不依赖组件状态，便于单测；将来可整体换成 LLM 判定）=====
		// 用户需求（2026-09-11）：导入的记忆先由插件判断「分类」与「重要等级」、生成标题与简介、正文自动排版，
		// 在导入确认弹窗里预选好；用户可手动改分类/等级，确认后按所选分类置顶放入列表。
		const IMPORT_TYPE_HINTS = [
			["user", /(我喜欢|我习惯|我的偏好|请不要|以后都|prefer)/gi],
			["feedback", /(踩坑|一个坑|教训|复盘|经验|失误|事故|根因)/gi],
			["skill", /(操作步骤|步骤|命令|脚本|流程|怎么用|用法|如何|安装|配置方法)/gi],
			["reference", /(文档|规范|接口|API|参考|链接|手册|https?:\/\/)/gi],
			["knowledge", /(概念|原理|定义|通用|术语)/gi],
		];
		const IMPORT_OBLIGATION_RE = /(必须|禁止|绝不能|不得|每次|一律|以后|总是|永远)/;
		/**
		 * 判断一条待导入记忆的分类/重要等级，并生成标题、简介与排版后的正文。
		 * @param raw - 原始记忆对象（可能来自其它项目/旧版本，字段可能缺失）。
		 * @returns {{type:string, ttl:string, obligation:boolean, pinned:boolean, title:string, description:string, body:string}}
		 */
		function classifyImportMemory(raw) {
			const m = (raw && typeof raw === "object") ? raw : {};
			const rawBody = String(m.body || "");
			const body = organizedText(rawBody);
			// 标题/简介取**原始正文首行**：排版(organizedText)会给段落自动编号（"1、…"），
			// 不能让编号混进标题；同时剥掉原有的 "1、" / "- " / "• " 前缀。
			const firstRaw = rawBody.split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
			const firstLine = firstRaw.replace(/^\s*(?:\d+[、.．)]|[-*•])\s*/, "");
			const title0 = String(m.title || "").trim();
			const desc0 = String(m.description || "").trim();
			const hay = title0 + "\n" + desc0 + "\n" + body;
			// ① 分类：合法的显式 type 优先；否则按关键词命中数打分；都不中 → 项目
			let type = (m.type && labels[m.type]) ? m.type : null;
			if (!type) {
				let best = null;
				let bestHits = 0;
				for (const [t, re] of IMPORT_TYPE_HINTS) {
					const hits = (hay.match(re) || []).length;
					if (hits > bestHits) { best = t; bestHits = hits; }
				}
				type = best || "project";
			}
			// ② 重要等级：义务语义（必须/禁止/每次…）→ 长期有效 + 义务标记；否则沿用原 ttl，默认"特定情况"
			const obligation = IMPORT_OBLIGATION_RE.test(hay) || m.obligation === true;
			const ttl = obligation
				? "permanent"
				: ((m.ttl === "permanent" || m.ttl === "phase" || m.ttl === "event") ? m.ttl : "event");
			// ③ 标题/简介：缺失或占位（"未命名"）时用正文首行生成
			const title = (title0 && title0 !== "未命名") ? title0 : (firstLine.slice(0, 40) || "未命名");
			const description = (desc0 && desc0 !== "未命名" && desc0 !== title) ? desc0 : (firstLine.slice(0, 60) || title);
			return { type, ttl, obligation, pinned: m.pinned === true, title, description, body };
		}

		// 清理"最近使用目录"里的半截路径（老版本"输入即记录"留下的垃圾：D:/D、D:/DS、D:/ ）：
		// ①丢弃空串与盘符根（D:/ 、C:\）②丢弃"是另一条前缀"的项（D:/D、D:/DS 都是 D:/DeepSeek 的前缀）。
		// 纯函数，便于单测；幂等（清过再清不会变）。
		function cleanRecentDirs(list) {
			const arr = (Array.isArray(list) ? list : [])
				.map((x) => String(x || "").trim())
				.filter((x) => x && !/^[a-zA-Z]:[\\/]?$/.test(x));
			const uniq = [...new Set(arr)];
			return uniq.filter((x) => !uniq.some((y) => y !== x && y.toLowerCase().startsWith(x.toLowerCase())));
		}

		// 写回前的五项 sanity check（事故防线，任一不过整体放弃）。
		// 必须放在**模块作用域**：拖动排序与「保存排序」都要用；若放在拖动指针处理函数内部，
		// 保存排序点击时就会 ReferenceError（表现：弹窗不消失、点了没反应）。
		// idSet = 本次被移动/重排的 id 集合；保存排序传全部 id（othersA/othersB 都为空，不触发跨块检查）。
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

		function MemorySection() {
			const [cwd, setCwd] = useState("D:/DeepSeek");
			const [memories, setMemories] = useState([]);
			const [filter, setFilter] = useState("all");
			const [sort, setSort] = useState("default"); // 排序：default(手动)/newest(从新到旧)/important(重要等级)/inject(自动注入次数)
			const [undoOrder, setUndoOrder] = useState(null); // 「保存排序」后 10 秒内可撤销：暂存保存前的顺序（仅内存，不写盘）
			const [sortConfirm, setSortConfirm] = useState(null); // 「保存排序」二次确认弹窗：{ label, count }
			const [sortDone, setSortDone] = useState(null); // 保存成功告知弹窗：{ label, count }（3 秒后自动关闭）
			const [searchOpen, setSearchOpen] = useState(false); // 搜索框默认收起成图标按钮，点开才展开（用户需求）
			const [collapsedType, setCollapsedType] = useState(() => new Set(["project", "reference", "feedback", "user", "skill", "knowledge"])); // 按类型折叠的 Set（默认全收起）
			const [q, setQ] = useState("");
			const [msg, setMsg] = useState("");
			const [expandedId, setExpandedId] = useState(null);
			const [editingId, setEditingId] = useState(null);
			const [draft, setDraft] = useState(null);
			const [pendingDeleteId, setPendingDeleteId] = useState(null);
			// 导入向导：选好文件后先弹确认框（每条预选"插件自动判断的分类/等级"，用户可改）——不确认不写盘
			const [importDraft, setImportDraft] = useState(null);
			// 项目目录 Typeahead（用户需求）：输入回车即加载该目录；下拉列出"现有项目"（宿主 collectProjects + 本地最近使用）
			const [dirOpen, setDirOpen] = useState(false);
			const [dirList, setDirList] = useState([]);
			const [dirHi, setDirHi] = useState(-1); // -1 = 未用方向键选中 → 回车按"输入框里的目录"加载
			// 下拉数据是否已加载过：避免每次聚焦都发一次 /projects 请求（那是"点一下就闪"的成因之一）
			const dirLoadedRef = useRef(false);
			// 记忆搜索框的 DOM 引用 + "是否已聚焦过"标记（唯一聚焦入口是 useEffect）
			const searchInputRef = useRef(null);
			const searchFocusedOnceRef = useRef(false);

			// 拖拽状态
			const [drag, setDrag] = useState(null); // { id }
			// 注：曾有一个 collapsed/setCollapsed 状态（"全部页签下的分组折叠"），全文无任何读写 → 已删除（死状态）。
			const dragRef = useRef(null); // { id, offsetX, offsetY, insertIndex, ph }
			const listRef = useRef(null);
			const itemRefs = useRef({});

			const fdataRef = useRef({ filtered: [], memories: [] });
			const fileRef = useRef(null);

			// 最近用过的目录（本地记忆，与宿主 collectProjects 的结果合并——宿主重启后也能立刻选到）
			// ⚠️ 只在"用户明确提交"时调用（回车 / 点保存 / 从下拉里选）；**绝不在每次输入或每次加载时记**，
			// 否则 D:/D、D:/DS 这种半截路径会灌满历史（用户 2026-09-11 实测反馈）。
			const rememberDir = (c) => {
				try {
					const k = "pm.recentDirs";
					const arr = JSON.parse(localStorage.getItem(k) || "[]");
					const next = [c, ...arr.filter((x) => x !== c)].slice(0, 10);
					localStorage.setItem(k, JSON.stringify(next));
				} catch (e) { /* localStorage 不可用（隐私模式）：忽略，不影响加载 */ }
			};
			// opts.keepMsg：保留当前提示条（校验失败/撤销失败后会紧接一次重新加载，
			// 若让 load 清空提示，用户就看不到"未生效"的说明——行为测试抓到的真 bug）。
			// ⚠️ load 里**不记历史**（用户实测反馈：输入过程会被记成一堆半截路径）——
			// 只有"用户明确提交"（回车/保存/下拉选择）才调 rememberDir。
			const load = useCallback((c, opts) => {
				const keep = !!(opts && opts.keepMsg);
				return fetchJson("/list", { method: "POST", body: JSON.stringify({ action: "list", cwd: c }) })
					.then((r) => {
						setMemories(r.ok ? (r.memories || []) : []);
						if (!keep) setMsg(r.ok ? "" : "加载失败: " + (r.error || "?"));
					})
					.catch((err) => setMsg("加载失败: " + err));
			}, []);
			// 只在挂载时加载默认目录；**之后不随输入框每次变化自动加载**（用户需求：输入目录后按回车才开始搜索）
			useEffect(() => { load(cwd); }, []); // eslint-disable-line react-hooks/exhaustive-deps

			// —— 项目目录 Typeahead 助手（用户需求 2026-09-11）——
			// loadDirs：问宿主"现有项目有哪些"（每个 profile 见过/活跃会话的 cwd + 记忆条数），
			// 再合并本地"最近使用"，去重后供下拉使用。拿不到就静默降级（只留输入框）。
			const loadDirs = () => {
				fetchJson("/projects", { method: "POST", body: JSON.stringify({ action: "projects" }) })
					.then((r) => {
						const fromHost = (r && r.ok && Array.isArray(r.projects)) ? r.projects : [];
						let recent = [];
						try { recent = cleanRecentDirs(JSON.parse(localStorage.getItem("pm.recentDirs") || "[]")); } catch (e) { recent = []; }
						const have = new Set(fromHost.map((p) => p.cwd));
						const merged = fromHost.slice();
						for (const c of recent) {
							if (typeof c === "string" && c && !have.has(c)) { have.add(c); merged.push({ cwd: c, count: undefined, updatedAt: 0, lastSeenAt: 0 }); }
						}
						setDirList(merged);
						dirLoadedRef.current = true; // 标记已加载，聚焦时不再重复请求
					})
					.catch(() => { /* 宿主不可用：下拉为空，输入依然可用 */ dirLoadedRef.current = true; });
			};
			// 输入即过滤（子串匹配，最多 8 条）；空输入显示全部现有项目
			const dirFiltered = (text) => {
				const q = String(text || "").trim().toLowerCase();
				const list = q ? dirList.filter((p) => String(p.cwd).toLowerCase().includes(q)) : dirList;
				return list.slice(0, 8);
			};
			// 选中某个现有项目：填入输入框 → 立即加载该项目记忆 → 关闭下拉 → 记入最近使用
			const pickDir = (c) => { setCwd(c); setDirOpen(false); setDirHi(-1); rememberDir(c); load(c); };
			// 回车：没在下拉里用方向键选 → 按输入框里输入的目录加载；选了 → 加载选中项
			const submitDir = () => {
				const hits = dirFiltered(cwd);
				if (dirOpen && dirHi >= 0 && hits[dirHi]) { pickDir(hits[dirHi].cwd); return; }
				const typed = String(cwd || "").trim();
				if (!typed) { setMsg("请先输入项目目录"); return; }
				setDirOpen(false);
				setDirHi(-1);
				rememberDir(typed);
				load(typed); // cwd 已是输入框内容；直接加载该目录的记忆
			};

			// ⚠️ 只"把光标放到末尾"，**绝不调用 focus()**。
			// 历史 bug：这里原本有 el.focus()，而它被当作**回调 ref**（`ref={(el) => focusEnd(el)}`）使用 →
			// React 每次渲染都会重新调用回调 ref（箭头函数每次是新函数）→ 每次都 focus() →
			// 用户点「项目目录」输入框时焦点被夺走，文字全进了搜索框。
			// 结论：ref 回调里永远不要写会改变焦点/滚动等副作用的操作。聚焦只由 useEffect(searchOpen) 负责。
			const moveCaretToEnd = (el) => {
				if (!el) return;
				try { const n = String(el.value || "").length; el.setSelectionRange(n, n) } catch (e) { /* 不支持则忽略 */ }
			};

			const persist = (next) => fetchJson("/save", { method: "POST", body: JSON.stringify({ action: "save", cwd, memories: next }) })
				.then((r) => { if (!r.ok) setMsg("保存失败: " + (r.error || "?")); return r; });

			// ── 统一的"编辑类"提交（编辑 / 新增 / 删除共用）──────────────────────────────
			// 纪律（与拖动排序、保存排序一致）：**写盘 → 服务端回读校验 → 只有 verified 才算成功**；
			// 失败或未生效一律**如实上报并重新载入磁盘真实数据**，绝不谎报"已保存"。
			// 历史缺陷：这三条路径曾是 `persist(next).then(() => { setMemories(next); setMsg("已保存") })`
			// —— 不检查 ok/verified，写盘失败也显示成功（违反"绝不谎报成功"纪律）。
			const commitEdit = (next, okMsg, onOk) => {
				const prev = memories; // 失败时用于回滚界面
				setMemories(next);     // 乐观更新，保证操作手感
				persist(next).then((r) => {
					if (!r || !r.ok) {
						setMsg("保存失败：" + ((r && r.error) || "未知错误") + "，已重新载入磁盘数据。");
						load(cwd, { keepMsg: true });
						return;
					}
					if (!r.verified) {
						setMsg("未生效：写盘成功但回读不一致（文件内共 " + r.count + " 条）。已重新载入磁盘实际数据。");
						load(cwd, { keepMsg: true });
						return;
					}
					// 成功：用服务端确认后的数据为准，再执行收尾（关弹窗/清草稿等）
					if (Array.isArray(r.memories) && r.memories.length) setMemories(r.memories);
					setMsg(okMsg);
					if (typeof onOk === "function") onOk();
					void prev;
				});
			};

			// 「保存排序」第一步：只弹二次确认，不写盘（用户要求：先确认再动手）
			const saveSortedOrder = () => {
				if (sort === "default") return;
				setSortConfirm({ label: SORT_LABEL[sort] || sort, count: memories.length });
			};
			// 「保存排序」第二步（确认后）：写盘 → **服务端回读校验** → 只有 verified 才报成功。
			// 走与拖动排序完全相同的写盘路径（persist → /save）+ checkSanity 体检；只改数组顺序，不动记忆内容。
			const doSaveSortedOrder = () => {
				const info = sortConfirm;
				if (!info) return;
				const mode = sort;
				const next = sortList(memories, mode);
				const ids = new Set(memories.map((m) => m.id));
				const bad = checkSanity(next, memories, ids);
				if (bad) { setSortConfirm(null); setMsg("保存排序未执行：" + bad); return; }
				const prev = memories;
				setSortConfirm(null);
				persist(next).then((r) => {
					if (!r || !r.ok) { setMsg("保存排序失败：" + ((r && r.error) || "未知错误")); return; }
					if (!r.verified) {
						// 回读校验未通过：绝不谎报成功，按磁盘真实状态刷新界面并说明差异位置
						setMsg("保存排序未生效：写盘成功但回读顺序不一致（首个不同位置：第 " + (r.mismatchAt >= 0 ? (r.mismatchAt + 1) : "?") + " 位，文件内共 " + r.count + " 条）。已重新载入磁盘实际顺序。");
						load(cwd, { keepMsg: true });
						return;
					}
					setMemories(next);
					setUndoOrder(prev);
					setSort("default");
					setSortDone({ label: info.label, count: r.count || next.length });
					setMsg("已按「" + info.label + "」保存为默认顺序（共 " + (r.count || next.length) + " 条）· 10 秒内可撤销");
				});
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
				persist(back).then((r) => {
					if (r && r.ok && r.verified) setMsg("已撤销，顺序恢复为保存前");
					else if (r && r.ok) { setMsg("撤销未生效（回读顺序不一致），已重新载入磁盘实际顺序。"); load(cwd, { keepMsg: true }); }
				});
			};
			// 撤销窗口 10 秒后自动关闭（只清内存标记，不写盘）
			useEffect(() => {
				if (!undoOrder) return undefined;
				const t = setTimeout(() => setUndoOrder(null), 10000);
				return () => clearTimeout(t);
			}, [undoOrder]);
			// 保存成功告知弹窗：3 秒后自动关闭（用户定：2 秒偏快，改 3 秒）
			useEffect(() => {
				if (!sortDone) return undefined;
				const t = setTimeout(() => setSortDone(null), 3000);
				return () => clearTimeout(t);
			}, [sortDone]);
			// 记忆搜索框：**只在本框"由关变开"时聚焦一次**（唯一的聚焦入口）。
			// 之前两处都在抢焦点：① input 的 autoFocus（每次渲染都执行）；② 回调 ref 里的 focusEnd()。
			// 现在只保留这一处，并且：
			//   · 只在 searchOpen 变 true 时执行；
			//   · 用 focusedOnceRef 防止 effect 因依赖变化重复触发；
			//   · 若用户此刻正在别的输入框打字，则**不抢**（避免打断）。
			useEffect(() => {
				if (!searchOpen) { searchFocusedOnceRef.current = false; return undefined; }
				if (searchFocusedOnceRef.current) return undefined;
				const t = setTimeout(() => {
					const el = searchInputRef.current;
					if (!el) return;
					const active = document.activeElement;
					const typingElsewhere = active && active !== el && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName || "");
					if (typingElsewhere) return; // 用户正在别处输入 → 绝不抢
					try { el.focus(); moveCaretToEnd(el); searchFocusedOnceRef.current = true } catch (e) { /* 忽略 */ }
				}, 60);
				return () => clearTimeout(t);
			}, [searchOpen]);

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
			// 导入第一步（用户需求）：选好文件 → **先解析并由插件自动判定分类/等级、生成标题简介** →
			// 弹确认框（预选好、可手动改）→ 用户点"确定导入"才写盘。不再"选完文件直接落盘"。
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
						// id 去重：与现有记忆或本批次内重复时换新 id（否则会撞 id、React key 重复）
						const used = new Set(memories.map((x) => x.id));
						const items = list.map((m) => {
							const guess = classifyImportMemory(m); // ① 分类/等级/标题/简介/排版一气呵成
							let id = (m && typeof m.id === "string" && m.id) ? m.id : "";
							if (!id || used.has(id)) id = "mem-" + Math.random().toString(36).slice(2, 10);
							used.add(id);
							return {
								id,
								title: guess.title,
								description: guess.description,
								body: guess.body,
								type: guess.type,
								ttl: guess.ttl,
								obligation: guess.obligation,
								pinned: guess.pinned,
								source: (m && m.source) || "import",
								tags: Array.isArray(m && m.tags) ? m.tags : [],
								scope: "project",
								status: (m && m.status) || "active",
								heat: typeof (m && m.heat) === "number" ? m.heat : 0,
								createdAt: (m && m.createdAt) || now,
								updatedAt: (m && m.updatedAt) || now,
							};
						});
						setImportDraft({ items }); // ② 交给确认弹窗（用户可改分类/等级/标题/简介）
						setMsg("");
					} catch (err) { setMsg("导入失败: " + err); }
				};
				reader.readAsText(file);
				e.target.value = "";
			};
			// 确认弹窗里改某一条的分类/等级/标题/简介（纯前端草稿，未写盘）
			const updateImportItem = (i, patch) => setImportDraft((d) => (d ? { ...d, items: d.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) } : d));
			// 导入第二步：按用户确认后的内容写盘（置顶 + 与其它写入同一套"回读校验"纪律）
			const confirmImport = () => {
				if (!importDraft) return;
				const items = importDraft.items || [];
				if (!items.length) { setImportDraft(null); return; }
				const bad = items.filter((m) => !m || typeof m.id !== "string" || typeof m.title !== "string"
					|| typeof m.description !== "string" || typeof m.body !== "string" || !labels[m.type]);
				if (bad.length) { setMsg("导入未执行：有 " + bad.length + " 条记录不完整或分类非法"); return; }
				const next = items.concat(memories); // 置顶：导入的记忆排在最前（分类分组后即显示在各组顶部，便于区分）
				setImportDraft(null);
				persist(next).then((r) => {
					if (!r || !r.ok) { setMsg("导入失败：" + ((r && r.error) || "未知错误") + "，已重新载入磁盘顺序。"); load(cwd, { keepMsg: true }); return; }
					if (!r.verified) { setMsg("导入未生效：写盘成功但回读顺序不一致。已重新载入磁盘实际顺序。"); load(cwd, { keepMsg: true }); return; }
					setMemories(next);
					setMsg("已导入 " + items.length + " 条（已按所选分类置顶）");
				});
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
				// 注意：checkSanity 已上提到模块作用域（见文件上方 sortList 附近），
				// 因为「保存排序」也要用它；原先定义在这里（拖动指针处理函数内部）导致
				// 保存排序点击时 ReferenceError（弹窗不消失、毫无反应）。

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
								// ★ 统一优先级（用户 2026-09-11 定调）：**拖动 = 保存**。
								// 手动拖动 与「保存排序」走同一条写盘路径（persist → /save → 服务端 explicitOrder 落盘），
								// 且都做**回读校验**：只有 verified 才算"存住了"；不一致绝不谎报成功，
								// 立刻按磁盘真实顺序刷新界面（避免"看着是新顺序、重启后回退"的错觉）。
								const prev = mem;
								setMemories(next);
								persist(next).then((r) => {
									if (!r || !r.ok) {
										setMsg("拖动排序保存失败：" + ((r && r.error) || "未知错误") + "，已重新载入磁盘顺序。");
										load(cwd, { keepMsg: true });
										return;
									}
									if (!r.verified) {
										setMsg("拖动排序未生效：写盘成功但回读顺序不一致（首个不同位置：第 " + (r.mismatchAt >= 0 ? (r.mismatchAt + 1) : "?") + " 位，文件内共 " + r.count + " 条）。已重新载入磁盘实际顺序。");
										load(cwd, { keepMsg: true });
										return;
									}
									setUndoOrder(prev); // 与「保存排序」同一套 10 秒撤销
									setMsg("顺序已保存（拖动即保存，共 " + (r.count || next.length) + " 条）· 10 秒内可撤销");
								});
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
										commitEdit(next, "已保存", () => { setEditingId(null); setDraft(null); });
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
			// 注：曾有一个 statusLabel 映射（定义后从未被读取 → 已删除；页签文案在下面渲染处直接内联）。
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
							commitEdit(next, "已新增", () => { setEditingId(null); setDraft(null); });
						} }, "新增"),
						h("button", { className: "pm-btn", onClick: () => { setEditingId(null); setDraft(null); } }, "取消")))) : null;

			const listChildren = (isAdding ? [addBlock] : []).concat(cells.length ? cells : [h("li", { className: "pm-empty" }, "暂无记忆——可新增，或让 AI 用 memory_write/imagine 记录")]);

			return h("div", { className: "pm" },
				h("style", null, CSS),
				h("div", { className: "pm-top" },
					h("div", null,
						h("h2", { className: "pm-title" }, "北极星 · 项目记忆"),
						h("p", { className: "pm-sub" }, "按项目独立存放 · 点击卡片展开正文 · 拖动手柄可排序")),
					h("div", { className: "pm-top-actions" },
						h("button", { className: "pm-sub-btn", onClick: exportJson }, "导出"),
						h("button", { className: "pm-sub-btn", onClick: () => { if (fileRef.current) fileRef.current.click(); } }, "导入"),
						h("button", { className: "pm-add", onClick: () => { setExpandedId(null); setEditingId("__new__"); setDraft({ title: "", description: "", body: "", type: "project", status: "active" }); } }, "新增记忆")),
					h("input", { ref: fileRef, type: "file", accept: ".json,application/json", style: { display: "none" }, onChange: onImportFile })),
				h("div", { className: "pm-toolbar" },
					h("span", { className: "pm-label" }, "项目目录"),
					h("div", { className: "pm-ac-wrap" },
						h("input", {
							className: "pm-input",
							value: cwd,
							placeholder: "输入项目目录，回车加载",
							// ⚠️ 修复"点一下就闪、无法输入"：
							// 旧写法 onChange/onFocus 都 setDirOpen(true)，而 onBlur 又 150ms 后关闭 →
							// 聚焦打开、抖动关闭、再打开…形成闪烁循环，且每次聚焦都发一次 /projects 请求
							// 造成连续重渲染，输入框拿不到焦点。
							// 新规则：**只有"用户正在输入且确实有匹配项"时才打开下拉**；
							// 聚焦只负责"确保列表已加载一次"（幂等，不重复请求）。
							onChange: (e) => { setCwd(e.target.value); setDirHi(-1); setDirOpen(true); },
							onFocus: () => { if (!dirList.length && !dirLoadedRef.current) loadDirs(); },
							onBlur: () => setDirOpen(false),
							onKeyDown: (e) => {
								const hits = dirFiltered(cwd);
								if (e.key === "ArrowDown") { e.preventDefault(); setDirOpen(true); setDirHi((i) => (hits.length ? Math.min(i + 1, hits.length - 1) : -1)); return; }
								if (e.key === "ArrowUp") { e.preventDefault(); setDirHi((i) => Math.max(i - 1, -1)); return; }
								if (e.key === "Escape") { setDirOpen(false); setDirHi(-1); return; }
								if (e.key === "Enter") { e.preventDefault(); submitDir(); }
							},
						}),
						// 下拉只在**有匹配项**时渲染（空列表不再渲染空面板，避免"闪一下又消失"）
						(dirOpen && dirFiltered(cwd).length)
							? h("ul", { className: "pm-ac" }, dirFiltered(cwd).map((p, i) => h("li", {
								key: p.cwd,
								className: "pm-ac-item" + (i === dirHi ? " pm-ac-hi" : ""),
								onMouseDown: (e) => { e.preventDefault(); pickDir(p.cwd); },
								onMouseEnter: () => setDirHi(i),
							}, [
								h("span", { key: "p", className: "pm-ac-path" }, p.cwd),
								h("span", { key: "c", className: "pm-ac-count" }, typeof p.count === "number" ? p.count + " 条" : ""),
							])))
							: null),
					// 保存按钮：紧跟目录输入框（曾因"注释与代码挤在同一行"被 // 整行注掉 → 按钮从未渲染，用户实测"保存不见了"）
					h("button", { className: "pm-save", onClick: submitDir }, "保存"),
					// 搜索（用户要求：挪到「项目目录」这一行 → 整页更整齐）。图标按钮常驻、深色细边框与搜索框同色系；
					// 点它 → 输入框**向右推开**（槽宽 0→210 过渡）；左侧控件宽度全固定 → 🔍 自身不动；空词再点或 Esc 收起。
					h("div", { key: "search", className: "pm-search" }, [
						h("button", {
							key: "btn",
							className: "pm-search-btn" + ((searchOpen || q) ? " on" : ""),
							onClick: () => { if (searchOpen && !q) setSearchOpen(false); else setSearchOpen(true); },
							title: searchOpen ? (q ? "搜索中：" + q : "收起搜索") : "搜索记忆",
						}, [
							h("svg", {
								key: "lens", width: "13", height: "13", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
								"stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round",
							}, [h("circle", { key: "c", cx: "11", cy: "11", r: "8" }), h("line", { key: "l", x1: "21", y1: "21", x2: "16.65", y2: "16.65" })]),
							(!searchOpen && q) ? h("span", { key: "badge", className: "pm-badge", title: q }, q) : null,
						]),
						// 展开的输入框放在**格子(slot)**里：0 → 130px 过渡 → 向右推开、「记忆 N」自然让位（零遮挡）
						// 左侧四个控件宽度全固定（含上面的 ac-wrap 170px），所以 🔍 的位置在展开前后是常量。
						h("div", { key: "slot", className: "pm-search-slot" + (searchOpen ? " open" : "") },
							h("div", { className: "pm-search-inner" },
								h("div", { className: "pm-search-box" }, [
									h("input", {
										key: "i", value: q, placeholder: "搜索记忆…", tabIndex: searchOpen ? 0 : -1,
										// 回调 ref **只记录元素**，绝不做 focus() 等副作用（见 moveCaretToEnd 的说明）
										ref: (el) => { searchInputRef.current = el; },
										// ⚠️ 绝不能用 autoFocus：该输入框在 DOM 中**始终存在**（只是宽度 0 被裁掉），
										// React 每次重渲染都会执行 autoFocus → 抢走焦点，
										// 表现为"点目录输入框打字，字却跑进搜索框"（用户实测）。
										// 正确做法：只在本框刚展开时聚焦一次（见下方 useEffect 监听 searchOpen）。
										onChange: (e) => setQ(e.target.value),
										onKeyDown: (e) => { if (e.key === "Escape") { if (!q) setSearchOpen(false); else setQ(""); } },
									}),
									q ? h("button", {
										key: "x", className: "pm-search-clear", title: "清空搜索",
										onClick: (e) => {
											e.stopPropagation();
											setQ("");
											const box = e.currentTarget && e.currentTarget.parentNode;
											const inp = box && box.querySelector && box.querySelector("input");
											if (inp) inp.focus();
										},
									}, "✕") : null,
								]))),
					]),
					h("span", { className: "pm-stat", title: "当前项目的记忆条数" }, "记忆", h("b", null, memories.length))),
				// 「最近：xxx」独立一行（用户要求：放在筛选胶囊**上方**，给足宽度不压缩）
				(function () {
					const recent = [...memories].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
					return recent
						? h("div", { className: "pm-recent-row" },
							h("span", { className: "pm-stat pm-stat-recent", title: recent.title }, "最近：", h("span", { className: "pm-recent" }, recent.title)))
						: null;
				})(),
				h("div", { className: "pm-bar" },
					["all", "active", "candidate", "archived"].map((k) => h("button", { key: k, className: "pm-tab" + (filter === k ? " on" : ""), onClick: () => setFilter(k) }, k === "all" ? "全部" : ({ active: "活跃", candidate: "待审", archived: "已归档" }[k] || k))),
					// 排序：**紧跟在「已归档」胶囊右边**（用户定案：不顶到最右，右侧留白）
					(filter !== "archived") ? h("span", { style: { display: "inline-flex", alignItems: "center", gap: "8px", flex: "0 0 auto" } },
						h("select", { className: "pm-select pm-sort", value: sort, onChange: (e) => setSort(e.target.value), title: "排序方式" },
							h("option", { value: "default" }, "排序：默认"),
							h("option", { value: "newest" }, "排序：从新到旧"),
							h("option", { value: "important" }, "排序：重要等级高→低"),
							h("option", { value: "inject" }, "排序：自动注入多→少")),
						// 保存排序：仅在自动排序（非默认/手动）时出现；点了就把当前规则固化成默认（手动）顺序
						(sort !== "default") ? h("button", { className: "pm-btn", onClick: saveSortedOrder, title: "把当前排序固化为默认（手动）顺序，之后仍可拖动微调" }, "保存排序") : null) : null),
				h("ul", { className: "pm-list" + (drag ? " pm-dragging" : ""), ref: listRef }, listChildren),
				// 提示条与「撤销」按钮**相互独立**：撤销是独立功能，不能因为提示消息为空就消失
				// （历史缺陷：撤销按钮曾被塞进 msg 的三元分支里 → msg 清空时入口消失，用户无法撤销）。
				(msg || undoOrder) ? h("div", { className: "pm-msg" },
					msg || "顺序已改变",
					undoOrder ? h("button", { className: "pm-btn", style: { marginLeft: "8px" }, onClick: undoSortedOrder, title: "恢复保存排序之前的顺序" }, "撤销") : null) : null,
				pendingDeleteId ? (function () {
					const target = memories.find((x) => x.id === pendingDeleteId);
					const title = target ? target.title : "";
					const confirmDelete = () => {
						const next = memories.filter((x) => x.id !== pendingDeleteId);
						commitEdit(next, "已删除", () => { setPendingDeleteId(null); });
					};
					return h("div", { className: "pm-confirm-overlay", onClick: (e) => { if (e.target === e.currentTarget) setPendingDeleteId(null); } },
						h("div", { className: "pm-confirm" },
							h("h4", null, "确认删除"),
							h("p", null, "确定要删除这条项目记忆吗？"),
							h("p", { className: "pm-cmsg" }, "「" + title + "」此操作不可撤销。"),
							h("div", { className: "pm-crow" },
								h("button", { className: "pm-cbtn danger", onClick: confirmDelete }, "确认删除"),
								h("button", { className: "pm-cbtn", onClick: () => setPendingDeleteId(null) }, "取消"))));
				})() : null,
				// 导入确认弹窗（用户需求）：插件自动判定分类/等级 + 生成标题/简介 → 用户可改 → 点"确定导入"才写盘
				importDraft ? h("div", { className: "pm-confirm-overlay", onClick: (e) => { if (e.target === e.currentTarget) setImportDraft(null); } },
					h("div", { className: "pm-confirm pm-import" },
						h("h4", null, "导入确认（" + importDraft.items.length + " 条）"),
						h("p", { className: "pm-import-hint" }, "已自动判断「分类」与「重要等级」，并按正文生成标题/简介与排版。不满意可直接改——确认后按所选分类置顶放进列表（分类分组后即显示在各组顶部）。"),
						h("ul", { className: "pm-import-list" }, importDraft.items.map((it, i) =>
							h("li", { key: (it.id || "imp") + "-" + i, className: "pm-import-row" },
								h("div", { className: "pm-import-idx" }, String(i + 1)),
								h("div", { className: "pm-import-fields" },
									h("input", { className: "pm-input", value: it.title, placeholder: "标题（自动生成，可改）", onChange: (e) => updateImportItem(i, { title: e.target.value }) }),
									h("input", { className: "pm-input pm-input-sm", value: it.description, placeholder: "简介（自动生成，可改）", onChange: (e) => updateImportItem(i, { description: e.target.value }) }),
									h("div", { className: "pm-cat-row" },
										h("span", null, "分类："),
										h("select", { className: "pm-select", value: it.type, onChange: (e) => updateImportItem(i, { type: e.target.value }) },
											h("option", { value: "project" }, "项目（这个项目的决定/进展）"),
											h("option", { value: "reference" }, "参考（文档/规范）"),
											h("option", { value: "feedback" }, "反馈（踩坑/心得）"),
											h("option", { value: "user" }, "用户（您的偏好习惯）"),
											h("option", { value: "skill" }, "技能（操作方法）"),
											h("option", { value: "knowledge" }, "知识（通用概念）")),
										h("span", null, "重要等级："),
										h("select", { className: "pm-select", value: it.ttl, onChange: (e) => updateImportItem(i, { ttl: e.target.value }) },
											h("option", { value: "event" }, "特定情况才想起"),
											h("option", { value: "permanent" }, "长期有效"),
											h("option", { value: "phase" }, "跟某个阶段有关"))))))),
						h("div", { className: "pm-crow" },
							h("button", { className: "pm-save", onClick: confirmImport }, "确定导入"),
							h("button", { className: "pm-cbtn", onClick: () => setImportDraft(null) }, "取消")))) : null,
				// 「保存排序」二次确认弹窗（确认后才写盘）
				sortConfirm ? h("div", { className: "pm-confirm-overlay", onClick: (e) => { if (e.target === e.currentTarget) setSortConfirm(null); } },
					h("div", { className: "pm-confirm" },
						h("h4", null, "确认保存排序"),
						h("p", null, "要把当前「" + sortConfirm.label + "」的顺序保存为默认（手动）顺序吗？"),
						h("p", { className: "pm-cmsg" }, "共 " + sortConfirm.count + " 条。保存后会写入记忆文件；之后仍可用拖动手柄微调，10 秒内也可撤销。"),
						h("div", { className: "pm-crow" },
							h("button", { className: "pm-cbtn", onClick: doSaveSortedOrder }, "确认保存"),
							h("button", { className: "pm-cbtn", onClick: () => setSortConfirm(null) }, "取消")))) : null,
				// 保存成功告知弹窗（3 秒后自动关闭；仅服务端回读校验通过时出现）
				sortDone ? h("div", { className: "pm-confirm-overlay" },
					h("div", { className: "pm-confirm" },
						h("h4", null, h("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", style: { verticalAlign: "-2px", marginRight: "6px", color: "#7bc47b" } }, h("polyline", { points: "20 6 9 17 4 12" })), "已保存为默认顺序"),
						h("p", null, "已按「" + sortDone.label + "」写入默认（手动）顺序，共 " + sortDone.count + " 条。"),
						h("p", { className: "pm-cmsg" }, "已回读校验通过 · 本提示 3 秒后自动关闭"))) : null
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
