# 過去の「1D学習データ／モデル読み込み」に関する調査レポート

本ドキュメントは、Piarno KeyboardLess プロジェクトにおいて過去に実装・検討された「1D学習データ」「推論モデル（ONNX等）」の読み込み方式および関連コード、Gitコミット履歴を詳細に調査した結果をまとめたものです。

---

## 1. 調査概要と結論 (Executive Summary)

- **実装されていたブランチ**:
  - `experiment/1d-tcn`（最新コミット: `5c0d2e1`）
  - 派生/参照ブランチ: `feature/annotation-ui`, `feature/frame-step-labeler`
  - ※現行作業ブランチ（`feature/hologram-feedback`）および `main` にはマージされておらず、幾何キネマティクス／仮想ロープ方式の探求と並行して別ブランチで実験・保持されていました。
- **推論エンジン**:
  - `onnxruntime-web` (v1.30.0) を採用。TensorFlow.js (`@tensorflow/tfjs`) や TFLite 等は使用されていません。
  - WebAssembly (WASM) バックエンドでシングルスレッド (`numThreads = 1`, SIMD有効) 運用。
- **モデル仕様**:
  - 1D-TCN（時間畳み込みネットワーク、Flatten型）。モデルサイズ: 3,494 bytes (`public/model_index.onnx`)。
  - 入力: 過去6フレーム × 6特徴量 (`[batch_size, 6, 6]`, float32)。
  - 出力: 打鍵ロジット値 (`[batch_size, 1]`, float32) → シグモイド関数で確率化。
- **学習およびデータセット**:
  - Pythonスクリプト (`ml/train_1d_tcn.py`) にて NumPy のみで TCN の順伝播・逆伝播を自作し、ONNX helper で直接エクスポート。
  - 初期は JSON 形式 (`ml/dataset/dataset_index_*.json`)、後期は CSV 形式 (`ml/dataset/index_*.csv`) に移行。
- **Web側の推論・データ処理**:
  - `src/tcnTapDetector.ts`: `fetch` による ONNX/Scaler ロード、`Float32Array` による 6×6 バッファ形成、推論実行、手首Y座標・深度・最下点変曲点・TCN確率のハイブリッド判定。
  - `src/featureLogger.ts`: 実機での特徴量ロガー（JSON/CSV エクスポート機能付き）。
  - `src/frameStepLabeler.ts`: コマ送りで打鍵フレームを目視アノテーションする Web UI。

---

## 2. 調査項目1: 依存関係の調査 (`package.json`, ロックファイル)

### 2.1 現行ブランチ vs 過去実験ブランチの比較

| 項目 | 現行 (`feature/hologram-feedback`) | 実験ブランチ (`experiment/1d-tcn`) |
| :--- | :--- | :--- |
| `dependencies` | `@mediapipe/tasks-vision: ^0.10.18` | `@mediapipe/tasks-vision: ^0.10.18`<br>**`onnxruntime-web: ^1.30.0`** |
| 機械学習ライブラリ | なし（幾何・キネマティクスベース判定） | **ONNX Runtime Web** |
| `@tensorflow/tfjs` 痕跡 | なし（履歴上も一切存在せず） | なし |
| `tflite` 痕跡 | なし | なし |

### 2.2 ロックファイル (`package-lock.json`) の記録

コミット `39404b7` において以下のパッケージが追加されていました:
```json
"node_modules/onnxruntime-web": {
  "version": "1.30.0",
  "resolved": "https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.30.0.tgz",
  "integrity": "sha512-q0y+JrrtukXSzsBWEMccVfqX25LRmosXHF+CaRJmg8pZClzcV7svNc4rKY3jL02Vb7QmRMDs1SigqR4CXAfKYQ==",
  "license": "MIT",
  "dependencies": {
    "flatbuffers": "^25.1.24",
    "guid-typescript": "^1.0.9"
  }
}
```

### 2.3 ONNX Runtime Web のランタイム設定

ブラウザ（特に iOS Safari 等）でのクロスオリジン制約 (COOP/COEP) や Vite の開発サーバー配信制約を回避するため、以下の環境設定が適用されていました:
```typescript
// src/tcnTapDetector.ts
const ONNX_VERSION = '1.30.0';
const CDN_WASM_PATH = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ONNX_VERSION}/dist/`;

