# ターゲット切り替え時におけるマーカー消失およびジッタリングのコード調査報告書

## 1. エグゼクティブサマリー

本調査では、Webカメラを用いた非接触ピアノ演奏（Piarno）において報告されている**「打鍵直後に次の指が指定された瞬間にマーカーが一瞬消失する現象」**および**「切り替え直後の激しいジッタリング」**について、`src/main.ts`, `src/hologramEffect.ts`, `src/oneEuroFilter.ts`, `src/tapDetector.ts` を対象に徹底的なコード追跡・静的解析を行いました。

その結果、以下の決定的な原因を特定しました。

1. **【マーカー消失の主因】打鍵成功白フラッシュの完全喪失バグ**:
   打鍵検知フレーム内で即座に `currentTarget` が新指へ更新されるため、旧指の打鍵成功白フラッシュ（100ms）描画条件 `tip.tipIndex === currentTarget.tipIndex` が不一致となり、**白フラッシュが1フレームも描画されずに即座に破棄されている**。これにより、旧指のマーカーが打鍵瞬間に忽然と消え失せる「視覚的空白」が発生している。
2. **【ジッタリングの主因】非ターゲット指に対するキネマティクス復元の未適用ギャップ**:
   骨格キネマティクスによる隣指吸着復元が `isTarget`（現ターゲット指）限定で実行されているため、新指は指定される直前フレームまで吸着やブレを許容された状態にある。新指に指定された瞬間に初めてキネマティクス復元が発動して座標がジャンプし、その急変が 1 Euro Filter に入力されて速度履歴 $\hat{\dot{x}}$ とカットオフ周波数 $f_c$ を跳ね上げ、ノイズを素通しさせている。
3. **【変位リミッターと状態管理の整合性】**:
   現在、1 Euro Filter は全指ごとに独立したインスタンスが割り当てられているが、打鍵判定ループの途中で `currentTarget` が書き換わる非対称なループ進行が存在し、同一フレーム内で新旧指の参照ステートに歪みが生じている。

---

## 2. 調査項目 1: ターゲット切り替え時の直前座標の扱い (`src/main.ts`)

### 2.1 調査対象
- ターゲット指が更新されたフレームで、直前座標（`lastSafeTargetPos`, `lastTargetTipPos` など）がどのように更新・参照されているか。
- 旧ターゲット指の座標と新ターゲット指の座標が直接比較され、変位リミッター（0.040や0.08等の閾値）に誤って引っかかって座標更新・描画がスキップされていないか。

### 2.2 該当コード箇所の分析

#### (1) 変位リミッターと直前座標の現状 (`src/main.ts`)
過去のバージョン（`marker_jump_root_cause_report.md` 参照）に存在した、単一のグローバル変数 `lastTargetTipPos` を用いた「ターゲット指の生座標変位判定」は、直前のリファクタリングによって削除され、骨格キネマティクス復元（`FINGER_KINEMATICS`）へ置換されています。

しかし、`src/tapDetector.ts` には以下の変位リミッターが存在します。

```typescript
// src/tapDetector.ts: 204-217行目
// 指先単位の異常跳躍クリッピング（物理移動量ガード: 1フレームで画面高8%超のワープを遮断）
const dy = Math.abs(y - state.lastY);
if (dy > this.maxDisplacementPerFrame) {
  state.lastTime = timestamp;
  state.lastY = y;
  state.lastVy = 0;
  state.currentVy = 0;
  state.currentAy = 0;
  state.prevVy = 0;
  state.lastComputedTime = timestamp;
  state.lastActiveDownTime = -9999;
  state.maxActiveDownVy = 0;
  return null;
}
```

- **状態管理の実態**:
  `tapDetector.ts` において、`state` は `key = ${handedness}_${tipIndex}`（指番号単位）で個別に管理されています。
  したがって、**新指と旧指の座標が直接比較されて変位リミッターに引っかかる構造にはなっていません**。

