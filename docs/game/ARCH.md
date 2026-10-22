# 3D 居家遊戲 — 架構（ARCH）

版本：v1（2026-10-21）　範圍：把現有「平面／3D」頁改成 3D 遊戲；**平面圖上傳辨識不得壞**。
工作樹：`/workspace/home-planner-game`（分支 `game-3d`，自 HEAD `2a56d68` 建立，並複製主工作樹中 3 個未提交的 `src/import-plan` 改動與 2 個腳本）。主工作樹 `/workspace/home-planner-deploy/home-planner` 的 59 項未提交變更**完全不動**。不 commit、不 push。

## 1. 現況（盤點）
- 無路由。`App.tsx → AppShell → PlanStudioHost`，後者把 `STUDIO_SHELL_HTML` 塞進 DOM，再呼叫 `bootPlanStudio()`（`studio/engine/planStudio.ts`，約 2,400 行命令式 2D SVG＋three.js）。
- 戶型資料：`PlanBlueprint`（`plan/types/blueprint.ts`，單位 mm，牆＝軸對齊矩形，開口＝牆上缺口矩形，`swingDoors`（鉸鏈 h、關閉方向 c、開啟方向 o、寬度 len、entry），`slidingDoors`（落地拉門），`planRooms`）。存在 localStorage `home-planner-blueprint-v1`；家具／房名存在 `home-planner-scheme-v1`（`SchemeDocument`）。
- 上傳辨識：`import-plan/*` → `floorplanToBlueprint` → `bindImportWizard.onConfirm(bp)` → `applyBlueprint`。後端 FastAPI/YOLO 以 `VITE_DETECT_API_URL` 開關。
- 既有 3D 漫遊在 planStudio 內：桌機用 PointerLockControls，觸控用搖桿；碰撞為牆矩形＋門扇線段；從入口門外 1.2 m 出生。

## 2. 掛接方式（最小侵入）
```
App.tsx ──> game/GameApp.tsx（React 狀態機）
  start ─┬─ 「自己建房子格局」 → 原 AppShell（不改）＋浮動鈕「進入遊戲」
         └─ 「系統配置」 → ConfigForm → generateLayout() → 2D 預覽
                         → 角色選擇 → 身高體重 → GameScene（新 three 場景）
```
- **只改** `App.tsx`（換成 `GameApp`）與 `PlanBlueprint.source` 型別加 `"generated"`。其餘全部是新檔：`src/game/**`、`scripts/test-layout.ts`、`docs/game/**`。
- 自建／上傳流程：仍走原 studio；按「進入遊戲」時讀 localStorage 的 blueprint＋scheme，交給同一個 GameScene。
- 系統配置：產生的 blueprint／scheme 寫入同兩個 key（使用者確認覆蓋後），因此也能回原編輯器繼續改、換家具。
- GameScene 是**新的獨立 three 場景**（`src/game/scene/*`），不重用 planStudio 內部（它依賴大量全域 DOM），只共用 `PlanBlueprint` 資料。

## 3. 戶型產生器 `game/layout/generateLayout.ts`（純函式）
輸入 `LayoutConfig`：`bedrooms 1–4`、`ping`（室內實坪，可空 → 依房數預設 15/22/30/38）、`livings 1|2`、`baths 1–3`、`kitchen: "open"|"closed"`、`seed`。
演算法（決定性，mulberry32(seed) 只影響微小比例與家具色）：
1. 面積 A = ping×3.3058 m²；外框 W×D，長寬比 1.25–1.45（seed）。外牆 200 mm(`e`)、內牆 120 mm(`n`)。
2. 分兩帶：北帶（深 3.3–3.8 m）放臥室＋衛浴；南帶放公共區。北帶由左到右切：主臥（最寬）、其他臥室、衛浴（寬 1.8–2.2 m）。臥室不足寬度時自動加深/加寬外框。
3. 公共區＝**單一開放房「客餐廳」**（含走道，不切房；2 廳只多放餐桌區、加寬）。`kitchen=closed` → 東南角獨立廚房（牆＋門通客餐廳），並在東側外加**工作陽台，用門**；`open` → 廚房為客餐廳內的一區（只放廚具家具），無工作陽台門。
4. 南側外加**休閒陽台**（深 1.5 m，欄杆 `low` 牆），客餐廳→陽台用**落地窗**（`slidingDoors`）。臥室接陽台（4 房主臥）一律用**門**。
5. 門：臥室/衛浴門開在與客餐廳相鄰的南牆，寬 0.9/0.8 m，向房內開；大門在西側外牆、通客餐廳，`entry:true`，寬 1.0 m 向內開。
6. 窗：每間臥室北外牆一窗（寬 = 房寬×0.5，窗台 0.9／窗頂 2.1）；衛浴小窗；客餐廳若西牆夠長加一窗。
7. 牆矩形依開口切段（開口處留缺口），輸出 `PlanBlueprint`＋`SchemeDocument`。
**驗證 `validateLayout`**（失敗即丟錯，測試涵蓋 1–4 房×多 seed）：每房可經門／開放邊從大門到達（BFS on room graph）；大門在外牆上且門外 1.5 m 無牆；客餐廳→陽台必為落地窗、臥室/廚房→陽台必為門；房間不重疊、在外框內；開口位於牆上；出生點不卡牆。

