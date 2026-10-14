/**
 * DOM shell for Plan Studio.
 * Desktop: full-bleed canvas with floating liquid-glass panels (top bar, tool rail, inspector, library hotbar)
 * plus a GTA-style HUD (radar, stats, mission banner). Narrow screens fall back to a stacked grid with drawers.
 * Element ids and hps-* classes are queried by the engine — rename only together with planStudio.ts.
 * Labels that carry data-en must stay text-only; the engine rewrites their textContent.
 */

const ICONS = {
  house:
    '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  select:
    '<path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/>',
  measure:
    '<path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2"/><path d="m11.5 9.5 2-2"/><path d="m8.5 6.5 2-2"/><path d="m17.5 15.5 2-2"/>',
  demolish:
    '<path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9"/><path d="m18 15 4-4"/><path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5"/>',
  zoomIn:
    '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/><path d="M11 8v6"/><path d="M8 11h6"/>',
  zoomOut:
    '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/><path d="M8 11h6"/>',
  fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  orbit:
    '<path d="M16.466 7.5C15.643 4.237 13.952 2 12 2 9.239 2 7 6.477 7 12s2.239 10 5 10c.342 0 .677-.069 1-.2"/><path d="m15.194 13.707 3.814 1.86-1.86 3.814"/><path d="M19 15.57c-1.804.885-4.274 1.43-7 1.43-5.523 0-10-2.239-10-5s4.477-5 10-5c4.838 0 8.873 1.718 9.8 4"/>',
  walk: '<path d="M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z"/><path d="M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z"/><path d="M16 17h4"/><path d="M4 13h4"/>',
  iso: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  top: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 12h18"/><path d="M12 3v18"/>',
  library:
    '<path d="M19 9V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v3"/><path d="M3 16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v1.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5V11a2 2 0 0 0-4 0z"/><path d="M5 18v2"/><path d="M19 18v2"/>',
  props:
    '<path d="M21 4h-7"/><path d="M10 4H3"/><path d="M21 12h-9"/><path d="M8 12H3"/><path d="M21 20h-5"/><path d="M12 20H3"/><path d="M14 2v4"/><path d="M8 10v4"/><path d="M16 18v4"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
} as const;