#### (2) ターゲット切り替えタイミングとループ内の非対称性 (`src/main.ts: 519-586行目`)
極めて注意すべき問題点として、**打鍵検知ループの実行中に `currentTarget` がインラインで書き換わっている点** が挙げられます。

```typescript
// src/main.ts: 519-586行目
for (const tip of smoothedFingertips) {
  const isTargetFinger = isTargetHand && tip.tipIndex === currentTarget.tipIndex;

  // ターゲット以外の指は打鍵判定を完全にスキップ
  if (!isTargetFinger) {
    continue;
  }
  ...
  if (canEvaluateTap) {
    const tapEvent: TapEvent | null = tapDetector.processFingertip(...);
    if (tapEvent) {
      noteTriggeredInThisFrame = true;

      // 接地インパクトロック（40ms間、この瞬間の座標に固定）
      impactLock = {
        hand: resolvedHandedness,
        tipIndex: tip.tipIndex,
        pos: { x: tip.x, y: tip.y, z: tip.z },
        expiresAt: timestamp + 40,
      };
      ...
      // シーケンサーを1音前進
      const { nextNote } = sequencer.advance();

      // 次のターゲット指を決定 (右手固定ポジション)
      currentTarget = positionManager.assignTargetFinger(nextNote);

      // シーケンス進行UIを即座に更新
      updateSequenceUI();
    }
  }
}
```

- **何が起きているか**:
  - `smoothedFingertips` 配列は `[4, 8, 12, 16, 20]` のインデックス順にループされます。
  - 例えば旧ターゲット指が「人差し指（8）」のときに打鍵が成立すると、同一ループの途中で `currentTarget` が「中指（12）」へ即座に更新されます。
  - ループが次に `tipIndex: 12` に達した際、`isTargetFinger` は `true` と評価されます（`noteTriggeredInThisFrame` により二重発火は抑止されるものの、同一フレームでステートが非対称に変遷します）。
  - 逆に旧ターゲット指が「中指（12）」で、次が「人差し指（8）」だった場合は、人差し指の処理は既に終了しているため同一フレーム内での遭遇は起きません。
  - このようなループ途中でのグローバル状態の変更が、フレーム内でのデータ不整合を誘発しています。

#### (3) 接地インパクトロック（`impactLock`）の扱い (`src/main.ts: 492-504行目`)
```typescript
// 接地インパクト時の短尺座標ロック (40ms: 打鍵成立瞬間の座標に完全固定)
if (
  impactLock &&
  impactLock.hand === resolvedHandedness &&
  impactLock.tipIndex === tip.tipIndex &&
  timestamp < impactLock.expiresAt
) {
  smoothed = {
    x: impactLock.pos.x,
    y: impactLock.pos.y,
    z: impactLock.pos.z,
  };
}
```
- `impactLock` は `tipIndex` を保持しており、打鍵した旧指に対して適用されます。
- そのため、新指が別の指先である場合は、新指の座標がロックされることはありません。
- ただし、同一指の連続打鍵（例: 中指の連続打鍵）の際は、次の打鍵の最初の40ms間が旧打鍵位置に拘束される挙動となります。

---

## 3. 調査項目 2: 1 Euro Filter のインスタンス・状態管理

### 3.1 調査対象
- 1 Euro Filter は指ごと（各ランドマークごと）に独立したインスタンスが割り当てられているか、それとも単一インスタンスを使い回しているか。
- ターゲット切り替え時に速度履歴（$\hat{\dot{x}}$）がリセットされず、旧指から新指への瞬間移動が「超高速移動」と誤認されてカットオフ周波数 $f_c$ が最大化（フィルター無効化・ノイズ素通し）していないか。

### 3.2 該当コード箇所の分析

