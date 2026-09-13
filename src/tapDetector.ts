/**
 * 指先の垂直方向減速ピークによる机タップ（打鍵）検知エンジン
 */

export interface TapDetectorConfig {
  /** 能動的振り下ろしとみなす最小垂直速度 (正規化座標/s, デフォルト: 0.45) */
  minDownVelocity?: number;
  /** 机衝突時の急減速加速度ピーク閾値 (/s², 負値, デフォルト: -14.0) */
  minDecelPeak?: number;
  /** 振り下ろし開始から着地インパクトまでの許容時間窓 (ms, デフォルト: 140) */
  maxDownToImpactMs?: number;
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
  /** 直近の能動的振り下ろし発生時刻 */
  lastActiveDownTime: number;
  /** その振り下ろし中の最大下向き速度 */
  maxActiveDownVy: number;
  /** 最終打鍵検知時刻 */
  lastTapTime: number;
}

export class TapDetector {
  private minDownVelocity: number;
  private minDecelPeak: number;
  private maxDownToImpactMs: number;
  private cooldownMs: number;
  private fingerStates = new Map<string, FingerState>();

  constructor(config: TapDetectorConfig = {}) {
    this.minDownVelocity = config.minDownVelocity ?? 0.30;
    this.minDecelPeak = config.minDecelPeak ?? -7.0;
    this.maxDownToImpactMs = config.maxDownToImpactMs ?? 220;
    this.cooldownMs = config.cooldownMs ?? 130;
  }

  /**
   * 単一の指先座標を評価し、能動的振り下ろし＋机衝突の急減速が成立した場合に TapEvent を返す
   */
  processFingertip(
    handedness: 'Left' | 'Right',
    tipIndex: number,
    name: string,
    x: number,
    y: number,
    z: number,
    timestamp: number
  ): TapEvent | null {
    const key = `${handedness}_${tipIndex}`;
    let state = this.fingerStates.get(key);

    // 親指(4)、小指(20)、薬指(16)は独立した垂直可動域が小さく力が出にくいため、感度を専用ブースト
    const isWeakFinger = tipIndex === 4 || tipIndex === 20 || tipIndex === 16;
    const effectiveMinDownVelocity = isWeakFinger ? this.minDownVelocity * 0.40 : this.minDownVelocity;
    const effectiveMinDecelPeak = isWeakFinger ? this.minDecelPeak * 0.40 : this.minDecelPeak;
    const effectiveAyThreshold = isWeakFinger ? -3.0 : -6.0;

    if (!state) {
      state = {
        lastTime: timestamp,
        lastY: y,
        lastVy: 0,
        lastActiveDownTime: -9999,
        maxActiveDownVy: 0,
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
      state.lastActiveDownTime = -9999;
      state.maxActiveDownVy = 0;
      return null;
    }

    // 垂直方向速度 (下向き移動を正とする)
    const vy = (y - state.lastY) / dt;
    // 垂直方向加速度 (下向き加速が正、急減速・衝突が負の急峻ピーク)
    const ay = (vy - state.lastVy) / dt;

    const timeSinceLastTap = timestamp - state.lastTapTime;
    const isCoolingDown = timeSinceLastTap < this.cooldownMs;

    // 段階1: 明確な能動的振り下ろし（アクティブダウン）の検知と記憶
    if (vy >= effectiveMinDownVelocity) {
      state.lastActiveDownTime = timestamp;
      state.maxActiveDownVy = Math.max(state.maxActiveDownVy, vy);
    }

    let tapEvent: TapEvent | null = null;

    if (!isCoolingDown) {
      // 直近 (maxDownToImpactMs 以内) に十分なスピードの振り下ろしが発生しているか
      const hasRecentActiveDown =
        timestamp - state.lastActiveDownTime <= this.maxDownToImpactMs &&
        state.maxActiveDownVy >= effectiveMinDownVelocity;

      // 段階2: 机衝突による物理的急減速（負の急峻な加速度ピーク または 強い制動）
      const hasDecelPeak = ay <= effectiveMinDecelPeak;
      const hasSharpVelocityDrop =
        state.lastVy >= effectiveMinDownVelocity &&
        vy <= state.lastVy * 0.40 &&
        ay <= effectiveAyThreshold;

      if (hasRecentActiveDown && (hasDecelPeak || hasSharpVelocityDrop)) {
        // 振り下ろしピーク速度を元にベロシティ (0.2 ~ 1.0) を算出
        const impactSpeed = Math.max(state.lastVy, state.maxActiveDownVy);
        const velocity = Math.min(1.0, Math.max(0.2, impactSpeed / (isWeakFinger ? 1.0 : 1.6)));

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
        state.lastActiveDownTime = -9999;
        state.maxActiveDownVy = 0;
      }
    }

    // 指が上向きに引き上げられた場合は振り下ろし状態をクリア
    if (vy < -0.15) {
      state.lastActiveDownTime = -9999;
      state.maxActiveDownVy = 0;
    }

    // 状態更新
    state.lastTime = timestamp;
    state.lastY = y;
    state.lastVy = vy;

    return tapEvent;
  }

  /**
   * トラッキング中断時などの状態全リセット
   */
  reset(): void {
    this.fingerStates.clear();
  }
}
