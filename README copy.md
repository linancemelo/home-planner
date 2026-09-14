# 買房前資產規劃

互動式網站：彈性輸入購屋條件，即時計算頭期款缺口與達標時間，並可選用 Groq AI 診斷。

## 技術栈

- Next.js (App Router) + React + TypeScript
- Tailwind CSS + shadcn/ui
- next-themes（深淺色切換）
- Groq SDK（可選 AI 診斷）

## 快速開始

```bash
npm install
cp .env.example .env.local
# 編輯 .env.local，填入 GROQ_API_KEY
npm run dev
```

開啟 [http://localhost:3000](http://localhost:3000)。

未設定有效 API Key 時，其餘試算功能仍可正常使用；僅 AI 診斷會提示設定金鑰。

## 專案結構

```
src/
  app/
    api/diagnose/route.ts   # Groq AI 診斷 API
    layout.tsx
    page.tsx
  components/
    home-planner-app.tsx    # 主畫面
    planner-form.tsx        # 輸入區
    planner-results.tsx     # 即時結果
    timeline-view.tsx       # 時間線
    ai-diagnosis.tsx        # AI 診斷按鈕與結果
    theme-provider.tsx
    theme-toggle.tsx
    ui/                     # shadcn 元件
  lib/
    calculations.ts         # 純函式計算邏輯
    defaults.ts
    format.ts
    types.ts
```

## 計算說明

- UI 以「萬元」顯示，內部以「元」計算
- 一般房：目標自備款 = 總價 × (1 − 貸款成數)
- 預售屋：目標自備款 = 總價 × 初期自備比例
- 達標月數 = ceil(缺口 ÷ 每月新增)，並正確換算年月