## 4. 家具自動擺放＋替換
- `game/furnish/autoFurnish.ts`：每種房型一組規則（靠牆、避開門擺動扇形與窗前 0.6 m、通道 ≥0.8 m）。主臥：雙人床 1.8＋床頭櫃×2＋衣櫃；次臥：單人床＋書桌＋衣櫃；客餐廳：沙發＋茶几＋電視櫃＋餐桌椅；廚房：流理台＋爐＋水槽＋**冰箱**；衛浴：馬桶＋浴櫃＋淋浴。
- 資料沿用 `SchemeFurniture{type,name,cx,cy,w,d,rot,color}`，新增選用欄位 `slot`（如 `master.bed`）＋`variantOf`。替換＝在同 `type` 類別（取自 `furnitureCatalog`）中換品項，保持 `cx,cy,rot`，寬深變化時重跑避讓檢查；不合格則提示。編輯器內原有拖放亦可用。

## 5. 角色系統
- 6 角色（男 3、女 3），**全部程式生成**（three 基本幾何：膠囊身體、球頭、大眼、髮型、衣服配色），零外部素材、無授權問題。定義在 `game/character/presets.ts`（髮型/髮色/衣著/膚色/配件），`buildCharacter(preset)` 產生 Group＋簡單走路擺動動畫。
- 身高 140–200 cm、體重 35–120 kg：整體縮放 = 身高/170；寬度係數 = clamp(BMI/22, 0.85, 1.3)^0.5；**眼高 = 身高×0.93**；碰撞半徑 0.2–0.28 m 隨體型。
- 鏡頭：**預設第一人稱**（拖曳轉視角、不鎖指標；WASD＋Shift；觸控左搖桿＋右側拖曳），`V` / 按鈕切**第三人稱**（肩後 2.2 m，相機防穿牆：沿射線遇牆縮短）。選角畫面以轉盤預覽角色。

## 6. 互動系統
- `Openable` 介面：`{id, kind:'door'|'entry'|'window'|'slider'|'fridge', open, t(0..1), animate(dt), colliderWhen(t)}`。
- 門/大門：鉸鏈旋轉 0→90°；窗：外推/側滑；落地窗：兩扇錯位滑開；冰箱：門鉸鏈 0→100°，冰箱本體為碰撞體。
- 目標選取：從相機射線（2.2 m 內）優先，否則取 1.5 m 內最近且在前方 ±60° 的物件；畫面顯示提示「E 開門」；觸控出現「開／關」按鈕。也可點擊/點按物件。
- 碰撞：牆、窗下牆、固定家具為 AABB；門扇為線段（隨角度即時更新）；開口處無碰撞＝門開了才走得過（關閉的門扇擋住）；落地窗關閉時玻璃擋住、開啟時讓出半寬。
- 高度規範：淨高 2.8、門高 2.1、窗台 0.9／窗頂 2.1、落地窗高 2.1（遊戲場景用此規範；原 studio 不動）。

## 7. 出生點
大門外法向 1.5 m、面朝門；若該點碰撞，沿法向再退 0.3 m 最多 5 次，再不行改沿外牆左右找。門外鋪一塊地墊／走廊地面，大門預設關閉。

## 8. 里程碑與驗收（交 平面轉3D測試）
| M | 內容 | 驗收 |
|---|---|---|
| M1 | 開始畫面（兩選項）＋系統配置表單＋戶型產生器＋驗證＋2D 預覽＋「在編輯器開啟」 | build 綠；`test:detect`、`test:ai` 綠；`test:layout`：1–4 房 × 20 seed × 開放/獨立廚房全過驗證；同 seed 輸出相同；截圖 4 種房數預覽；自建路徑仍進原編輯器、上傳精靈可開 |
| M2 | 自動家具＋替換 UI | 每房必有核心家具、無重疊、不擋門；替換後仍合規；廚房必有冰箱 |
| M3 | GameScene：牆/門/窗/落地窗/陽台、第一人稱走路、觸控、碰撞、門外出生 | 出生在大門外且可走進；不穿牆；不卡出生；手機搖桿可用；高度規範量測正確 |
| M4 | 互動：門、大門、窗、落地窗、冰箱開關（E＋觸控鈕＋點擊），碰撞隨開關更新 | 每類可開關；關門走不過、開門可過；動畫平順 |
| M5 | 6 角色＋性別選擇＋身高體重＋第三人稱 | 6 角色可辨識不同；身高影響眼高（140 vs 200 cm 量測）；第三人稱不穿牆 |
| M6 | 整合：自建/上傳戶型也能進遊戲、存檔、行動版、效能 | 3 張基準匯入圖可進遊戲並從大門外出生；60fps 桌機／30fps 手機目標 |

## 9. 風險
- 匯入戶型的大門可能沒標 `entry` 或方向錯 → 退回「最靠外框的門」並提示。
- planStudio 為大型全域腳本，遊戲場景與它同時掛載可能衝突（全域 keydown）→ 兩者互斥掛載。
- 產生器在極端輸入（1 房 50 坪、4 房 18 坪）比例怪 → 夾限並在表單提示。
- 程式生成角色的「可愛度」主觀 → 先交 QA 截圖確認。
- bundle 已 >500 kB → 遊戲用動態 import 分割。

## 10. 保護上傳辨識（不動清單）
`src/import-plan/**`、`backend/**`、`src/studio/**`、`src/plan/catalog|data/**` 不改；只讀。每個里程碑跑 `npm run build`、`npm run test:detect`、`npm run test:ai`。`PlanBlueprint` 只加型別聯集值，不改既有欄位。

## 11. 安全作業
- 主工作樹不動；所有開發在 worktree `game-3d`。合併時 `src/import-plan` 的 3 檔與主工作樹內容一致（已複製），不會衝突。
- 不 commit/push；Ken 確認後再決定提交方式。