const icon = (name: keyof typeof ICONS) =>
  `<svg class="hps-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

/** Rail button: icon + short label stacked */
const railBtn = (
  attrs: string,
  ico: keyof typeof ICONS,
  zh: string,
  en: string,
  active = false
) =>
  `<button class="hps-btn hps-railbtn${active ? " hps-active" : ""}" ${attrs}>${icon(ico)}<span data-en="${en}">${zh}</span></button>`;

export const STUDIO_SHELL_HTML = `<div class="hps-shell">
  <header class="hps-top lglass">
    <div class="hps-brand">
      <span class="hps-logo">${icon("house")}</span>
      <div class="hps-brandtext"><b data-en="Space Studio">空間工作室</b><span id="subtitle">原始戶型 1:60 · 尺寸單位 mm</span></div>
    </div>
    <div class="hps-grp hps-seg" id="viewSeg" title="切換 2D / 3D (T)" data-en-title="Switch 2D / 3D (T)">
      <span class="hps-pill"></span>
      <button class="hps-btn" data-view="2d" data-en="2D Plan">2D 平面</button>
      <button class="hps-btn" data-view="3d" data-en="3D Scene">3D 場景</button>
    </div>
    <div class="hps-spacer"></div>
    <div class="hps-toptools">
    <div class="hps-actions">
      <button class="hps-btn hps-iconbtn" id="undo" title="復原 (Ctrl+Z)" data-en-title="Undo (Ctrl+Z)">${icon("undo")}</button>
      <button class="hps-btn hps-iconbtn" id="redo" title="重做 (Ctrl+Shift+Z)" data-en-title="Redo (Ctrl+Shift+Z)">${icon("redo")}</button>
      <button class="hps-btn hps-iconbtn hps-danger" id="clearAll" title="清空所有家具家電（可復原）" data-en-title="Remove all furniture and appliances (undoable)">${icon("trash")}</button>
    </div>
    <details class="hps-menu"><summary class="hps-btn" data-en="File ▾">檔案 ▾</summary>
      <div class="hps-menupop glass-menu">
        <button class="hps-btn" id="fromPlanImg" data-en="Build from floor plan" title="上傳平面圖，辨識牆／門／窗">從平面圖建立</button>
        <button class="hps-btn" id="importJson" data-en="Import plan">匯入方案</button>
        <button class="hps-btn" id="exportJson" data-en="Export plan JSON">匯出方案 JSON</button>
        <button class="hps-btn" id="exportPng" data-en="Export image">匯出圖片</button>
        <button class="hps-btn" id="restoreDefaultPlan" data-en="Restore sample apartment">還原範例戶型</button>
      </div></details>
    <button class="hps-btn hps-ghost" id="fullscreen" title="全螢幕 (Shift+F)">⛶ 全螢幕</button>
    </div>
    <input type="file" id="fileIn" accept=".json,application/json" hidden>
  </header>

  <div class="hps-dock">
  <nav class="hps-rail lglass" aria-label="工具">
    <div class="hps-railgrp hps-only2d" id="tools">
      ${railBtn('data-tool="select" title="選取 / 移動 (V)" data-en-title="Select / Move (V)"', "select", "選取", "Select", true)}
      ${railBtn('data-tool="measure" title="測量 (M)" data-en-title="Measure (M)"', "measure", "測量", "Measure")}
      ${railBtn('data-tool="demolish" title="拆改非承重牆 (X)" data-en-title="Demolish non-bearing walls (X)"', "demolish", "拆牆", "Demolish")}
    </div>
    <div class="hps-railgrp hps-railzoom hps-only2d">
      <button class="hps-btn hps-mini" id="zoomIn" title="放大" data-en-title="Zoom in">${icon("zoomIn")}</button>
      <button class="hps-btn hps-mini" id="zoomOut" title="縮小" data-en-title="Zoom out">${icon("zoomOut")}</button>
      <button class="hps-btn hps-mini hps-wide" id="fit" title="適應視窗 (F)" data-en-title="Fit to window (F)">${icon("fit")}</button>
      <button class="hps-btn hps-mini" id="s60" title="按 1:60 顯示（與原圖同比例）" data-en-title="Show at 1:60 (same scale as the original plan)">1:60</button>
      <button class="hps-btn hps-mini" id="s100" title="按 1:100 顯示" data-en-title="Show at 1:100">1:100</button>
    </div>
    <div class="hps-railgrp hps-only3d" id="modes3d">
      ${railBtn('data-mode="orbit"', "orbit", "鳥瞰", "Orbit", true)}
      ${railBtn('data-mode="walk"', "walk", "漫遊", "Walk")}
    </div>
    <div class="hps-railgrp hps-only3d">
      ${railBtn('id="vIso"', "iso", "斜視", "Iso")}
      ${railBtn('id="vTop"', "top", "俯視", "Top")}
    </div>
    <div class="hps-spacer"></div>
    <div class="hps-railgrp" id="paneBtns">
      ${railBtn('id="tgLib"', "library", "家具", "Library")}
      ${railBtn('id="tgPanel"', "props", "屬性", "Props")}
    </div>
  </nav>
  <div class="hps-viewbar">
    <div class="hps-chips lglass hps-only2d" id="layers">
      <span class="hps-chiplabel" data-en="Show">顯示</span>
      <button class="hps-btn hps-chip hps-active" data-layer="dims" data-en="Dims">尺寸</button>
      <button class="hps-btn hps-chip hps-active" data-layer="labels" data-en="Rooms">房間</button>
      <button class="hps-btn hps-chip hps-active" data-layer="furn" data-en="Furniture">家具</button>
      <button class="hps-btn hps-chip" data-layer="grid" data-en="Grid">網格</button>
      <button class="hps-btn hps-chip" data-layer="bearing" data-en="Bearing walls">承重牆</button>
      <button class="hps-btn hps-chip hps-active" data-layer="wallSnap" title="拖動家具時貼牆吸附" data-en-title="Snap furniture to walls while dragging" data-en="Wall snap">貼牆吸附</button>
    </div>
    <div class="hps-chips lglass hps-only3d">
      <span class="hps-chiplabel" data-en="Walls">牆體</span>
      <button class="hps-btn hps-chip hps-active" data-cut="2.8" data-en="Full">全高</button>
      <button class="hps-btn hps-chip" data-cut="1.2" data-en="Cut">剖切</button>
    </div>
    <div class="hps-chips lglass hps-only3d" id="toggles3d">
      <button class="hps-btn hps-chip hps-active" data-t="furn" data-en="Furniture">家具</button>
      <button class="hps-btn hps-chip hps-active" data-t="labels" data-en="Labels">房間名</button>
      <button class="hps-btn hps-chip" data-t="night" data-en="Night">夜景</button>
    </div>
  </div>
  </div>

  <main id="stage" class="hps-stage">
    <svg id="plan" class="hps-tool-select" font-family="-apple-system,'Segoe UI','PingFang TC','Microsoft JhengHei','Noto Sans TC',sans-serif">
      <defs id="defs"></defs>
      <g id="gGrid"></g>
      <g id="gRooms"></g>
      <g id="gFurn"></g>
      <g id="gWalls"></g>
      <g id="gOpen"></g>
      <g id="gLabels" pointer-events="none"></g>
      <g id="gDims" pointer-events="none"></g>
      <g id="gMeasure" pointer-events="none"></g>
      <g id="gSel"></g>
    </svg>
    <div id="view3d">
      <div id="walkOverlay"><div><h3 data-en="Walk mode">漫遊模式</h3>
        <p id="wo1"></p>
        <p id="wo2"></p>
        <p id="wo3"></p></div></div>
      <div id="cross"></div>
      <div id="joy"><i></i></div>
      <button class="hps-btn hps-primary" id="walkExit" data-en="Exit walk">退出漫遊</button>
      <div id="hint3d"></div>
    </div>
    <div class="hps-dials hps-only3d">
      <div class="hps-dial lglass" data-dial="sun" data-ticks="32" data-zones="6:白天,17:黃昏,19:夜晚" role="slider" tabindex="0" aria-label="時間">
        <input type="range" id="sun" min="6" max="22" step=".25" value="10" hidden>
        <div class="hps-dialface"><b id="sunT">10:00</b><small class="hps-dialzone">白天</small></div>
        <span class="hps-dialname">時間</span>
      </div>
      <div class="hps-dial lglass" data-dial="lamp" data-ticks="24" role="slider" tabindex="0" aria-label="室內燈光">
        <input type="range" id="lamp" min="0" max="100" step="1" value="60" hidden>
        <div class="hps-dialface"><b id="lampT">60</b><small>%</small></div>
        <span class="hps-dialname">室內燈光</span>
      </div>
    </div>
    <div class="hps-scalebar" id="scalebar"><span id="sbText">1 m</span><div class="bar" id="sbBar"></div></div>
    <div class="hps-modehint" id="modehint"></div>
    <div id="fab" class="lglass"></div>
    <div class="hps-hud" aria-live="polite">
      <div class="hps-hudstars" id="hudStars"></div>
      <div class="hps-hudarea"><b id="hudArea">0.00</b><small>m²</small></div>
      <div class="hps-hudsub"><span id="hudPing">0 坪</span><span><span data-en="Items">家具</span> <b id="hudFurn">0</b></span></div>
    </div>
    <div class="hps-radar" aria-hidden="true">
      <div class="hps-radarmap lglass">
        <svg viewBox="-50 -38 100 76">
          <g id="radarRot"><g id="radarWorld">
            <use href="#gRooms"/><use href="#gFurn"/><use href="#gWalls"/>
            <rect id="radarView" fill="rgba(255,255,255,.08)" stroke="#fff" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
          </g></g>
        </svg>
        <i class="hps-radarme"></i>
        <b class="hps-radarn">N</b>
      </div>
      <div class="hps-radarbars">
        <span class="g" title="日照"><i id="barSun"></i></span>
        <span class="b" title="室內燈光"><i id="barLamp"></i></span>
      </div>
    </div>
    <div class="hps-mission" id="mission"><b id="missionT"></b><span id="missionS"></span></div>
  </main>

  <aside class="hps-lib hps-card lglass">
    <div class="hps-cardhead"><b data-en="Furniture library">家具庫</b><small data-en="Drag onto the plan">拖曳到平面圖</small></div>
    <div class="hps-cats" id="libCats"></div>
    <div class="hps-scroll">
      <div id="lib3d" class="hps-only3d">
        <h4 data-en="Rooms · click to fly there">房間 · 點擊飛到該房間</h4>
        <div id="roomList"></div>
      </div>
      <div id="lib"></div>
    </div>
  </aside>

  <aside class="hps-aside hps-card lglass"><div class="hps-scroll"><div id="panel"></div></div></aside>

  <footer class="hps-status lglass">
    <span class="hps-only2d">X <b id="cx">—</b></span><span class="hps-only2d">Y <b id="cy">—</b></span>
    <span class="hps-only2d"><span data-en="Scale">目前比例</span> <b id="ratio">—</b></span>
    <span id="hover" class="hps-only2d"></span>
    <span class="hps-spacer"></span>
    <span id="tip"></span>
  </footer>
