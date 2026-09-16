/**
 * 机面（接地）ハイブリッド打鍵検知エンジン
 * 
 * 従来の「加速度（急減速）スパイク依存」を完全撤廃し、以下の2軸で判定：
 * 1. 手首Y座標（机面レベル判定）による空中キャンセルガード
 * 2. 指先Y座標の最下点変曲点（ピーク）検知（低速押し込み・通常タップ両対応）
 */

export interface TapDetectorConfig {
  /** 手首の空中キャンセル閾値 (画面上 0.0 ~ 下 1.0, 手首がこれより上にあると空中として判定ブロック, デフォルト: 0.38) */
  minWristY?: number;
  /** 打鍵検知に必要な最小下向き移動速度 (正規化座標/s, デフォルト: 0.08) */
  minDownVelocity?: number;
  /** 打鍵後の不応期 (ms, チャタリング防止, デフォルト: 150) */
  cooldownMs?: number;
}

export interface TapEvent {
  handedness: 'Left' | 'Right';
  tipIndex: number;
  name: string;
  x: number;
  y: number;
  z: number;
  /** 打鍵強度 (0.0 ~ 1.0) */
  velocity: number;
  /** 打鍵検出時刻 (ms) */
  timestamp: number;
}

interface FingerState {
  lastTime: number;
  lastY: number;
  lastVy: number;
  /** 直近のY座標履歴 (最下点変曲点検知用, 最大4フレーム) */
  yHistory: number[];
  /** 下向き動作開始時の最大下向き速度 */
  maxDownVy: number;
  /** 下向き動作が開始された時刻 */
  downStartTime: number;
  /** 最終打鍵検知時刻 */
  lastTapTime: number;
}

export class TapDetector {
  private minWristY: number;
  private minDownVelocity: number;
  private cooldownMs: number;
  private fingerStates = new Map<string, FingerState>();

  constructor(config: TapDetectorConfig = {}) {
    this.minWristY = config.minWristY ?? 0.38;
    this.minDownVelocity = config.minDownVelocity ?? 0.08;
    this.cooldownMs = config.cooldownMs ?? 150;
  }

  /**
   * 単一の指先座標を評価し、机面への接触（最下点変曲点）が成立した場合に TapEvent を返す
   * 
   * @param handedness 左右
   * @param tipIndex 指先インデックス (4, 8, 12, 16, 20)
   * @param name 指の名前
   * @param x 指先X座標
   * @param y 指先Y座標 (画面上 0.0 ~ 下 1.0)
   * @param z 指先Z座標
   * @param timestamp フレームタイムスタンプ (ms)
   * @param wristY 手首のY座標 (空中キャンセルガード用)
   */
  processFingertip(
    handedness: 'Left' | 'Right',
    tipIndex: number,
    name: string,
    x: number,
    y: number,
    z: number,
    timestamp: number,
    wristY?: number
  ): TapEvent | null {
    const key = `${handedness}_${tipIndex}`;
    let state = this.fingerStates.get(key);

    if (!state) {
      state = {
        lastTime: timestamp,
        lastY: y,
        lastVy: 0,
        yHistory: [y],
        maxDownVy: 0,
        downStartTime: -9999,
        lastTapTime: -9999,
      };
      this.fingerStates.set(key, state);
      return null;
    }

    const dt = (timestamp - state.lastTime) / 1000.0; // 秒単位

    // タイムスタンプ異常または長時間追跡中断時はリセット
    if (dt <= 0.001 || dt > 0.3) {
      state.lastTime = timestamp;
      state.lastY = y;
      state.lastVy = 0;
      state.yHistory = [y];
      state.maxDownVy = 0;
      state.downStartTime = -9999;
      return null;
    }

    // 垂直方向速度 (下向き移動を正とする)
    const vy = (y - state.lastY) / dt;

    // Y座標履歴を更新（最大4フレーム保持）
    state.yHistory.push(y);
    if (state.yHistory.length > 4) {
      state.yHistory.shift();
    }

    const timeSinceLastTap = timestamp - state.lastTapTime;
    const isCoolingDown = timeSinceLastTap < this.cooldownMs;

    // 下向き移動中かどうかの追跡
    if (vy >= this.minDownVelocity) {
      if (timestamp - state.downStartTime > 250) {
        state.downStartTime = timestamp;
        state.maxDownVy = vy;
      } else {
        state.maxDownVy = Math.max(state.maxDownVy, vy);
      }
    }

    let tapEvent: TapEvent | null = null;

    if (!isCoolingDown) {
      // 1. 空中キャンセルガード（机面レベル判定）
      // 手首Y座標が画面上端近く（空中）にある場合は、どれだけ指を動かしても打鍵をブロック
      const currentWristY = wristY !== undefined ? wristY : y;
      const isNearDesk = currentWristY >= this.minWristY;

      // 2. 最下点変曲点（ピーク）検知:
      // 指が机に向かって下向きに進行し、机面に接触して停止または反発した瞬間
      let isImpactPeak = false;
      if (state.yHistory.length >= 3) {
        const y0 = state.yHistory[state.yHistory.length - 3];
        const y1 = state.yHistory[state.yHistory.length - 2];
        const y2 = state.yHistory[state.yHistory.length - 1];

        // y1 が直前フレームで下向きに動いており、y2 で進行が止まった（または反発した）
        const wasMovingDown = y1 - y0 >= 0.0015;
        const hasStoppedOrRebounded = y2 <= y1 + 0.0025;

        isImpactPeak = wasMovingDown && hasStoppedOrRebounded;
      }

      // 3. 直近200ms以内に有意な下向き動作が存在していたか
      const hasRecentDownMotion =
        timestamp - state.downStartTime <= 220 &&
        state.maxDownVy >= this.minDownVelocity;

      if (isNearDesk && isImpactPeak && hasRecentDownMotion) {
        // 自然なベロシティ算出（低速押し込みでも聞き取りやすい音量を保証）
        const impactSpeed = Math.max(state.maxDownVy, state.lastVy, 0.08);
        const velocity = Math.min(1.0, Math.max(0.35, 0.35 + (impactSpeed - 0.08) * 1.5));

        tapEvent = {
          handedness,
          tipIndex,
          name,
          x,
          y,
          z,
          velocity,
          timestamp,
        };

        // 打鍵成立: 状態更新とクールダウン突入
        state.lastTapTime = timestamp;
        state.downStartTime = -9999;
        state.maxDownVy = 0;
        state.yHistory = [y];
      }
    }

    // 指が上向きに明確に引き上げられた場合は状態をリセット
    if (vy < -0.10) {
      state.downStartTime = -9999;
      state.maxDownVy = 0;
    }

    // 状態更新
    state.lastTime = timestamp;
    state.lastY = y;
    state.lastVy = vy;

    return tapEvent;
  }

  /**
   * 空中ガード用の手首高さ閾値を動的調整
   */
  setMinWristY(val: number): void {
    this.minWristY = Math.max(0.0, Math.min(1.0, val));
  }

  getMinWristY(): number {
    return this.minWristY;
  }

  /**
   * トラッキング中断時などの状態全リセット
   */
  reset(): void {
    this.fingerStates.clear();
  }
}