#### (1) インスタンス管理の実態 (`src/main.ts: 38行目, 423-428行目`)
```typescript
// src/main.ts: 38行目
const filterMap = new Map<string, OneEuroFilter3D>();

// src/main.ts: 423-428行目
// 各指先ごとの独立した 1 Euro Filter 3D インスタンス (beta: 1.5 で衝突時ノイズ遮断)
let filter = filterMap.get(key);
if (!filter) {
  filter = new OneEuroFilter3D({ minCutoff: 0.8, beta: 1.5, dCutoff: 1.0 });
  filterMap.set(key, filter);
}
```

- **確認結果**:
  1 Euro Filter は `key = ${resolvedHandedness}_${tip.tipIndex}`（例: `Right_4`, `Right_8`, `Right_12`, `Right_16`, `Right_20`）により、**各指先ごとに完全に独立した `OneEuroFilter3D` インスタンスが割り当てられています**。単一のインスタンスをターゲット指が使い回しているわけではありません。

#### (2) 単一インスタンス使い回し時との対比（理論的背景）
もし仮に単一インスタンスを使い回していた場合、以下の破綻が生じます：
- 旧指（人差し指 $x \approx 0.45$）から新指（中指 $x \approx 0.55$）への切り替え時、1フレーム（$dt \approx 0.033\text{s}$）で変位 $\Delta x \approx 0.10$ が入力されます。
- 変化率 $dx/dt = 0.10 / 0.033 \approx 3.03$ となり、`OneEuroFilter`（`src/oneEuroFilter.ts: 84行目`）の動的カットオフ周波数計算：
  $$f_c = \text{minCutoff} + \beta \cdot |edx|$$
  において、$f_c = 0.8 + 1.5 \times 3.03 \approx 5.35\text{Hz}$（$\beta=8.0$ の場合は $25\text{Hz}$ 超）へ急上昇します。
- これにより平滑化係数 $\alpha \to 1.0$ となり、フィルターが完全にバイパスされて生ノイズがそのまま出力され、激しいジッターが発生します。さらに速度平滑化フィルター（$d_{\text{cutoff}} = 1.0\text{Hz}$、時定数約160ms）により、この高感度状態が約5〜6フレーム持続します。

#### (3) 現行コードで激しいジッタリングが発生する真の原因
各指独立インスタンスであるにもかかわらず、なぜ切り替え直後にジッタリングが発生するのか？
コード追跡により、以下の**「非対称な幾何学復元ギャップ」**を特定しました。

```typescript
// src/main.ts: 456-469行目
// ターゲット指限定: 隣接指のTIP先端との異常接近判定
let isSnappingToNeighbor = false;
if (isTarget) { // ★ここが原因★
  for (const adjIdx of kinCfg.adjacentTips) {
    const neighborTip = rawLandmarks[adjIdx];
    if (neighborTip) {
      const distToNeighbor = Math.hypot(inputX - neighborTip.x, inputY - neighborTip.y);
      if (distToNeighbor < proximityThreshold) {
        isSnappingToNeighbor = true;
        break;
      }
    }
  }
}
```

1. **非ターゲット指の放置**:
   上記の通り、隣指吸着判定（`isSnappingToNeighbor`）は **`isTarget`（現在のターゲット指）にしか実行されません**。
2. **打鍵衝撃による隣指の引き寄せ**:
   旧指（人差し指）が机に衝突した瞬間、隣の新指（中指）の先端もMediaPipeのオクルージョンや手の影により、人差し指側へ局所的に吸着・歪みが発生します。しかし新指は `isTarget === false` であるため、キネマティクス復元が発動せず、歪んだ生座標のまま 1 Euro Filter に通されます。
3. **ターゲット切り替え瞬間のステップ入力**:
   打鍵が成立した瞬間、新指が `isTarget === true` に昇格します。
   すると次のフレームで初めて新指の吸着が検知され、キネマティクス復元（476-485行目）によって本来の位置へ瞬時に引き戻されます。
