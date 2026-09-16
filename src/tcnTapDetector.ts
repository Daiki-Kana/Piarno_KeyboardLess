import * as ort from 'onnxruntime-web';
import { HandData } from './handTracker';
import { TapEvent } from './tapDetector';

// インストール済みバージョン (package.json: onnxruntime-web@1.30.0) に一致するCDN URL
const ONNX_VERSION = '1.30.0';
const CDN_WASM_PATH = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ONNX_VERSION}/dist/`;

// SharedArrayBuffer (COOP/COEP) 制約を回避し、全環境（特にiOS Safari）で安定稼働させるため単一スレッドに設定
ort.env.wasm.numThreads = 1;
// 高速化のためSIMDを初期有効化（非対応環境時はフォールバック）
ort.env.wasm.simd = true;
// Viteの内部サーバーエラー（/public からの .mjs import遮断）を回避し、バージョン整合したCDNから配信
ort.env.wasm.wasmPaths = CDN_WASM_PATH;

export interface TapLogEntry {
  timestamp: number;
  timeStr: string;
  prob: number;
  decel: number;
  velocity: number;
}

export interface TcnDebugStatus {
  isReady: boolean;
  errorMessage: string | null; // 初期化または推論エラー文字列
  prob: number;       // 最新モデル推論確率 (0.0 ~ 1.0)
  ry: number;         // 最新の人差し指相対高さ (打鍵深さ)
  wristY: number;     // 最新の手首Y座標 (空中ガード用: 画面下部ほど大)
  isPeak: boolean;    // 直近フレームで最下点変曲点（机接触ピーク）を検知したか
  decel: number;      // 直近の減速度 (prevVy - currVy)
  prevVy: number;
  currVy: number;
  tapCount: number;   // 累計検知回数
  minProb: number;    // 現在の確率閾値
  minDepth: number;   // 現在の打鍵深さ閾値
  minWristY: number;  // 現在の手首高さ閾値 (空中キャンセル)
  minDecel: number;   // 現在の減速閾値
  cooldownMs: number; // 現在のクールダウン時間
  recentLogs: TapLogEntry[]; // 直近打鍵ログ（最大3件）
}

export class TcnTapDetector {
  private session: ort.InferenceSession | null = null;
  private isInitializing = false;
  private isReady = false;
  private errorMessage: string | null = null;

  // 過去6フレームの特徴量履歴 [ [rx, ry, rz, vx, vy, vz], ... ] (長さ最大6)
  private featureHistory: number[][] = [];

  // 直近フレームの局所相対位置とタイムスタンプ（速度計算用）
  private lastR: { x: number; y: number; z: number } | null = null;
  private lastTimestamp: number | null = null;

  // 直近フレームの指先相対深さ履歴（最下点変曲点・ピーク検知用）
  private ryHistory: number[] = [];

  // リアルタイム調整可能パラメータ（初期値）
  // 低速押し込み打鍵（実測prob ~0.23）も拾えるよう初期値を0.25に設定
  private minProb = 0.25;
  // 手首Y座標による空中キャンセルガード (0.0で無効, デフォルト0.45: 画面下半分)
  private minWristY = 0.45;
  // 打鍵深さ（正例統計: ry >= 0.2177）による位置ベースガード
  private minDepth = 0.15;
  // 加速度（減速度）依存を解除するため初期値を 0.0 (OFF) に設定
  private minDecel = 0.0;
  private cooldownMs = 100;

  // チャタリング防止用クールダウン（ms）
  private lastTapTimestamp = -9999;

  // 直近打鍵ログ（最大3件）
  private recentTapLogs: TapLogEntry[] = [];

  // 推論同時実行制御 & すり抜け防止キュー
  private isInferring = false;
  private hasNewFeaturesSinceLastInfer = false;
  private pendingTapEvent: TapEvent | null = null;

  // デバッグオーバーレイ用リアルタイムステータス
  private lastProb = 0;
  private lastRy = 0;
  private lastWristY = 0;
  private lastIsPeak = false;
  private lastDecel = 0;
  private lastPrevVy = 0;
  private lastCurrVy = 0;
  private tapCount = 0;

  // 6次元特徴量 Z-score スケーラーパラメータ
  private scaler: { mean: number[]; std: number[] } | null = null;

  /**
   * ONNX モデル (/model_index.onnx) と スケーラー (/model_index_scaler.json) を非同期ロードし、ウォームアップ推論を実行
   */
  async init(
    modelPath: string = '/model_index.onnx',
    scalerPath: string = '/model_index_scaler.json'
  ): Promise<void> {
    if (this.isReady || this.isInitializing) return;
    this.isInitializing = true;
    this.errorMessage = null;

    try {
      // 1. スケーラーパラメータのロード（絶対パス優先、失敗時は相対パスでフォールバック）
      let scalerLoaded = false;
      const scalerCandidates = [scalerPath, './model_index_scaler.json'];
      for (const path of scalerCandidates) {
        try {
          const scalerRes = await fetch(path);
          if (scalerRes.ok) {
            this.scaler = await scalerRes.json();
            scalerLoaded = true;
            console.log('[TcnTapDetector] Z-score スケーラーパラメータ読み込み完了:', path);
            break;
          }
        } catch (sErr) {
          console.warn(`[TcnTapDetector] スケーラー読み込み失敗 (${path}):`, sErr);
        }
      }
      if (!scalerLoaded) {
        console.warn('[TcnTapDetector] スケーラーパラメータ読み込みをスキップ（正規化なしで継続）');
      }

      // 2. ONNX モデルファイルのフェッチ（直接 ArrayBuffer 化してパス解決齟齬とHTTPエラーを捕捉）
      let modelBuffer: ArrayBuffer | null = null;
      let modelFetchError: string | null = null;
      const modelCandidates = [modelPath, './model_index.onnx'];

      for (const path of modelCandidates) {
        try {
          const modelRes = await fetch(path);
          if (modelRes.ok) {
            modelBuffer = await modelRes.arrayBuffer();
            console.log('[TcnTapDetector] ONNX モデルバイナリ取得成功:', path, `(${modelBuffer.byteLength} bytes)`);
            break;
          } else {
            modelFetchError = `HTTP ${modelRes.status}: ${modelRes.statusText} (${path})`;
          }
        } catch (fErr) {
          modelFetchError = fErr instanceof Error ? fErr.message : String(fErr);
          console.warn(`[TcnTapDetector] モデルフェッチ失敗 (${path}):`, fErr);
        }
      }

      if (!modelBuffer) {
        throw new Error(`モデル取得失敗: ${modelFetchError || '404 Not Found'}`);
      }

      // 3. ONNX セッション生成（シングルスレッドWASM環境を明示指定）
      const sessionOptions: ort.InferenceSession.SessionOptions = {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      };

      console.log('[TcnTapDetector] ONNX InferenceSession 作成開始 (EP: wasm, threads: 1)...');
      this.session = await ort.InferenceSession.create(modelBuffer, sessionOptions);
      console.log('[TcnTapDetector] ONNX InferenceSession 作成成功');

      // 4. ウォームアップ推論（初速ラグ解消と動作確認）
      const dummyInput = new ort.Tensor('float32', new Float32Array(36), [1, 6, 6]);
      await this.session.run({ input: dummyInput });
      this.isReady = true;
      this.errorMessage = null;
      console.log('[TcnTapDetector] 1D-TCN ONNX モデル初期化&ウォームアップ完了');
    } catch (err: any) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.errorMessage = errMsg;
      console.error('[TcnTapDetector] ONNX モデル初期化失敗:', err);
      if (err instanceof Error && err.stack) {
        console.error('[TcnTapDetector] スタックトレース:', err.stack);
      }
    } finally {
      this.isInitializing = false;
    }
  }

  /**
   * フレーム毎に人差し指の運動特徴量を確実に更新し、1D-TCN推論による打鍵判定を行う
   */
  async processFrame(
    hands: HandData[],
    timestamp: number
  ): Promise<TapEvent | null> {
    if (this.pendingTapEvent) {
      const event = this.pendingTapEvent;
      this.pendingTapEvent = null;
      return event;
    }

    if (!this.session || !this.isReady) {
      return null;
    }

    // 対象手（右手優先、なければ検出手）を取得
    const targetHand = hands.find((h) => h.handedness === 'Right') ?? hands[0];
    if (!targetHand || !targetHand.allLandmarks || targetHand.allLandmarks.length < 9) {
      this.featureHistory = [];
      this.lastR = null;
      this.lastTimestamp = null;
      return null;
    }

    const wrist = targetHand.allLandmarks[0]; // Wrist (0)
    const mcp = targetHand.allLandmarks[5];   // Index MCP (5)
    const tip = targetHand.allLandmarks[8];   // Index Tip (8)

    this.lastWristY = wrist.y;

    // スケール正規化基準長 L = ||Index MCP - Wrist||
    const dx = mcp.x - wrist.x;
    const dy = mcp.y - wrist.y;
    const dz = mcp.z - wrist.z;
    const L = Math.hypot(dx, dy, dz) || 1e-6;

    // 局所相対位置 r(t) = (Index Tip - Index MCP) / L
    const rx = (tip.x - mcp.x) / L;
    const ry = (tip.y - mcp.y) / L;
    const rz = (tip.z - mcp.z) / L;

    // 指先相対深さ履歴の更新（最下点変曲点・ピーク検知用）
    this.ryHistory.push(ry);
    if (this.ryHistory.length > 6) {
      this.ryHistory.shift();
    }

    // 局所相対速度 v(t)
    let vx = 0;
    let vy = 0;
    let vz = 0;
    if (this.lastR !== null && this.lastTimestamp !== null && timestamp > this.lastTimestamp) {
      const dt = (timestamp - this.lastTimestamp) / 1000;
      if (dt > 0) {
        vx = (rx - this.lastR.x) / dt;
        vy = (ry - this.lastR.y) / dt;
        vz = (rz - this.lastR.z) / dt;
      }
    }
    this.lastR = { x: rx, y: ry, z: rz };
    this.lastTimestamp = timestamp;

    const currentFeature = [rx, ry, rz, vx, vy, vz];
    this.featureHistory.push(currentFeature);
    if (this.featureHistory.length > 6) {
      this.featureHistory.shift();
    }
    this.hasNewFeaturesSinceLastInfer = true;

    if (this.featureHistory.length < 6) {
      return null;
    }

    const prevVy = this.featureHistory[4][4];
    const currVy = this.featureHistory[5][4];
    const decel = prevVy - currVy;
    this.lastPrevVy = prevVy;
    this.lastCurrVy = currVy;
    this.lastDecel = decel;

    if (timestamp - this.lastTapTimestamp < this.cooldownMs) {
      return null;
    }

    if (!this.isInferring) {
      return await this.runInferenceLoop(targetHand, tip, wrist, timestamp);
    }

    return null;
  }

  /**
   * 推論処理ループ: 机面判定・最下点変曲点・時系列モデルのハイブリッド判定
   */
  private async runInferenceLoop(
    targetHand: HandData,
    tip: { x: number; y: number; z: number },
    wrist: { x: number; y: number; z: number },
    timestamp: number
  ): Promise<TapEvent | null> {
    this.isInferring = true;
    let detectedEvent: TapEvent | null = null;

    try {
      while (this.hasNewFeaturesSinceLastInfer && this.featureHistory.length >= 6) {
        this.hasNewFeaturesSinceLastInfer = false;

        const historySnapshot = this.featureHistory.map((f) => [...f]);
        const tensorData = new Float32Array(1 * 6 * 6);
        for (let t = 0; t < 6; t++) {
          const feat = historySnapshot[t];
          for (let c = 0; c < 6; c++) {
            const val = this.scaler
              ? (feat[c] - this.scaler.mean[c]) / this.scaler.std[c]
              : feat[c];
            tensorData[c * 6 + t] = val;
          }
        }

        const inputTensor = new ort.Tensor('float32', tensorData, [1, 6, 6]);
        const results = await this.session!.run({ input: inputTensor });
        const outputTensor = results.output;
        const logit = Number(outputTensor.data[0]);

        const prob = 1.0 / (1.0 + Math.exp(-logit));
        const prevVy = historySnapshot[4][4];
        const currVy = historySnapshot[5][4];
        const decel = prevVy - currVy;
        const currentRy = historySnapshot[5][1]; // 人差し指相対深さ ry

        // 1. 手首Y座標による空中キャンセルガード (机面レベル判定: 画面下部ほどY大)
        // 手を空中に持ち上げているときは wrist.y が小さくなり即座にブロック
        const wristPassed = this.minWristY <= 0.001 || wrist.y >= this.minWristY;

        // 2. 指先打鍵深度ガード (机面に向けて十分に押し込まれているか)
        const depthPassed = currentRy >= this.minDepth;

        // 3. 最下点変曲点（ピーク）検知: 下向き進行から机面に接触して停止/反発した瞬間
        let isPeak = false;
        if (this.ryHistory.length >= 3) {
          const r0 = this.ryHistory[this.ryHistory.length - 3];
          const r1 = this.ryHistory[this.ryHistory.length - 2];
          const r2 = this.ryHistory[this.ryHistory.length - 1];
          // 直前フレームまで押し込まれており (r1 >= r0)、現在フレームで停止または跳ね返った (r2 <= r1 + 0.035)
          isPeak = (r1 >= r0 - 0.015) && (r2 <= r1 + 0.035);
        }

        // 4. モデル推論確率判定 (低速打鍵での prob ~0.23 も許容)
        const probPassed = prob >= this.minProb;

        // 5. 減速度条件 (minDecel <= 0.001 の場合は加速度を要求せず無効化)
        const decelPassed = this.minDecel <= 0.001 ? true : decel >= this.minDecel;

        this.lastProb = prob;
        this.lastRy = currentRy;
        this.lastWristY = wrist.y;
        this.lastIsPeak = isPeak;
        this.lastDecel = decel;
        this.lastPrevVy = prevVy;
        this.lastCurrVy = currVy;

        const isTap =
          (timestamp - this.lastTapTimestamp >= this.cooldownMs) &&
          wristPassed &&
          depthPassed &&
          isPeak &&
          probPassed &&
          decelPassed;

        if (isTap) {
          this.lastTapTimestamp = timestamp;
          this.tapCount++;

          // 打鍵深さ・速度・確信度から自然なベロシティを算出（加速度単体依存を完全撤廃）
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

          // 直近打鍵ログに記録（最大3件保持）
          const dateNow = new Date();
          const timeStr = dateNow.toTimeString().split(' ')[0] + '.' + Math.floor(dateNow.getMilliseconds() / 100);
          this.recentTapLogs.unshift({
            timestamp,
            timeStr,
            prob,
            decel,
            velocity,
          });
          if (this.recentTapLogs.length > 3) {
            this.recentTapLogs.pop();
          }

          console.log(
            `[机面ハイブリッド打鍵検知] Prob: ${(prob * 100).toFixed(1)}%, Depth: ${currentRy.toFixed(2)}, WristY: ${wrist.y.toFixed(2)}, Peak: ${isPeak}, Vel: ${velocity.toFixed(2)}`
          );

          const resolvedHandedness: 'Left' | 'Right' =
            targetHand.handedness === 'Left' ? 'Left' : 'Right';

          detectedEvent = {
            handedness: resolvedHandedness,
            tipIndex: 8,
            name: '人差指',
            x: tip.x,
            y: tip.y,
            z: tip.z,
            velocity,
            timestamp,
          };

          break;
        }
      }
    } catch (inferErr) {
      console.warn('[TcnTapDetector] 推論実行時エラー:', inferErr);
    } finally {
      this.isInferring = false;
    }

    return detectedEvent;
  }

  // --- パラメータ調整セッター ---
  public setMinProb(val: number): void {
    this.minProb = Math.max(0.1, Math.min(0.99, val));
  }

  public setMinWristY(val: number): void {
    this.minWristY = Math.max(0.0, Math.min(1.0, val));
  }

  public setMinDepth(val: number): void {
    this.minDepth = Math.max(0.0, Math.min(1.0, val));
  }

  public setMinDecel(val: number): void {
    this.minDecel = Math.max(0.0, Math.min(10.0, val));
  }

  public setCooldownMs(val: number): void {
    this.cooldownMs = Math.max(10, Math.min(1000, val));
  }

  public getParams() {
    return {
      minProb: this.minProb,
      minWristY: this.minWristY,
      minDepth: this.minDepth,
      minDecel: this.minDecel,
      cooldownMs: this.cooldownMs,
    };
  }

  /**
   * デバッグオーバーレイ表示用のステータスを取得
   */
  public getDebugStatus(): TcnDebugStatus {
    return {
      isReady: this.isReady,
      errorMessage: this.errorMessage,
      prob: this.lastProb,
      ry: this.lastRy,
      wristY: this.lastWristY,
      isPeak: this.lastIsPeak,
      decel: this.lastDecel,
      prevVy: this.lastPrevVy,
      currVy: this.lastCurrVy,
      tapCount: this.tapCount,
      minProb: this.minProb,
      minWristY: this.minWristY,
      minDepth: this.minDepth,
      minDecel: this.minDecel,
      cooldownMs: this.cooldownMs,
      recentLogs: [...this.recentTapLogs],
    };
  }

  public getErrorMessage(): string | null {
    return this.errorMessage;
  }

  public reset(): void {
    this.featureHistory = [];
    this.lastR = null;
    this.lastTimestamp = null;
    this.lastTapTimestamp = -9999;
    this.hasNewFeaturesSinceLastInfer = false;
    this.pendingTapEvent = null;
  }
}
