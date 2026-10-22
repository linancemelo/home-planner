#!/usr/bin/env python3
"""YOLO 分割標註（房間/牆/門/窗多邊形，無房型）＋人工看圖指定的房型 → 戶型範本（只留衍生幾何）。
用法：python3 scripts/build-templates-yolo.py <typemaps.json> [--debug dir]
typemaps.json：{ "<標註檔名>": { "<房間序號>": "bedroom|bathroom|living|kitchen|balcony", ... } }（未列的房間＝不用：走道、衣櫃、管道間…）
輸出併入 src/game/layout/templates.json（id = y01…，不留檔名、圖片）。"""
import json, os, sys, glob
import numpy as np
from PIL import Image, ImageDraw

ROOTS = ["/workspace/v12/ds", "/workspace/v10/ds"]
OPEN = {"living"}            # 彼此之間不砌牆的房型（客/餐/開放廚房）；走道（未標）也與它們開放
OUT = os.path.join(os.path.dirname(__file__), "..", "src", "game", "layout", "templates.json")

def load(name):
    for r in ROOTS:
        for sp in ("train", "val"):
            lf = f"{r}/labels/{sp}/{name}.txt"
            if os.path.exists(lf):
                im = glob.glob(f"{r}/images/{sp}/{name}.*")[0]
                w, h = Image.open(im).size
                objs = []
                for l in open(lf):
                    v = l.split()
                    if not v: continue
                    pts = [(float(v[i]) * w, float(v[i + 1]) * h) for i in range(1, len(v), 2)]
                    objs.append((int(v[0]), pts))
                return (w, h), objs
    raise FileNotFoundError(name)

def raster(shape, polys_vals):
    im = Image.new("I", shape, 0); d = ImageDraw.Draw(im)
    for pts, val in polys_vals: d.polygon(pts, fill=val)
    return np.array(im)

def dilate_labels(L, free, steps):
    """把房間標籤長進 free（True＝可長）格子，steps 次 4 鄰。"""
    L = L.copy()
    for _ in range(steps):
        grow = L.copy()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            sh = np.roll(np.roll(L, dy, 0), dx, 1)
            m = (grow == 0) & free & (sh != 0)
            grow[m] = sh[m]
        L = grow
    return L

def morph(mask, r, op):
    m = mask.copy()
    for _ in range(r):
        acc = m.copy()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            sh = np.roll(np.roll(m, dy, 0), dx, 1)
            acc = (acc & sh) if op == "erode" else (acc | sh)
        m = acc
    return m

def outline(mask):
    """二值格點 → 最大外框的直角多邊形（格點座標）。"""
    H, W = mask.shape
    edges = {}
    for y in range(H):
        for x in range(W):
            if not mask[y, x]: continue
            if y == 0 or not mask[y - 1, x]: edges[(x, y)] = (x + 1, y)
            if x == W - 1 or not mask[y, x + 1]: edges[(x + 1, y)] = (x + 1, y + 1) if (x + 1, y) not in edges else edges.get((x + 1, y))
    # 用通用方法：收集有向邊（內部在右手），再串成環
    E = []
    for y in range(H):
        for x in range(W):
            if not mask[y, x]: continue
            if y == 0 or not mask[y - 1, x]: E.append(((x, y), (x + 1, y)))
            if x == W - 1 or not mask[y, x + 1]: E.append(((x + 1, y), (x + 1, y + 1)))
            if y == H - 1 or not mask[y + 1, x]: E.append(((x + 1, y + 1), (x, y + 1)))
            if x == 0 or not mask[y, x - 1]: E.append(((x, y + 1), (x, y)))
    nxt = {}
    for a, b in E: nxt.setdefault(a, []).append(b)
    used = set(); loops = []
    for a, b in E:
        if (a, b) in used: continue
        loop = [a]; cur = (a, b)
        while cur not in used:
            used.add(cur); p, q = cur; loop.append(q)
            cands = [r for r in nxt.get(q, []) if (q, r) not in used]
            if not cands: break
            cur = (q, cands[0])
        loops.append(loop)
    def area(l): return abs(sum(l[i][0] * l[i + 1][1] - l[i + 1][0] * l[i][1] for i in range(len(l) - 1))) / 2
    best = max(loops, key=area)
    # 去掉共線點
    pts = best[:-1]; out = []
    for i, p in enumerate(pts):
        a, c = pts[i - 1], pts[(i + 1) % len(pts)]
        if (a[0] == p[0] == c[0]) or (a[1] == p[1] == c[1]): continue
        out.append(p)
    return out