</div>
<div id="toast"></div>
<div id="importPlanModal" class="hps-modal" hidden aria-hidden="true">
  <div class="hps-modal-backdrop" data-import-close="1"></div>
  <div class="hps-modal-card" role="dialog" aria-labelledby="importPlanTitle">
    <div class="hps-modal-head">
      <h2 id="importPlanTitle">從平面圖建立</h2>
      <span id="importPlanModeBadge" class="hps-mode-badge" data-mode="heuristic" title="離線啟發式偵測 + 規則組裝">啟發式</span>
      <button type="button" class="hps-btn" id="importPlanClose" title="關閉">✕</button>
    </div>
    <p id="importPlanStatus" class="hps-modal-status">選擇平面圖圖片（JPG／PNG）。</p>
    <div class="hps-modal-actions">
      <button type="button" class="hps-btn hps-primary" id="importPlanPick">選擇圖片</button>
      <button type="button" class="hps-btn hps-primary" id="importPlanConfirm" disabled>確認寫入</button>
      <button type="button" class="hps-btn" id="importPlanCancel">取消</button>
    </div>
    <div class="hps-modal-preview"><canvas id="importPlanCanvas"></canvas></div>
    <ul id="importPlanNotes" class="hps-modal-notes"></ul>
    <p class="hps-modal-legend"><span class="lg-wall">牆 黑</span><span class="lg-door">門 紅</span><span class="lg-win">窗 藍</span><span class="lg-exc">挖洞 灰虛線</span></p>
    <input type="file" id="importPlanFile" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" hidden>
  </div>
</div>`;