// SharedArrayBuffer 制約を回避し単一スレッドで動作
ort.env.wasm.numThreads = 1;
// SIMD を有効化
ort.env.wasm.simd = true;
// CDN から WASM を取得
ort.env.wasm.wasmPaths = CDN_WASM_PATH;
```
※同時に `public/` ディレクトリ配下にもローカルフォールバック用として WASM バイナリが配置されていました。

---

## 3. 調査項目2: モデル・データファイルの調査

### 3.1 ファイル配置と履歴

コミット `39404b7` および `5c0d2e1` で以下のファイルが導入・更新されました:

```
Piarno_KeyboardLess/
├── public/
│   ├── model_index.onnx                       # 1D-TCN 学習済み推論モデル (3,494 bytes)
│   ├── model_index_scaler.json                # 特徴量 Z-score 正規化パラメータ
│   ├── ort-wasm-simd-threaded.wasm            # ONNX Runtime WASM バイナリ (14,239,897 bytes)
│   ├── ort-wasm-simd-threaded.asyncify.wasm   # (26,781,914 bytes)
│   ├── ort-wasm-simd-threaded.jsep.wasm       # (28,312,028 bytes)
│   └── ort-wasm-simd-threaded.jspi.wasm       # (16,758,545 bytes)
├── ml/
│   ├── train_1d_tcn.py                        # NumPy 自作 TCN 学習 & ONNX エクスポートスクリプト
│   └── dataset/
│       ├── (初期: 39404b7 で追加、5c0d2e1 で CSV に移行し削除)
│       │   ├── dataset_index_20260915_175925.json
│       │   ├── dataset_index_20260915_180018.json
│       │   ├── dataset_index_20260915_180121.json
│       │   └── dataset_index_20260915_180157.json
│       └── (後期: 5c0d2e1 で追加)
│           ├── index_tap_01.csv               # 通常打鍵正例
│           ├── index_neg_air_01.csv           # 空中運指負例
│           ├── index_neg_air_01.csvindex_neg_air_02.csv
│           ├── index_neg_idle_01.csv          # 静止負例
│           ├── index_neg_slide_01.csv         # 机面スライド負例
│           └── index_neg_wrist_01.csv         # 手首のみの上下動負例
└── tap_and_surface_detection_report.txt       # 当時の検証・課題分析レポート
```

### 3.2 モデル仕様 (`public/model_index.onnx`)

- **モデル形式**: ONNX (Opset 17, IR Version 8)
- **ファイルサイズ**: 3,494 bytes
- **モデル名**: `Tiny1DTCN_Flatten_Index`
- **ネットワーク構造**:
  1. `Input`: Shape `[batch_size, 6, 6]`, Type `float32`
     - チャネル数 = 6 (`rx, ry, rz, vx, vy, vz`)
     - 時間ステップ数 = 6 (過去6フレーム)
  2. `Conv1d`: in_channels=6, out_channels=16, kernel_size=3, padding=1
  3. `Relu`
  4. `Conv1d`: in_channels=16, out_channels=8, kernel_size=3, padding=1
  5. `Relu`
  6. `Flatten`: axis=1 → 出力形状 `[batch_size, 48]` (8チャネル × 6時間軸)
  7. `Gemm` (Linear): in=48, out=1
  8. `Output`: Shape `[batch_size, 1]`, Type `float32` (Logit値)

### 3.3 スケーラー仕様 (`public/model_index_scaler.json`)

時系列特徴量を標準化（Z-score: $(x - \mu) / \sigma$）するためのパラメータ:
```json
{
  "feature_names": [
    "rx",
    "ry",
    "rz",
    "vx",
    "vy",
    "vz"
  ],
  "mean": [
    0.06643374264240265,
    0.5219713449478149,
    -0.7177391648292542,
    0.005840294528752565,
    0.014240117743611336,
    -0.02057613804936409
  ],
  "std": [
    0.2566177546977997,
    0.4765547811985016,
    0.08963780850172043,
    1.4197278022766113,
    1.8771336078643799,
    1.0934429168701172
  ],
  "window_size": 6
}
```

### 3.4 データセットのフォーマット

#### 初期 JSON フォーマット (`ml/dataset/dataset_index_*.json`)
```json
[
  {
    "timestamp": 115256,
    "features": [
      -0.2686582470470082,  // rx
      -0.6880305651427994,  // ry
      -0.46166367426906135, // rz
      0.0,                  // vx
      0.0,                  // vy
      0.0                   // vz
    ],
    "label": 0              // 0: 通常, 1: 打鍵
  }
]
```

#### 後期 CSV フォーマット (`ml/dataset/index_*.csv`)
```csv
timestamp,rx,ry,rz,vx,vy,vz,label
22105,-0.12105,-0.35460,-0.49187,0,0,0,0
22155,0.05569,-0.30884,-0.61891,3.5349,0.9152,-2.5408,0
```

---

## 4. 調査項目3: コード内の読み込み・推論ロジックの調査 (`src/` 配下)

### 4.1 特徴量抽出アルゴリズム (`tcnTapDetector.ts` / `featureLogger.ts`)

人差し指の運動を手全体の移動から分離して抽出するため、以下の局所相対座標系が定義されていました:

1. **基準長 $L$ (手のスケール正規化)**:
   手首（Wrist: Landmark 0）から人差し指付け根（Index MCP: Landmark 5）のユークリッド距離:
   $$L = \sqrt{(x_5 - x_0)^2 + (y_5 - y_0)^2 + (z_5 - z_0)^2}$$
2. **局所相対位置 $r(t)$ (3次元)**:
   付け根 (MCP 5) を原点とした指先 (Index Tip: Landmark 8) の相対ベクトルを $L$ で正規化:
   $$r_x = \frac{x_8 - x_5}{L}, \quad r_y = \frac{y_8 - y_5}{L}, \quad r_z = \frac{z_8 - z_5}{L}$$
3. **局所相対速度 $v(t)$ (3次元)**:
   フレーム間時間差 $\Delta t = (t - t_{\text{prev}}) / 1000$ (秒) による数値微分:
   $$v_x = \frac{r_x - r_{x,\text{prev}}}{\Delta t}, \quad v_y = \frac{r_y - r_{y,\text{prev}}}{\Delta t}, \quad v_z = \frac{r_z - r_{z,\text{prev}}}{\Delta t}$$
4. **1フレームの特徴量**:
   $$f(t) = [r_x, r_y, r_z, v_x, v_y, v_z]$$
5. **スライディングウィンドウバッファ**:
   過去6フレーム分をキュー `featureHistory`（最大長 6）に蓄積。

### 4.2 Web推論とテンソル生成 (`Float32Array`)

`src/tcnTapDetector.ts` 内でのテンソル構築処理:
```typescript
// 1バッチ × 6チャネル × 6時間軸 の Float32Array を確保
const tensorData = new Float32Array(1 * 6 * 6);