4. **速度履歴の急騰**:
   新指自身の 1 Euro Filter に対し、**「吸着していた歪み座標」から「幾何学復元された正常座標」への急激なステップ変位** が入力されます。
   これにより新指フィルターの速度履歴 $edx$ が跳ね上がり、カットオフ周波数 $f_c$ が急上昇してフィルターが無効化され、激しいジッタリングが発生します。

---

## 4. 調査項目 3: 切り替えフレームにおける描画ステートの整合性

### 4.1 調査対象
- 通常マーカーの非表示判定とホログラムリングの描画処理の間で、フラグやターゲット指インデックスの参照タイミングに1フレーム分のズレ（どちらも描画されない空白時間）が存在しないか。
- 座標未確定時に `return` や `null` チェックによって描画自体がスキップされる分岐がないか。

### 4.2 該当コード箇所の分析

#### (1) 【決定的一因】打鍵成功白フラッシュの消失バグ (`src/main.ts: 628-654行目`)
描画処理 `renderTracking` において、極めて深刻なステート不整合が発見されました。

```typescript
// src/main.ts: 628-654行目
// ターゲット指のみ打鍵成功フラッシュ（100ms以内）を描画
hands.forEach((hand) => {
  hand.fingertips.forEach((tip) => {
    const isTarget =
      hand.handedness === currentTarget.handedness && tip.tipIndex === currentTarget.tipIndex;

    if (isTarget) {
      const key = `${hand.handedness}_${tip.tipIndex}`;
      const lastTapTime = recentTapMap.get(key) ?? -9999;
      const isRecentlyTapped = currentTimestamp - lastTapTime < 100;

      if (isRecentlyTapped) {
        const px = tip.x * width;
        const py = tip.y * height;

        // 打鍵成功瞬間の高輝度白フラッシュ
        canvasCtx.save();
        canvasCtx.beginPath();
        canvasCtx.arc(px, py, 18, 0, 2 * Math.PI);
        canvasCtx.fillStyle = '#ffffff';
        canvasCtx.shadowColor = '#ffffff';
        canvasCtx.shadowBlur = 15;
        canvasCtx.fill();
        canvasCtx.restore();
      }
    }
  });
});
```

- **何が起きているか（時系列推移）**:
  1. `processHandsAndDetectTaps` 内で人差し指（8）の打鍵が検知される。
  2. `recentTapMap.set('Right_8', timestamp)` が保存される。
  3. **直後に同一関数内で `currentTarget` が中指（12）に更新される**。
  4. その後、描画関数 `renderTracking` が呼び出される。
  5. `renderTracking` では `tip.tipIndex === currentTarget.tipIndex`（つまり **12**）の指のみを評価する。
  6. 人差し指（8）は `isTarget === false` と判定され、**打鍵フラッシュ描画が完全にスキップされる**。
  7. 中指（12）は `isTarget === true` だが、`recentTapMap.get('Right_12')` は存在しない（`-9999`）ため、当然フラッシュは描画されない。
- **結論**:
  **打鍵成功時に表示されるはずの「高輝度白フラッシュ（100ms）」が、1フレームたりとも画面に表示されていません**。
  ユーザーにとっては、打鍵した瞬間にマーカーの光やフィードバックが一切なく、旧指の表示が唐突に途絶えるため、強烈な「マーカーの一瞬の消失」として知覚されます。

#### (2) ホログラム円マーカーと空中アーチの切り替え挙動 (`src/hologramEffect.ts`)
```typescript
// src/hologramEffect.ts: 192-222行目
const currentPos = this.getTargetPixelPosition(this.currentTarget, landmarksMap, width, height);
const nextPos = this.getTargetPixelPosition(this.nextTarget, landmarksMap, width, height);

// 1. 次指への空中立体アーチ
if (currentPos && nextPos && !isConsecutiveSameFinger) {
  this.renderProjectionArch(ctx, currentPos, nextPos);
}

// 2. 現在のターゲット指への円マーカー描画
if (currentPos) {
  this.renderTargetRing(ctx, currentPos);
}
```

