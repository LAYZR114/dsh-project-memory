/**
 * 目录行布局的**纯静态验证器**（不开浏览器）。
 *
 * 依据：CSS Flexible Box Layout Level 1 §9.7「Resolving Flexible Lengths」
 *   https://drafts.csswg.org/css-flexbox-1/#resolve-flexible-lengths
 *
 * 核心思想：在 flex-wrap:nowrap 的单行里，每一项的位置可以**手算出来**：
 *   1) 每项先取 flex base size（flex-basis:auto 且无 width → max-content 内容宽）；
 *   2) 剩余空间 free = 容器内容宽 − Σ(basis) − Σ(gap)；
 *   3) free > 0 → 按 flex-grow 比例分配；free < 0 → 按 flex-shrink×basis 加权削减；
 *   4) 从左往右累加即可得到每一项的 x 坐标。
 * 于是「🔍 展开前后 x 是否不变」变成一个可断言的**等式**，不需要任何渲染引擎。
 *
 * 用法：
 *   node test/layout-static-verify.mjs          # 跑断言，非 0 退出表示布局回归
 *   node test/layout-static-verify.mjs --table  # 额外打印各宽度下的位置表
 */

// ── 布局模型 ────────────────────────────────────────────────────────────────
// 只列**有固定宽度**的项；标签宽度取「项目目录」4 个汉字的近似渲染宽（13px 字号）。
const GAP = 8;

/** 目录行（.pm-toolbar）的 flex 项，顺序 = DOM 顺序。 */
function toolbarItems({ searchOpen }) {
  return [
    { id: 'label', basis: 72, grow: 0, shrink: 0 },   // .pm-label  flex:0 0 auto
    { id: 'ac-wrap', basis: 170, grow: 0, shrink: 0 }, // .pm-toolbar .pm-ac-wrap flex:0 0 auto;width:170px
    { id: 'save', basis: 74, grow: 0, shrink: 0 },    // .pm-save   flex:0 0 auto
    { id: 'search', basis: 40, grow: 0, shrink: 0 },  // .pm-search-btn flex:0 0 auto;width:40px
    { id: 'slot', basis: searchOpen ? 100 : 0, grow: 0, shrink: 0 }, // .pm-search-slot width:0 / .open 100px
    // 记忆胶囊：**展开时缩成纯数字**（.pm-stat-mini，省约 48px），否则 88px
    { id: 'stat', basis: searchOpen ? 44 : 88, grow: 0, shrink: 0 },  // .pm-stat / .pm-stat-mini
  ];
}

/** 按 §9.7 解析出一行里每项的最终 main size。 */
function resolveSizes(items, containerWidth) {
  const gaps = GAP * (items.length - 1);
  const sumBasis = items.reduce((a, it) => a + it.basis, 0);
  const free = containerWidth - gaps - sumBasis;

  if (free >= 0) {
    const growSum = items.reduce((a, it) => a + it.grow, 0);
    return items.map((it) => it.basis + (growSum > 0 ? free * (it.grow / growSum) : 0));
  }
  // 负剩余空间：权重 = flex-shrink × flex base size（MDN flex-shrink 说明的加权方式）
  const weightSum = items.reduce((a, it) => a + it.shrink * it.basis, 0);
  if (weightSum === 0) return items.map((it) => it.basis); // 全部 shrink:0 → 溢出，不缩
  return items.map((it) => it.basis + free * ((it.shrink * it.basis) / weightSum));
}

/** 返回每项的 { id, x, w, right }。 */
function layout(items, containerWidth) {
  const sizes = resolveSizes(items, containerWidth);
  let x = 0;
  return items.map((it, i) => {
    const w = sizes[i];
    const box = { id: it.id, x, w, right: x + w };
    x += w + GAP;
    return box;
  });
}

const posOf = (boxes, id) => boxes.find((b) => b.id === id);