// Z-score 正規化を適用しながら転置 [Channel, Time] で格納
for (let t = 0; t < 6; t++) {
  const feat = historySnapshot[t];
  for (let c = 0; c < 6; c++) {
    const val = this.scaler
      ? (feat[c] - this.scaler.mean[c]) / this.scaler.std[c]
      : feat[c];
    // shape [1, 6, 6]: channel * 6 + time
    tensorData[c * 6 + t] = val;
  }
}

const inputTensor = new ort.Tensor('float32', tensorData, [1, 6, 6]);
const results = await this.session!.run({ input: inputTensor });
const outputTensor = results.output;
const logit = Number(outputTensor.data[0]);
const prob = 1.0 / (1.0 + Math.exp(-logit)); // シグモイド関数
```

### 4.3 ハイブリッド打鍵判定ロジック

モデル単体での推論（確信度 `prob`）のみに依存すると空中誤検知が発生したため、コミット `5c0d2e1` では以下の5重ガードによるハイブリッド判定が組まれていました:

```typescript
// 1. 手首Y座標による空中キャンセルガード (画面下部ほどY大: デフォルト 0.45)
const wristPassed = this.minWristY <= 0.001 || wrist.y >= this.minWristY;

// 2. 指先打鍵深度ガード (机面に向けて押し込まれているか: デフォルト 0.15)
const depthPassed = currentRy >= this.minDepth;

// 3. 最下点変曲点（ピーク）検知: 下向き押し込みから机接触で反発・停止した瞬間
// 直前フレームまで押し込まれ (r1 >= r0 - 0.015)、現在フレームで停止/跳ね返り (r2 <= r1 + 0.035)
const isPeak = (r1 >= r0 - 0.015) && (r2 <= r1 + 0.035);

// 4. モデル推論確率判定 (低速打鍵での prob ~0.23 も許容: デフォルト 0.25)
const probPassed = prob >= this.minProb;

// 5. 減速度条件 (急ブレーキ量: 初期値 0.0 で無効化可能)
const decelPassed = this.minDecel <= 0.001 ? true : decel >= this.minDecel;

// 総合判定
const isTap =
  (timestamp - this.lastTapTimestamp >= this.cooldownMs) &&
  wristPassed &&
  depthPassed &&
  isPeak &&
  probPassed &&
  decelPassed;