- **ターゲット切り替え時の挙動**:
  - `currentTarget` が更新されたフレームで、`hologramEffect.setTargets` により `currentTarget` は即座に新指（12）へ切り替わります。
  - したがって、ホログラム円マーカー（水色/緑/黄色のリング）は旧指（8）から消滅し、新指（12）へ1フレームで瞬間移動します。
  - 新指の座標自体は `allLandmarks[12]` から取得されるため、`getTargetPixelPosition` が `null` を返して完全に描画が消えるわけではありません。
  - しかし、以下の複合要因により「消失した」と認識されます：
    1. 前述の白フラッシュが消失しているため、打鍵完了の視覚的アンカーが存在しない。
    2. 旧指から新指への空間的補間（モーショントランジション）がゼロであり、視線が旧指にある状態で新指へワープするため、視野の中心からマーカーが突然消失したように感じる。
    3. 新指の座標が前述の「キネマティクス復元ギャップ」により激しくジッターしているため、輪郭がブレて視認性が極端に低下する。

---

## 5. 根本原因の特定まとめ

| 現象 | 直接の発生箇所 | メカニズム・根本原因 |
| :--- | :--- | :--- |
| **打鍵瞬間のマーカー消失感** | `src/main.ts: 628-654` | 打鍵成立と同一フレーム内で `currentTarget` が新指に即時更新されるため、旧指の打鍵成功白フラッシュ（100ms）判定が `false` となり、**視覚フィードバックが1フレームも描画されずに破棄される**。 |
| **切り替え直後の激しいジッタリング** | `src/main.ts: 457-486`<br>`src/oneEuroFilter.ts: 78-85` | 隣指吸着の骨格キネマティクス復元が `isTarget` のみに限定されていたため、非ターゲット時に吸着・歪んでいた新指がターゲット指定された瞬間に急激に引き戻され、そのステップ変位で新指の 1 Euro Filter のカットオフ周波数 $f_c$ が最大化してノイズが素通しになる。 |
| **フレーム内状態の不整合** | `src/main.ts: 546-584` | `smoothedFingertips` のループ走査中に `currentTarget` が上書きされ、同一フレーム内で新旧指の参照ステートに矛盾が生じている。 |

---

## 6. 推奨される対策案

本不具合を恒久的に解決するため、以下の改修を推奨します。

### 対策 1: 打鍵フラッシュ演出の独立管理（ターゲット指と演出ライフサイクルの分離）
- `currentTarget` の更新に依存せず、打鍵された指（`hand`, `tipIndex`, `pos`, `startTime`）を独立したアニメーション配列または `hologramEffect` 内の打鍵エフェクトとして管理する。
- 打鍵された旧指の上で白フラッシュ（約80〜100ms）を確実に完遂させ、視覚的なフィードバックの消失を防止する。

### 対策 2: 全指に対する均等な骨格キネマティクス復元の適用
- `isTarget` の有無にかかわらず、**手前関節（PIP → DIP）を持つすべての指先に対して骨格整合性チェックおよびキネマティクス復元を毎フレーム常時適用**する。
- これにより、新指がターゲットに指定される前であっても常に正常な解剖学的位置に安定配置され、ターゲット切り替え時の急激なステップ変位と 1 Euro Filter の周波数爆発を未然に防止する。

### 対策 3: ターゲット指切り替え時のフレーム分離とトランジション
- 打鍵検知フレームでは「打鍵成立・フラッシュ発火」までを実行し、次ターゲット指への更新をフレーム終了後または次フレーム先頭で確定させる。
- 旧指マーカーから新指マーカーへの移行時に、1〜2フレームの短いクロスフェード、または空中アーチに沿った光のパルス移動を挟むことで、人間の視線移動に寄り添った滑らかなトランジションを実現する。

---

不明な点がある場合は必ず質問してください。