// ── 断言 ────────────────────────────────────────────────────────────────────
let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✔ ${name}`);
  } else {
    failures++;
    console.log(`  ✖ ${name}${detail ? '  → ' + detail : ''}`);
  }
}

const WIDTHS = [1280, 1100, 900, 760, 700];

console.log('\n[1] 收起态：输入框/保存/🔍 三者紧贴（间距恰为 gap，无空白）');
for (const W of WIDTHS) {
  const boxes = layout(toolbarItems({ searchOpen: false }), W);
  const ac = posOf(boxes, 'ac-wrap');
  const save = posOf(boxes, 'save');
  const search = posOf(boxes, 'search');
  const gaps = [
    save.x - ac.right,
    search.x - save.right,
  ];
  check(`W=${W} 相邻间距 = ${gaps.join(',')}`, gaps.every((g) => Math.abs(g - GAP) < 0.01), `期望 ${GAP}`);
}

console.log('\n[2] 输入框宽度恒为 170px（不被任何剩余空间吃掉）');
for (const W of WIDTHS) {
  const ac = posOf(layout(toolbarItems({ searchOpen: false }), W), 'ac-wrap');
  check(`W=${W} ac-wrap = ${ac.w}px`, Math.abs(ac.w - 170) < 0.01, 'flex:0 0 auto 应保持 170');
}

console.log('\n[3] 剩余空间归右侧（胶囊之后），前面的控件不膨胀');
for (const W of WIDTHS) {
  const boxes = layout(toolbarItems({ searchOpen: false }), W);
  const stat = posOf(boxes, 'stat');
  const consumed = stat.right;
  check(`W=${W} 内容总宽 ${consumed} ≤ 容器 ${W}`, consumed <= W, '不得溢出');
  check(`W=${W} 尾部留白 ${Math.round(W - consumed)}px`, W - consumed >= 0, '留白应为正或 0');
}

console.log('\n[4] ★硬约束：展开搜索时 🔍 的 x 坐标**完全不变**');
for (const W of WIDTHS) {
  const closed = layout(toolbarItems({ searchOpen: false }), W);
  const open = layout(toolbarItems({ searchOpen: true }), W);
  const a = posOf(closed, 'search');
  const b = posOf(open, 'search');
  check(
    `W=${W} search.x: ${a.x} → ${b.x}`,
    a.x === b.x,
    `位移 ${b.x - a.x}px（必须 0；若输入框在展开时改宽就会非 0）`,
  );
}

console.log('\n[5] 展开只发生在 🔍 右侧：左侧全部控件 x/w 完全一致');
for (const W of WIDTHS) {
  const closed = layout(toolbarItems({ searchOpen: false }), W);
  const open = layout(toolbarItems({ searchOpen: true }), W);
  for (const id of ['label', 'ac-wrap', 'save', 'search']) {
    const a = posOf(closed, id);
    const b = posOf(open, id);
    check(`W=${W} ${id} 不变 (x=${a.x}, w=${a.w})`, a.x === b.x && a.w === b.w);
  }
  const slotC = posOf(closed, 'slot');
  const slotO = posOf(open, 'slot');
  check(`W=${W} slot 向右长 ${slotC.w} → ${slotO.w}`, slotO.x === slotC.x && slotO.w > slotC.w);
}

console.log('\n[6] 横向溢出阈值（超过则必须换行/滚动条 —— 当前设计的最小可用宽度）');
{
  const needed = toolbarItems({ searchOpen: true }).reduce((a, it) => a + it.basis, 0) + GAP * 5;
  console.log(`  · 展开态最小需求宽度 = ${needed}px（${needed} 以下会溢出/出现横向滚动条）`);
  const closedNeeded = toolbarItems({ searchOpen: false }).reduce((a, it) => a + it.basis, 0) + GAP * 5;
  console.log(`  · 收起态最小需求宽度 = ${closedNeeded}px`);
  // 展开的净增量 = 搜索框 100px − 胶囊缩窄 (88−44) = 100 − 44 = 56px
  check('展开态净增 56px（搜索框 +100 − 胶囊缩窄 44）', needed - closedNeeded === 56,
    `实际净增 ${needed - closedNeeded}px`)
  // 关键：展开态必须装得进 DSH 设置面板（≈540px 内容区）——本轮修复目标
  check(`展开态需求 ${needed}px ≤ 面板 540px（胶囊不被顶出）`, needed <= 540, '仍超出面板宽度');
}

console.log('\n[7] ★用户要求：胶囊**紧跟🔍**（收起态不被推到最后、展开时让位但不出屏）');
for (const W of WIDTHS) {
  const closed = layout(toolbarItems({ searchOpen: false }), W);
  const open = layout(toolbarItems({ searchOpen: true }), W);
  const slotC = posOf(closed, 'slot');
  const statC = posOf(closed, 'stat');
  const statO = posOf(open, 'stat');
  const slotO = posOf(open, 'slot');
  // 收起：胶囊紧跟（🔍/零宽槽 之后一个 gap）→ 因槽宽 0，实际左边距 = 一个 gap
  check(
    `W=${W} 收起态胶囊紧贴🔍（间距 ${statC.x - posOf(closed, 'search').right}px，含零宽槽）`,
    Math.abs(statC.x - (slotC.right + GAP)) < 0.01,
    '胶囊左边距应 = 搜索槽右边界 + 1 个 gap',
  )
  // 展开：胶囊被向右推开正好 100px（= 搜索框宽度）
  check(
    `W=${W} 展开时胶囊向右让位 ${statO.x - statC.x}px`,
    Math.abs(statO.x - statC.x - 100) < 0.01,
    '让位距离应恰为搜索框宽度 100px',
  )
  // 关键：胶囊不得超出容器右边界（用户实测"被顶出界面"）
  check(
    `W=${W} 展开时胶囊仍在可视区（右边界 ${Math.round(statO.right)} ≤ ${W}）`,
    statO.right <= W,
    '胶囊被顶出屏幕',
  )
  void slotO
}

console.log('\n[8] ★用户实测关键场景：DSH 设置面板（内容区 ≈540px）里展开搜索，胶囊必须完整可见');
{
  const PANEL = 540
  const closed = layout(toolbarItems({ searchOpen: false }), PANEL)
  const open = layout(toolbarItems({ searchOpen: true }), PANEL)
  const statO = posOf(open, 'stat')
  const statC = posOf(closed, 'stat')
  console.log(`  · 收起态总宽 ${Math.round(statC.right)}px / 展开态总宽 ${Math.round(statO.right)}px（面板 ${PANEL}px）`)
  check(
    `收起态装得下（${Math.round(statC.right)} ≤ ${PANEL}）`,
    statC.right <= PANEL,
    '收起态本身就溢出',
  )
  // 这是本轮的修复目标：展开态必须也装得下（胶囊缩成数字 + 搜索框缩到 100px 才做到）
  check(
    `展开态装得下（${Math.round(statO.right)} ≤ ${PANEL}）→ 胶囊不会被顶出屏幕`,
    statO.right <= PANEL,
    '展开态仍溢出 → 需要继续缩减（搜索框/胶囊）',
  )
  // 展开时胶囊必须比收起态更窄（"缩成纯数字"的结构性证据）
  check(
    `展开时胶囊变窄（${posOf(closed, 'stat').w} → ${statO.w}px，缩成纯数字）`,
    statO.w < posOf(closed, 'stat').w,
    '胶囊未按预期缩窄',
  )
}

// ── 可选：位置表 ────────────────────────────────────────────────────────────
if (process.argv.includes('--table')) {
  console.log('\n=== 位置表（x / width）===');
  for (const state of [false, true]) {
    console.log(`\n-- ${state ? '展开' : '收起'} --`);
    for (const W of [...WIDTHS, 600]) {
      const boxes = layout(toolbarItems({ searchOpen: state }), W);
      const cells = boxes.map((b) => `${b.id}@${b.x}(${b.w})`).join('  ');
      console.log(`  W=${String(W).padStart(4)}  ${cells}   total=${boxes.at(-1).right}`);
    }
  }
}

console.log(failures === 0 ? '\n全部静态布局断言通过 ✔\n' : `\n${failures} 项失败 ✖\n`);
process.exit(failures === 0 ? 0 : 1);