```

### 4.4 ベロシティ算出式

加速度（単一スパイク）への依存を排し、打鍵深さ・速度・モデル確信度から自然なベロシティ（0.35〜1.0）を算出:
```typescript
const velocity = Math.min(
  1.0,
  Math.max(
    0.35,
    0.35 +
      Math.max(0, currentRy - this.minDepth) * 0.4 +
      Math.max(0, currVy) * 0.05 +
      Math.max(0, prob - this.minProb) * 0.3
  )
);
```

### 4.5 アノテーション・データ収集ツール

1. **`src/featureLogger.ts`**:
   - Webカメラ映像からフレーム毎の骨格・特徴量 (6次元) を記録。
   - `exportJSON()`: 学習スクリプト `train_1d_tcn.py` 互換の JSON 出力。
   - `exportCSV()`: タイムスタンプ・6特徴量・ラベルの CSV 出力。
2. **`src/frameStepLabeler.ts`**:
   - ブラウザ上で動作するコマ送り（1フレーム単位）手動アノテーション UI。
   - カメラ画像と骨格ライン、各フレームの変位・速度グラフをプレビューしながら、打鍵インパクト瞬間をキーボードショートカットで 1 / 0 ラベリング可能。

---

## 5. Git コミット履歴の詳細

| コミットハッシュ | 日時 | コミットメッセージ | 主な変更内容 |
| :--- | :--- | :--- | :--- |
| `39404b7` | 2026-09-16 21:53:45 +0900 | `feat: implement 1D-TCN tap detection, data logger, smoothed inference, and survey report` | `onnxruntime-web` 導入、`public/model_index.onnx`, `ml/train_1d_tcn.py`, `src/tcnTapDetector.ts`, `src/featureLogger.ts`, JSONデータセット追加、調査レポート作成 |
| `5c0d2e1` | 2026-09-16 23:58:16 +0900 | `feat: implement surface hybrid tap detection with wrist aerial guard and peak inflection` | JSONからCSVデータセットへの刷新、`src/frameStepLabeler.ts` (コマ送りUI) 追加、手首Y空中ガード・最下点変曲点検知を導入 |

---

## 6. 当時判明した技術的課題・ボトルネック（現行方式への分岐理由）

`tap_and_surface_detection_report.txt` より、当時の開発において以下の課題が浮き彫りになっていました:

1. **机面の絶対基準（接地判定）の欠如**:
   - 1D-TCN は指の局所的な屈伸・速度パターンのみを見ているため、「空中で指をピクッと止めた動作」と「机面に衝突した動作」の判別が困難で、空中誤検知が発生しやすかった。
2. **単一指（右手・人差し指）の制約**:
   - 当時のモデル・特徴量ロジックは右手人差し指 (Landmark 8, MCP 5, Wrist 0) にハードコードされており、10指演奏への拡張に指ごとのモデルまたは一般化特徴量が必要だった。
3. **学習データの汎化性能不足**:
   - 収集できたデータが特定環境・特定人物の打鍵（数百〜数千フレーム程度）に留まり、カメラアングルや机の高さが変わると感度が低下した。
4. **推論レイテンシとフレームドロップ**:
   - ブラウザ内の WASM シングルスレッドで `InferenceSession.run()` を毎フレーム非同期実行（約 3〜8 ms）するため、低スペック端末や MediaPipe との負荷競合時にフレームのドロップやすり抜けが発生する懸念があった。

→ この結果、プロジェクトは「机面の幾何学的キャリブレーション（動的机面・仮想ロープ・相互アンカー）による物理・幾何アプローチ」へと主軸を移し、現行の `feature/hologram-feedback` ブランチへと発展しました。

---

## 7. 今後の1Dモデル再導入・ハイブリッド化への提言

もし今後、機械学習（1D-TCN / ONNX）を再導入または現行の幾何判定とハイブリッド統合する場合、以下の資産と知見を直ちに再利用可能です:

1. **軽量な NumPy 自作学習パイプライン**:
   - `ml/train_1d_tcn.py` は PyTorch をインストールすることなく標準的な Python + NumPy + ONNX のみで動作し、サイズ 3.5KB の極小 ONNX モデルを出力可能。
2. **全指共通の相対運動特徴量への一般化**:
   - 特徴量計算式の基準長 $L$ を「各指の MCP 〜 Tip」とし、指先インデックスを引数化することで、全10指共通の 1D-TCN 判定器へ拡張可能。
3. **幾何接触判定とのアンサンブル**:
   - モデル単体で打鍵を決定するのではなく、現行の「仮想ロープ／机面近傍判定」がアクティブな区間内のみ 1D-TCN を起動することで、空中誤検知をゼロにしつつ打鍵瞬間のインパクト判定精度を高めることが可能。
