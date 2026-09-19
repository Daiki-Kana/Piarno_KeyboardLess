# 【徹底究明】指先マーカー飛び・隣指吸着の根本原因分析と完全解決仕様書

## 1. エグゼクティブサマリー（なぜ直らなかったのか）

全ファイルのコードをMediaPipeの入力からCanvas描画まで1行ずつ追跡した結果、**これまで施した対策が画面上に1ミリも反映されていなかった決定的なバグ**を含め、以下の4つの根本原因を特定しました。

---

## 2. 根本原因の技術的詳細

### 原因 1（致命的バグ）: ホログラム描画に「平滑化前の生（RAW）座標」がそのまま渡されていた
- **問題のコード箇所 (`src/main.ts`)**:
  ```typescript
  // 1. processHandsAndDetectTaps で平滑化されたのは hand.fingertips のみ
  const smoothedHands = processHandsAndDetectTaps(rawHands, now);

  // 2. renderTracking に smoothedHands が渡されるが…
  function renderTracking(hands: HandData[], currentTimestamp: number) {
    const landmarksMap = new Map<string, { x: number; y: number }[]>();
    hands.forEach((hand) => {
      landmarksMap.set(
        hand.handedness,
        hand.allLandmarks.map((lm) => ({ x: lm.x, y: lm.y })) // ★ここがMediaPipe生のまま★
      );
    });
    hologramEffect.render(canvasCtx, landmarksMap);
  }
  ```
- **何が起きていたか**:
  - `src/main.ts` において、`OneEuroFilter3D`（beta: 1.5）や生座標変位リミッター（0.08クランプ）を適用した `smoothedFingertips` は、**打鍵判定エンジン（`tapDetector`）にしか渡されていませんでした**。
  - 画面描画を担当する `hologramEffect.render` には、MediaPipeから取得した **未処理の生ランドマーク（`hand.allLandmarks`）がそのまま渡されていた** ため、いくらフィルターやリミッターを調整しても、画面に映るターゲット指マーカー（水色/緑/黄色のリング）は **100% 生のMediaPipe出力のまま激しくワープし続けていました**。

---

### 原因 2: 生変位リミッター（上限0.08）が隣指間距離（0.035〜0.06）に対して甘すぎた
- **問題のコード箇所 (`src/main.ts`)**:
  ```typescript
  const MAX_RAW_DISPLACEMENT_PER_FRAME = 0.08;
  ```
- **何が起きていたか**:
  - 人間の手の構造上、中指と人差し指、または中指と薬指の先端同士の距離は、画面正規化座標系（画面幅基準）で **わずか 0.035 〜 0.060 程度** しかありません。
  - 机に触れた瞬間にMediaPipeが隣指へ吸着する際、1フレームのワープ量は `0.04〜0.05` 程度です。
  - そのため、上限値 `0.08` のリミッターでは **「隣指への吸着ワープ」が正常な移動範囲とみなされ、完全にノーガードで素通り** していました。

---

### 原因 3: MediaPipeの「机面接地オクルージョン（隠蔽）」と「局所的吸着（Snapping）」
- **メカニズム**:
  1. **指腹の平坦化とコントラスト喪失**:
     指先が机に衝突すると、肉が潰れて平らになり、机の木目や自身の影と一体化します。
     単眼RGBディープラーニングモデル（HandLandmarker）は、指先の終端エッジ（輪郭境界）を見失います。
  2. **空間アテンションの隣指引き寄せ**:
     ターゲット指の先端を見失ったネットワークは、空中でくっきり輪郭が見えている「隣の浮いている指先（人差し指や薬指）」にアテンションを引き寄せられ、中指先端ランドマーク（#12）を人差し指先端（#8）と同一点として出力します。
  3. **幾何学的特異点**:
     この吸着が発生した瞬間、**「中指先端と隣指先端の距離がゼロに近づく（0.025以下になる）」** という、解剖学的にあり得ない現象が発生します。

---

### 原因 4: 異常値検知時の前フレーム位置更新によるデッドロック（吸着先への固定）
- **問題のコード箇所 (`src/main.ts`)**:
  ```typescript
  if (lastTargetTipPos) {
    const dx = Math.abs(tip.x - lastTargetTipPos.x);
    if (dx > 0.07) {
      isMarkerJump = true; // 打鍵判定をスキップするだけ
    }
  }
  // ★異常値であっても次フレーム用に現在位置で無条件更新★
  lastTargetTipPos = { x: tip.x, y: tip.y };
  ```