def convert(name, tmap, tid, dbg=None):
    (w, h), objs = load(name)
    rooms = [pts for c, pts in objs if c == 0]
    doors = [pts for c, pts in objs if c == 2]
    wins = [pts for c, pts in objs if c == 3]
    walls_y = [pts for c, pts in objs if c == 1]
    # 人工補的門／窗（影像正規化座標矩形）
    rp = lambda r: [(r[0] * w, r[1] * h), (r[2] * w, r[1] * h), (r[2] * w, r[3] * h), (r[0] * w, r[3] * h)]
    # _nodoors：中心落在這些矩形內的標註門是錯的（看圖確認），拿掉
    inr = lambda pts, r: r[0] * w <= sum(p[0] for p in pts) / len(pts) <= r[2] * w and r[1] * h <= sum(p[1] for p in pts) / len(pts) <= r[3] * h
    doors = [d for d in doors if not any(inr(d, r) for r in tmap.get("_nodoors", []))]
    doors = [rp(r) for r in tmap.get("_doors", [])] + doors  # 人工的門優先（去重時保留）
    wins += [rp(r) for r in tmap.get("_windows", [])]
    keep = {int(k): v for k, v in tmap.items() if not k.startswith("_")}
    # 人工修正（看圖後補的）：_hall＝強制當室內走道的區域、_out＝強制當戶外的區域（影像正規化座標 [x0,y0,x1,y1]）
    fix_hall, fix_out = tmap.get("_hall", []), tmap.get("_out", [])
    if not doors: return None, "沒有門"
    # 尺度：門框長邊中位數 ≈ 850 mm
    dlen = sorted(max(max(p[0] for p in d) - min(p[0] for p in d), max(p[1] for p in d) - min(p[1] for p in d)) for d in doors)
    pxmm = dlen[len(dlen) // 2] / 850.0
    cell = max(2.0, 100 * pxmm)                  # 100 mm 一格
    xs = [p[0] for i in keep for p in rooms[i]]; ys = [p[1] for i in keep for p in rooms[i]]
    X0, Y0 = min(xs) - 15 * cell, min(ys) - 15 * cell
    GW, GH = int((max(xs) - X0) / cell + 15), int((max(ys) - Y0) / cell + 15)
    g = lambda pts: [((x - X0) / cell, (y - Y0) / cell) for x, y in pts]
    types = {k + 1: keep[i] for k, i in enumerate(sorted(keep))}
    order = sorted(keep)
    L = raster((GW, GH), [(g(rooms[i]), k + 1) for k, i in enumerate(order)])
    # 人工修正：_clip＝{房間序號: [x0,y0,x1,y1]}，房間標註超出實際範圍（例如把走道也框進去）時裁掉
    for ri, r in tmap.get("_clip", {}).items():
        k = order.index(int(ri)) + 1
        (ax0, ay0), (ax1, ay1) = g([(r[0] * w, r[1] * h), (r[2] * w, r[3] * h)])
        yy, xx = np.mgrid[0:GH, 0:GW]
        L[(L == k) & ~((xx >= ax0) & (xx < ax1) & (yy >= ay0) & (yy < ay1))] = 0
    wallm = raster((GW, GH), [(g(p), 1) for p in walls_y]) > 0
    # 清雜訊：每房先開運算（去細刺），再長進牆縫（最多 2.5 格＝250 mm 半牆厚）與未標示空間
    Lc = np.zeros_like(L)
    for k in range(1, len(order) + 1):
        m = morph(morph(L == k, 2, "erode"), 2, "dilate") & (L == k)
        Lc[m] = k
    # 未標示室內空間（走道）：不與外框相連的空白
    empty = (Lc == 0) & ~wallm
    outside = np.zeros_like(empty); outside[0, :] = outside[-1, :] = outside[:, 0] = outside[:, -1] = True
    outside &= empty
    for _ in range(GW + GH):
        n = outside | (morph(outside, 1, "dilate") & empty)
        if (n == outside).all(): break
        outside = n
    hall = empty & ~outside
    HALL = len(order) + 1
    Lc[hall] = HALL
    # 每房近似成矩形或 L 形，再把所有邊座標分群對齊（容差 300 mm）→ 乾淨的直角格局
    shapes = {}
    for k in range(1, len(order) + 1):
        m = Lc == k
        if m.sum() < 15: return None, f"房間 R{order[k-1]} 太小或被吃掉"
        yy, xx = np.nonzero(m); x0, x1, y0, y1 = xx.min(), xx.max() + 1, yy.min(), yy.max() + 1
        sub = m[y0:y1, x0:x1]; fill = sub.mean()
        rects = [(x0, y0, x1, y1)]
        if fill < 0.85:
            bh, bw = sub.shape; best = None
            for cy in (0, 1):
                for cx in (0, 1):
                    for hh in range(2, bh - 1):
                        for ww in range(2, bw - 1):
                            ys_ = slice(0, hh) if cy == 0 else slice(bh - hh, bh)
                            xs_ = slice(0, ww) if cx == 0 else slice(bw - ww, bw)
                            if sub[ys_, xs_].mean() < 0.12 and (best is None or hh * ww > best[0]): best = (hh * ww, cy, cx, hh, ww)
            if best and (sub.sum() / (sub.size - best[0])) > 0.8 and best[0] > 0.08 * sub.size:
                _, cy, cx, hh, ww = best
                # L 形 = 兩個矩形
                ey0, ey1 = (y0, y0 + hh) if cy == 0 else (y1 - hh, y1)
                ex0, ex1 = (x0, x0 + ww) if cx == 0 else (x1 - ww, x1)
                oy0, oy1 = (ey1, y1) if cy == 0 else (y0, ey0)
                rects = [(x0, oy0, x1, oy1), ((ex1, ey0, x1, ey1) if cx == 0 else (x0, ey0, ex0, ey1))]
            elif fill < 0.62: return None, f"房間 R{order[k-1]} 形狀太不規則（填滿率 {fill:.2f}）"
        shapes[k] = rects
    tol = 3.0
    def clusters(vals):
        vals = sorted(vals); groups = [[vals[0]]]
        for v in vals[1:]:
            if v - groups[-1][-1] <= tol: groups[-1].append(v)
            else: groups.append([v])
        mp = {}
        for gr in groups:
            mval = round(sum(gr) / len(gr))
            for v in gr: mp[v] = mval
        return mp
    mx = clusters([v for rs in shapes.values() for r in rs for v in (r[0], r[2])])
    my = clusters([v for rs in shapes.values() for r in rs for v in (r[1], r[3])])
    prio = {"living": 0, "balcony": 1, "kitchen": 2, "bedroom": 3, "bathroom": 4}
    F = np.zeros((GH, GW), dtype=np.int64)
    for k in sorted(shapes, key=lambda k: prio[types[k]]):
        for r in shapes[k]:
            F[my[r[1]]:my[r[3]], mx[r[0]]:mx[r[2]]] = k
    # 相鄰的客/餐/開放廚房合併成一個開放空間
    livs = [k for k in shapes if types[k] == "living"]
    if livs:
        for k in livs[1:]: F[F == k] = livs[0]
        for k in livs[1:]: del shapes[k]
    polys = {}
    for k in shapes:
        if (F == k).sum() < 15: return None, f"房間 R{order[k-1]} 被其他房間蓋掉"
        polys[k] = outline(F == k)
    # 走道：未被房間覆蓋、且不與外框相連的空間
    empty = F == 0
    outside = np.zeros_like(empty); outside[0, :] = outside[-1, :] = outside[:, 0] = outside[:, -1] = True
    outside &= empty
    for _ in range(GW + GH):
        n = outside | (morph(outside, 1, "dilate") & empty)
        if (n == outside).all(): break
        outside = n
    hall = (empty & ~outside) | (morph(morph(F > 0, 8, "dilate"), 8, "erode") & empty)
    # 深入外框內的狹長空白（深度 ≥ 2.5 m、開口 ≤ 1.6 m）視為走道，不是外牆凹口
    ys_, xs_ = np.nonzero(F > 0); bx0_, bx1_, by0_, by1_ = xs_.min(), xs_.max() + 1, ys_.min(), ys_.max() + 1
    inb = np.zeros_like(empty); inb[by0_:by1_, bx0_:bx1_] = True
    cand = empty & inb & ~hall
    seen_ = np.zeros_like(cand)
    for sy, sx in zip(*np.nonzero(cand)):
        if seen_[sy, sx]: continue
        comp = [(sy, sx)]; seen_[sy, sx] = True; q = [(sy, sx)]
        while q:
            y, x = q.pop()
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = y + dy, x + dx
                if by0_ <= ny < by1_ and bx0_ <= nx < bx1_ and cand[ny, nx] and not seen_[ny, nx]: seen_[ny, nx] = True; q.append((ny, nx)); comp.append((ny, nx))
        edge = sum(1 for y, x in comp if y in (by0_, by1_ - 1) or x in (bx0_, bx1_ - 1))
        if 0 < edge <= 16 and len(comp) / edge >= 25:
            for y, x in comp: hall[y, x] = True
    def rect_mask(rs):
        m = np.zeros_like(empty)
        for x0, y0, x1, y1 in rs:
            a, b_ = g([(x0 * w, y0 * h), (x1 * w, y1 * h)])
            m[max(0, int(round(a[1]))):max(0, int(round(b_[1]))), max(0, int(round(a[0]))):max(0, int(round(b_[0])))] = True
        return m
    hall = (hall | (rect_mask(fix_hall) & empty)) & ~rect_mask(fix_out)
    if fix_hall and os.environ.get("YDBG"): print(tid, "forced hall cells", int((rect_mask(fix_hall) & empty).sum()), "hall", int(hall.sum()))
    if tmap.get("_mergehall"):
        # 人工修正：與客廳相連的走道併進客廳多邊形（否則外圍走道邊的牆會被當成懸空牆）
        liv = [k for k in polys if types[k] == "living"]
        mh = tmap["_mergehall"]
        allow = rect_mask(mh) if isinstance(mh, list) else np.ones_like(hall)  # 可只併指定範圍內的走道
        if liv:
            comp = F == liv[0]; q = list(zip(*np.nonzero(comp)))
            while q:
                y, x = q.pop()
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < GH and 0 <= nx < GW and hall[ny, nx] and allow[ny, nx] and not comp[ny, nx]: comp[ny, nx] = True; q.append((ny, nx))
            F[comp] = liv[0]; hall &= ~comp; polys[liv[0]] = outline(F == liv[0])
    hallF = hall
    def lab(y, x):
        if y < 0 or x < 0 or y >= GH or x >= GW: return "out"
        v = F[y, x]
        if v: return v
        return "hall" if hallF[y, x] else "out"
    def kind(v): return "hall" if v == "hall" else "out" if v == "out" else types[v]
    def is_wall(a, b):
        if a == b: return False
        ka, kb = kind(a), kind(b)
        if {ka, kb} <= {"living", "hall"}: return False
        if ka == "out" and kb == "out": return False
        if "out" in (ka, kb) and "hall" in (ka, kb): return True
        return True
    # 牆：沿格線收集邊界單位邊 → 合併
    T = 150 * pxmm
    hseg = {}; vseg = {}
    for y in range(GH + 1):
        for x in range(GW):
            a, b = lab(y - 1, x), lab(y, x)
            if is_wall(a, b): hseg.setdefault(y, []).append(x)
    for x in range(GW + 1):
        for y in range(GH):
            a, b = lab(y, x - 1), lab(y, x)
            if is_wall(a, b): vseg.setdefault(x, []).append(y)
    P = lambda gx, gy: [round(gx * cell, 1), round(gy * cell, 1)]
    walls = []
    def runs(v):
        v = sorted(v); out = []; s = p = v[0]
        for q in v[1:]:
            if q == p + 1: p = q; continue
            out.append((s, p + 1)); s = p = q
        out.append((s, p + 1)); return out
    for y, v in hseg.items():
        for a, b in runs(v):
            if b - a >= 2: walls.append([round(a * cell, 1), round(y * cell, 1), round(b * cell, 1), round(y * cell, 1), round(T, 1)])
    for x, v in vseg.items():
        for a, b in runs(v):
            if b - a >= 2: walls.append([round(x * cell, 1), round(a * cell, 1), round(x * cell, 1), round(b * cell, 1), round(T, 1)])
    walls = [w if len(w) == 5 else w for w in walls]
    # 門：在框內找邊界最多的格線
    def best_line(bx0, by0, bx1, by1, pred):
        best = None
        for y in range(max(0, int(by0) - 2), min(GH, int(by1) + 3)):
            n = sum(1 for x in range(int(bx0), int(bx1) + 1) if 0 <= x < GW and pred(lab(y - 1, x), lab(y, x)))
            if n and (best is None or n > best[0]): best = (n, "h", y)
        for x in range(max(0, int(bx0) - 2), min(GW, int(bx1) + 3)):
            n = sum(1 for y in range(int(by0), int(by1) + 1) if 0 <= y < GH and pred(lab(y, x - 1), lab(y, x)))
            if n and (best is None or n > best[0]): best = (n, "v", x)
        return best
    out_doors = []; entry_done = False
    for i, d in enumerate(doors):
        gp = g(d); bx0, by0 = min(p[0] for p in gp), min(p[1] for p in gp); bx1, by1 = max(p[0] for p in gp), max(p[1] for p in gp)
        bl = best_line(bx0, by0, bx1, by1, lambda a, b: a != b and is_wall(a, b))
        if not bl or bl[0] < 3: continue
        _, ax, c = bl
        if ax == "h": a, b = max(bx0, 0), min(bx1, GW); seg = [a, c, b, c]; sides = (lab(c - 1, int((a + b) / 2)), lab(c, int((a + b) / 2)))
        else: a, b = max(by0, 0), min(by1, GH); seg = [c, a, c, b]; sides = (lab(int((a + b) / 2), c - 1), lab(int((a + b) / 2), c))
        if b - a < 5: continue
        cx = sum(p[0] for p in gp) / len(gp); cy = sum(p[1] for p in gp) / len(gp)
        ends = [(seg[0], seg[1]), (seg[2], seg[3])]
        hinge = min(ends, key=lambda e: (e[0] - cx) ** 2 + (e[1] - cy) ** 2)
        ks = {kind(sides[0]), kind(sides[1])}
        name = "大門" if ("out" in ks and not entry_done and ks & {"living", "hall"}) else f"門{i}"
        if name == "大門": entry_done = True
        elif "out" in ks: continue  # 其他通室外的門不用
        out_doors.append({"name": name, "opening": [round(v * cell, 1) for v in seg], "box": [round(bx0 * cell, 1), round(by0 * cell, 1), round(bx1 * cell, 1), round(by1 * cell, 1)], "hinge": [round(hinge[0] * cell, 1), round(hinge[1] * cell, 1)]})
    if not entry_done:
        # 後備：離「客廳／走道 ↔ 室外」邊界最近的門框，就地在該邊界開大門
        best = None
        for i, d in enumerate(doors):
            gp = g(d); bx0, by0 = min(p[0] for p in gp), min(p[1] for p in gp); bx1, by1 = max(p[0] for p in gp), max(p[1] for p in gp)
            ex = lambda a, b: "out" in (kind(a), kind(b)) and ({kind(a), kind(b)} & {"living", "hall"}) and a != b
            bl = best_line(bx0 - 4, by0 - 4, bx1 + 4, by1 + 4, ex)
            if bl and bl[0] >= 6 and (best is None or bl[0] > best[0][0]): best = (bl, (bx0, by0, bx1, by1))
        if not best: return None, "找不到通室外的大門"
        (_, ax, c), (bx0, by0, bx1, by1) = best
        L_ = 10.0
        if ax == "h":
            xs_ = [x for x in range(int(bx0) - 4, int(bx1) + 5) if 0 <= x < GW and lab(c - 1, x) != lab(c, x) and "out" in (kind(lab(c - 1, x)), kind(lab(c, x)))]
            m_ = (min(xs_) + max(xs_) + 1) / 2; seg = [m_ - L_ / 2, c, m_ + L_ / 2, c]
        else:
            ys_ = [y for y in range(int(by0) - 4, int(by1) + 5) if 0 <= y < GH and lab(y, c - 1) != lab(y, c) and "out" in (kind(lab(y, c - 1)), kind(lab(y, c)))]
            m_ = (min(ys_) + max(ys_) + 1) / 2; seg = [c, m_ - L_ / 2, c, m_ + L_ / 2]
        out_doors.insert(0, {"name": "大門", "opening": [round(v * cell, 1) for v in seg], "box": [], "hinge": [round(seg[0] * cell, 1), round(seg[1] * cell, 1)]})
    out_wins = []
    for i, wpts in enumerate(wins):
        gp = g(wpts); bx0, by0 = min(p[0] for p in gp), min(p[1] for p in gp); bx1, by1 = max(p[0] for p in gp), max(p[1] for p in gp)
        bl = best_line(bx0, by0, bx1, by1, lambda a, b: "out" in (kind(a), kind(b)) and a != b and not ({kind(a), kind(b)} <= {"out", "hall"}))
        if not bl or bl[0] < 4: continue
        _, ax, c = bl
        # 一扇窗跨過兩間房（標註常把相鄰房間的窗連成一條）→ 依室內側的房間切開
        lo, hi = (bx0, bx1) if ax == "h" else (by0, by1)
        runs, cur = [], None
        for u in range(int(lo), int(hi) + 1):
            a_, b_ = (lab(c - 1, u), lab(c, u)) if ax == "h" else (lab(u, c - 1), lab(u, c))
            inside = a_ if kind(a_) != "out" else b_
            if cur and cur[0] == inside: cur[2] = u + 1
            else: cur = [inside, u, u + 1]; runs.append(cur)
        parts = [(max(lo, r[1]), min(hi, r[2])) for r in runs if kind(r[0]) != "out" and r[2] - r[1] >= 4] or [(lo, hi)]
        for j, (p0, p1) in enumerate(parts):
            seg = [p0, c, p1, c] if ax == "h" else [c, p0, c, p1]
            out_wins.append({"name": f"窗{i}" + (f"-{j}" if j else ""), "seg": [round(v * cell, 1) for v in seg]})
    # 補：沒偵測到門的房間（標註漏標）→ 在與走道／客廳（浴室可對臥室）共用最長的邊中央補門；臥室／廚房沒窗 → 在最長外牆補窗
    def touches(seg, k):
        x0, y0, x1, y1 = [v / cell for v in seg]; mx_, my_ = int((x0 + x1) / 2), int((y0 + y1) / 2)
        return k in ((lab(round(y0) - 1, mx_), lab(round(y0), mx_)) if abs(y0 - y1) < 1e-6 else (lab(my_, round(x0) - 1), lab(my_, round(x0))))
    def shared_any(k1, other):
        best = None
        for y in range(1, GH):
            v = [x for x in range(GW) if {lab(y - 1, x), lab(y, x)} == {k1, other}]
            if v:
                for a, b in runs(v):
                    if b - a >= 6 and (best is None or b - a > best[0]): best = (b - a, "h", y, a, b)
        for x in range(1, GW):
            v = [y for y in range(GH) if {lab(y, x - 1), lab(y, x)} == {k1, other}]
            if v:
                for a, b in runs(v):
                    if b - a >= 6 and (best is None or b - a > best[0]): best = (b - a, "v", x, a, b)
        return best
    def runs(v):
        v = sorted(v); out = []; s0 = p0 = v[0]
        for q in v[1:]:
            if q == p0 + 1: p0 = q; continue
            out.append((s0, p0 + 1)); s0 = p0 = q
        out.append((s0, p0 + 1)); return out
    def ov(a, b, pad):
        ha, hb = abs(a[1] - a[3]) < 1e-6, abs(b[1] - b[3]) < 1e-6
        if ha != hb: return False
        ca, cb = (a[1], b[1]) if ha else (a[0], b[0])
        if abs(ca - cb) > 2.5 * cell: return False
        a0, a1 = sorted((a[0], a[2]) if ha else (a[1], a[3])); b0, b1 = sorted((b[0], b[2]) if hb else (b[1], b[3]))
        return a0 < b1 + pad and b0 < a1 + pad
    def door_sides(seg):
        x0, y0, x1, y1 = [v / cell for v in seg]; mx_, my_ = int((x0 + x1) / 2), int((y0 + y1) / 2)
        return (lab(round(y0) - 1, mx_), lab(round(y0), mx_)) if abs(y0 - y1) < 1e-6 else (lab(my_, round(x0) - 1), lab(my_, round(x0)))
    def reached():
        seen = {"hall"} | {k for k in polys if types[k] == "living"}
        ch = True
        while ch:
            ch = False
            for d in out_doors:
                a_, b_ = door_sides(d["opening"])
                if (a_ in seen) != (b_ in seen) and "out" not in (a_, b_): seen |= {a_, b_}; ch = True
        return seen
    for _ in range(len(polys)):
        R_ = reached()
        todo = [k for k in polys if types[k] not in ("living", "balcony") and k not in R_]
        if not todo: break
        k = todo[0]; t_ = types[k]
        cands = ["hall"] + [kk for kk in polys if types[kk] == "living"] + ([kk for kk in polys if kk in R_ and types[kk] == "bedroom"] if t_ == "bathroom" else [])
        sh = None
        for o in cands:
            sh = shared_any(k, o)
            if sh and sh[0] >= 9: break
            sh = None
        if not sh: return None, f"房間 R{order[k-1]} 沒有門，也找不到可補門的邊"
        _, ax, c, a, b = sh; L_ = 7.5 if t_ == "bathroom" else 8.5; seg = None
        a2 = a + 0.6
        while a2 + L_ <= b - 0.4:
            cand = [a2, c, a2 + L_, c] if ax == "h" else [c, a2, c, a2 + L_]
            cs = [v * cell for v in cand]
            if not any(ov(cs, e["opening"], 1.5 * cell) for e in out_doors) and not any(ov(cs, w["seg"], 1.5 * cell) for w in out_wins): seg = cand; break
            a2 += 1
        if seg is None: return None, f"房間 R{order[k-1]} 補門位置都被其他開口占用"
        out_doors.append({"name": f"補門{k}", "opening": [round(v * cell, 1) for v in seg], "box": [], "hinge": [round(seg[0] * cell, 1), round(seg[1] * cell, 1)]})
    for k in polys:
        if types[k] not in ("bedroom", "kitchen") or any(touches(w["seg"], k) for w in out_wins): continue
        sh = shared_any(k, "out")
        if not sh: return None, f"房間 R{order[k-1]} 沒有外牆可開窗"
        _, ax, c, a, b = sh; L_ = min(b - a - 3, 15 if types[k] == "bedroom" else 9); m_ = (a + b) / 2
        seg = [m_ - L_ / 2, c, m_ + L_ / 2, c] if ax == "h" else [c, m_ - L_ / 2, c, m_ + L_ / 2]
        out_wins.append({"name": f"補窗{k}", "seg": [round(v * cell, 1) for v in seg]})

    # 補：陽台與客廳相鄰卻沒開口 → 落地窗；只與臥室/廚房相鄰 → 門
    def shared(k1, k2):
        best = None
        for y in range(1, GH):
            v = [x for x in range(GW) if {lab(y - 1, x), lab(y, x)} == {k1, k2}]
            if len(v) >= 6 and (best is None or len(v) > best[0]): best = (len(v), "h", y, min(v), max(v) + 1)
        for x in range(1, GW):
            v = [y for y in range(GH) if {lab(y, x - 1), lab(y, x)} == {k1, k2}]
            if len(v) >= 6 and (best is None or len(v) > best[0]): best = (len(v), "v", x, min(v), max(v) + 1)
        return best
    def seg_of(s, maxlen):
        _, ax, c, a, b = s; m = (a + b) / 2; half = min(b - a - 2, maxlen) / 2
        return [m - half, c, m + half, c] if ax == "h" else [c, m - half, c, m + half]
    room_names = {}
    for k in polys:
        t = types[k]
        if t != "balcony": continue
        nbrs = {kk: shared(k, kk) for kk in polys if kk != k}
        nbrs = {kk: s for kk, s in nbrs.items() if s}
        liv = [kk for kk in nbrs if types[kk] == "living"]
        if liv:
            out_wins.append({"name": f"落地窗{k}", "seg": [round(v * cell, 1) for v in seg_of(nbrs[liv[0]], 24 * 1.0 * (100 / 100) * 10)]})
        else:
            other = [kk for kk in nbrs if types[kk] in ("kitchen", "bedroom")]
            if not other: return None, f"陽台 R{order[k-1]} 沒有相鄰的客廳/廚房/臥室"
            s = seg_of(nbrs[other[0]], 8.5)
            out_doors.append({"name": f"陽台門{k}", "opening": [round(v * cell, 1) for v in s], "box": [], "hinge": [round(s[0] * cell, 1), round(s[1] * cell, 1)]})
        room_names[k] = "工作陽台" if any(types[kk] == "kitchen" for kk in nbrs) else "陽台"
    # 沒陽台 → 在客廳最長的外牆外加一個工作陽台（1.3 m 深、≤3 m 寬），用落地窗連通
    if "balcony" not in types.values():
        lk = [k for k in polys if types[k] == "living"]
        best = None
        for k in lk:
            for y in range(1, GH):
                for side in (-1, 1):
                    v = [x for x in range(GW) if F[y - 1 if side < 0 else y, x] == k and lab(y if side < 0 else y - 1, x) == "out"]
                    if len(v) >= 15 and (best is None or len(v) > best[0]): best = (len(v), "h", y, min(v), max(v) + 1, side, k)
            for x in range(1, GW):
                for side in (-1, 1):
                    v = [y for y in range(GH) if F[y, x - 1 if side < 0 else x] == k and lab(y, x if side < 0 else x - 1) == "out"]
                    if len(v) >= 15 and (best is None or len(v) > best[0]): best = (len(v), "v", x, min(v), max(v) + 1, side, k)
        if not best: return None, "沒有陽台，客廳也沒有夠長的外牆可加"
        _, ax, c, a, b, side, k = best
        # 不可壓到大門
        L2 = min(30, b - a); m = (a + b) / 2; a2, b2 = m - L2 / 2, m + L2 / 2
        dep = 13 * (1 if side > 0 else -1)
        # side>0：房間在格線之後（y 或 x 較大）→ 陽台往外（較小）方向
        dep = -13 if side > 0 else 13
        poly = [(a2, c), (b2, c), (b2, c + dep), (a2, c + dep)] if ax == "h" else [(c, a2), (c, b2), (c + dep, b2), (c + dep, a2)]
        nk = max(types) + 1; polys[nk] = poly; types[nk] = "balcony"; room_names[nk] = "工作陽台"
        s = [a2 + 2, c, b2 - 2, c] if ax == "h" else [c, a2 + 2, c, b2 - 2]
        out_wins.append({"name": "落地窗（加建工作陽台）", "seg": [round(v * cell, 1) for v in s]})
        walls.append([round(v * cell, 1) for v in ([a2, c, b2, c] if ax == "h" else [c, a2, c, b2])] + [round(T, 1)])
        added = True
    dd = []
    for d in sorted(out_doors, key=lambda d: d["name"] != "大門"):
        if not any(ov(d["opening"], e["opening"], 1.5 * cell) for e in dd): dd.append(d)
    out_doors = dd
    ww = []
    for w in out_wins:
        if not any(ov(w["seg"], e["opening"], 1.5 * cell) for e in out_doors) and not any(ov(w["seg"], e["seg"], 1.5 * cell) for e in ww): ww.append(w)
    out_wins = ww
    zh = {"bedroom": "臥室", "bathroom": "浴室", "living": "客餐廳", "kitchen": "廚房", "balcony": "陽台"}
    t = {"id": tid, "rooms": [{"name": room_names.get(k, zh[types[k]]), "type": types[k], "poly": [[round(x * cell, 1), round(y * cell, 1)] for x, y in polys[k]]} for k in sorted(polys)],
         "walls": walls, "doors": out_doors, "windows": out_wins}
    # 室內走道（未標示、沒併進客廳的部分）：給實例化判斷「牆是否懸空」用
    hl = []
    seen_h = np.zeros_like(hallF)
    for sy, sx in zip(*np.nonzero(hallF)):
        if seen_h[sy, sx]: continue
        comp = np.zeros_like(hallF); comp[sy, sx] = True; seen_h[sy, sx] = True; q = [(sy, sx)]; n_ = 1
        while q:
            y, x = q.pop()
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < GH and 0 <= nx < GW and hallF[ny, nx] and not seen_h[ny, nx]: seen_h[ny, nx] = comp[ny, nx] = True; q.append((ny, nx)); n_ += 1
        if n_ >= 15: hl.append([[round(x * cell, 1), round(y * cell, 1)] for x, y in outline(comp)])
    if hl: t["halls"] = hl
    if dbg: draw_debug(t, f"{dbg}/{tid}.png")
    return t, None

def draw_debug(t, path):
    xs = [p[0] for r in t["rooms"] for p in r["poly"]]; ys = [p[1] for r in t["rooms"] for p in r["poly"]]
    s = 700 / max(max(xs), max(ys)); im = Image.new("RGB", (int(max(xs) * s) + 40, int(max(ys) * s) + 40), "white"); d = ImageDraw.Draw(im)
    C = {"bedroom": (200, 220, 255), "bathroom": (200, 240, 230), "living": (255, 230, 200), "kitchen": (255, 200, 200), "balcony": (225, 225, 225)}
    for r in t["rooms"]:
        d.polygon([(x * s + 20, y * s + 20) for x, y in r["poly"]], fill=C[r["type"]], outline=(120, 120, 120))
    for w in t["walls"]: d.line([(w[0] * s + 20, w[1] * s + 20), (w[2] * s + 20, w[3] * s + 20)], fill=(0, 0, 0), width=4)
    for w in t["windows"]: d.line([(v * s + 20) for v in w["seg"]], fill=(30, 140, 255), width=6)
    for x in t["doors"]: d.line([(v * s + 20) for v in x["opening"]], fill=(255, 0, 0) if x["name"] == "大門" else (255, 150, 0), width=6)
    im.save(path)

if __name__ == "__main__":
    tm = json.load(open(sys.argv[1])); dbg = sys.argv[3] if len(sys.argv) > 3 and sys.argv[2] == "--debug" else None
    data = json.load(open(OUT))
    data["templates"] = [t for t in data["templates"] if not t["id"].startswith("y")]
    data["skipped"] = [s for s in data["skipped"] if not s["id"].startswith("y")]
    n = 0
    for i, (name, m) in enumerate(tm.items()):
        tid = f"y{i + 1:02d}"
        try: t, why = convert(name, m, tid, dbg)
        except Exception as e: t, why = None, f"轉換失敗：{e}"
        if t: data["templates"].append(t); n += 1
        else: data["skipped"].append({"id": tid, "reason": why})
        print(tid, "ok" if t else "skip: " + why)
    json.dump(data, open(OUT, "w"), ensure_ascii=False, separators=(",", ":"))
    print(f"{n} YOLO 範本加入；templates.json 共 {len(data['templates'])} 個")
