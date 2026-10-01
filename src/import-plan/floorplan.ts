/** 平面圖 v1。單位為公尺。座標預設原點在圖面左下。 */

export type Vec2 = { x: number; y: number }

export type Floorplan = {
  version: 1
  meta: {
    sourceName: string
    imageWidthPx: number
    imageHeightPx: number
    metersPerPixel: number
    scaleTrusted: false
    coordinateOrigin: "bottom-left" | "top-left"
    ceilingHeightM: number
    ceilingHeightAssumed: true
    detectionConfidence?: number
    notes?: string[]
  }
  walls: Wall[]
  doors: Door[]
  windows: Window[]
}

export type Wall = {
  id: string
  a: Vec2
  b: Vec2
  thicknessM: number
  thicknessAssumed?: boolean
  heightM?: number
}

export type Door = {
  id: string
  kind: "swing" | "sliding"
  wallId: string
  opening: { a: Vec2; b: Vec2 }
  confidence?: number
  swing?: {
    hinge: Vec2
    leafLengthM: number
    openDirection: "cw" | "ccw"
    arcQuarter: true
  }
  sliding?: {
    leafA: { a: Vec2; b: Vec2 }
    leafB: { a: Vec2; b: Vec2 }
  }
}

export type Window = {
  id: string
  wallId: string
  opening: { a: Vec2; b: Vec2 }
  confidence?: number
  sillHeightM?: number
  sillHeightAssumed?: boolean
}

/** 疊圖用。挖除段不寫進 Floorplan，避免日後被當成連續牆。 */
export type Excavation = {
  a: Vec2
  b: Vec2
  kind: "door" | "window"
}