- **何が起きていたか**:
  - `dx > 0.07` を検知しても、打鍵判定をスキップするだけで、マーカー座標そのものは異常値のまま受け入れていました。
  - さらに、異常なワープ先（隣指の位置）をそのまま `lastTargetTipPos` に記憶したため、次フレームでは「隣指の位置が正常な現在位置」とみなされ、ワープ先の位置に固定されてしまっていました。

---

## 3. 完全解決アーキテクチャ（多層防御パイプライン）

本問題を完全に根絶するため、以下の5層からなる強固な防御アーキテクチャを実装します。

```
[MediaPipe 生ランドマーク]
        │
        ▼
【Layer 1: 解剖学的・隣指排他クランプ (Inter-Finger Proximity Clamp)】
        │ ターゲット指と隣指の距離を計算。
        │ 物理的限界距離（< 0.032）未満への接近（吸着）を検知した場合、
        │ 座標を直前の正常位置に強制拘束。
        ▼
【Layer 2: 物理的限界速度リミッター (厳格クランプ)】
        │ 1フレームあたりの最大変位上限を 0.08 から 0.040 へ引き下げ。
        ▼
【Layer 3: 1 Euro Filter 3D (周波数平滑化)】
        │ beta: 1.5 で高周波振動ノイズを遮断。
        ▼
【Layer 4: 接地インパクトロック (Impact Clamping)】
        │ 打鍵判定成功瞬間〜直後40ms間、指先座標をインパクト位置に固定。
        ▼
【Layer 5: 描画パイプライン完全同期 (★最重要★)】
        │ 平滑化・拘束されたクリーンな座標を allLandmarks に上書きし、
        │ hologramEffect.render へ直接渡す。
```

---

## 4. 具体的な実装設計

### 4.1 描画パイプラインへの平滑化座標同期 (`src/main.ts`)
```typescript
// allLandmarks の指先ランドマーク（4, 8, 12, 16, 20）を平滑化座標で上書き
smoothedFingertips.forEach((tip) => {
  if (hand.allLandmarks[tip.tipIndex]) {
    hand.allLandmarks[tip.tipIndex] = { x: tip.x, y: tip.y, z: tip.z };
  }
});

// hologramEffect へ平滑化済み座標を渡す
const landmarksMap = new Map<string, { x: number; y: number }[]>();
hands.forEach((hand) => {
  landmarksMap.set(
    hand.handedness,
    hand.allLandmarks.map((lm) => ({ x: lm.x, y: lm.y }))
  );
});
hologramEffect.render(canvasCtx, landmarksMap);
```

### 4.2 隣指排他クランプ（Inter-Finger Proximity Clamp）
- 中指（12）がターゲットの場合、人差し指（8）および薬指（16）とのユークリッド距離を計算。
- `distance(tip12, tip8) < 0.032` または `distance(tip12, tip16) < 0.032` の場合:
  - 隣指への吸着と判定。
  - 吸着した方向への座標更新を拒否し、直前の正常位置（`lastSafePos`）を維持。

### 4.3 生座標レートリミッターの厳格化
- `MAX_RAW_DISPLACEMENT_PER_FRAME` を `0.040`（画面幅の4%）に設定。
- これにより、指の振り下ろし（垂直方向 0.03 程度）はスムーズに通し、瞬間ワープ（0.045以上）を物理的に遮断。

### 4.4 接地インパクト時の座標ロック
- 打鍵検知直後 40ms は、机面上でのオクルージョンが最も激しい瞬間。
- この間、ターゲット指マーカーの座標をインパクト瞬間の座標にロックして描画する。

---

## 5. 推奨作業手順

1. **`src/main.ts` の描画データ受け渡し修正**: 平滑化済み指先座標を `allLandmarks` に同期し、Canvas描画が平滑化されることを確認。
2. **隣指排他クランプの実装**: 中指・人差指・薬指の近接距離ガードを挿入。
3. **生座標リミッターの厳格化**: 最大変位を 0.040 に最適化。
4. **ビルド検証**: `npm run build` を実行し、型エラーがないことを確認。

不明な点がある場合は必ず質問してください。
