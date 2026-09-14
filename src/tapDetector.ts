/**
 * 机上「仮想ロープ（水平境界線）」接触による打鍵検知エンジン
 * 画面正規化Y座標系における境界交差と2値ヒステリシスステートマシン、
 * 指数平滑化（EMA）と異常値ガードによりジッターのない極めて堅牢な打鍵判定を実現する。
 */

export type RopeState = 'AIRBORNE' | 'TOUCHED';

export interface TapDetectorConfig {
  /** 仮想ロープの高さ (正規化Y座標: 0.0 ~ 1.0, 画面上端0.0、下端1.0, デフォルト: 0.75) */
  ropeY?: number;
  /** 指先判定サイズ・厚み半径 (正規化Y座標, デフォルト: 0.025。ロープ手前から接触とみなすマージン) */
  fingerRadius?: number;
  /** 浮上（AIRBORNE）復帰判定マージン (正規化Y座標, デフォルト: 0.03) */
  releaseMargin?: number;
  /** 指先Y座標の指数平滑化係数 (0.0 ~ 1.0, デフォルト: 0.4) */
  smoothingAlpha?: number;
  /** 1フレームあたりの最大許容移動量（異常値ガード, デフォルト: 0.08） */
  maxJumpPerFrame?: number;
  /** 打鍵後の最小不応期 (ms, デフォルト: 80) */
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

export interface DebugRopeInfo {
  state: RopeState;
  yTip: number;
  ropeY: number;
  diff: number; // yTip - ropeY
}

interface FingerState {
  state: RopeState;
  lastTime: number;
  smoothedY: number;
  lastTapTime: number;
}

export class TapDetector {
  private ropeY: number;
  private fingerRadius: number;
  private releaseMargin: number;
  private smoothingAlpha: number;
  private maxJumpPerFrame: number;
  private cooldownMs: number;
  private fingerStates = new Map<string, FingerState>();

  constructor(config: TapDetectorConfig = {}) {
    this.ropeY = config.ropeY ?? 0.75;
    this.fingerRadius = config.fingerRadius ?? 0.025;
    this.releaseMargin = config.releaseMargin ?? 0.03;
    this.smoothingAlpha = config.smoothingAlpha ?? 0.4;
    this.maxJumpPerFrame = config.maxJumpPerFrame ?? 0.08;
    this.cooldownMs = config.cooldownMs ?? 80;
  }

  public getRopeY(): number {
    return this.ropeY;
  }

  public setRopeY(y: number): void {
    // 0.30 ~ 0.90 の画面安全範囲内にクランプ
    this.ropeY = Math.max(0.30, Math.min(0.90, y));
  }

  public getFingerRadius(): number {
    return this.fingerRadius;
  }

  public setFingerRadius(radius: number): void {
    this.fingerRadius = Math.max(0.0, Math.min(0.1, radius));
  }

  public getReleaseMargin(): number {
    return this.releaseMargin;
  }

  /**
   * 指定した指の現在のデバッグ情報（ステート、平滑化後指先Y、ロープY、差分）を取得
   */
  public getDebugInfo(handedness: 'Left' | 'Right', tipIndex: number): DebugRopeInfo | null {
    const key = `${handedness}_${tipIndex}`;
    const state = this.fingerStates.get(key);
    if (!state) return null;

    const contactY = this.ropeY - this.fingerRadius;
    return {
      state: state.state,
      yTip: state.smoothedY,
      ropeY: this.ropeY,
      diff: state.smoothedY - contactY,
    };
  }

  /**
   * 単一指先の正規化Y座標を評価し、指数平滑化＋ヒステリシスステートマシンに基づいて打鍵イベントを返す
   */
  public processFingertip(
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

    // 0.0 ~ 1.0 の安全範囲にクランプ
    const clampedY = Math.max(0.0, Math.min(1.0, y));

    // 指先の厚み・半径を考慮した有効接触閾値 (ロープの手前 fingerRadius から接触と判定)
    const contactThresholdY = this.ropeY - this.fingerRadius;

    if (!state) {
      // 初回検出時: 指がすでにロープ付近にある場合の暴発を防ぐため初期状態を設定
      const isAboveRope = clampedY < contactThresholdY - this.releaseMargin;
      state = {
        state: isAboveRope ? 'AIRBORNE' : 'TOUCHED',
        lastTime: timestamp,
        smoothedY: clampedY,
        lastTapTime: -9999,
      };
      this.fingerStates.set(key, state);
      return null;
    }

    const dt = (timestamp - state.lastTime) / 1000.0;

    // ランドマーク未検出（フレーム落ち）や長時間中断時のガード: EMA履歴をリセット
    if (dt > 0.25 || dt <= 0.0) {
      state.lastTime = timestamp;
      state.smoothedY = clampedY;
      return null;
    }

    // 異常値ガード: 1フレームで過剰に跳ねた場合は変化量をクランプ
    let guardedY = clampedY;
    const rawDeltaY = clampedY - state.smoothedY;
    if (Math.abs(rawDeltaY) > this.maxJumpPerFrame) {
      guardedY = state.smoothedY + Math.sign(rawDeltaY) * this.maxJumpPerFrame;
    }

    // 指数平滑化 (EMA / ローパスフィルタ)
    const prevSmoothedY = state.smoothedY;
    const currentSmoothedY = this.smoothingAlpha * guardedY + (1.0 - this.smoothingAlpha) * prevSmoothedY;

    // 下降速度 (正規化Y / 秒)
    const downVy = (currentSmoothedY - prevSmoothedY) / Math.max(0.001, dt);

    let tapEvent: TapEvent | null = null;
    const timeSinceLastTap = timestamp - state.lastTapTime;
    const isCoolingDown = timeSinceLastTap < this.cooldownMs;

    if (state.state === 'AIRBORNE') {
      // 浮上中から指判定領域 (y >= ropeY - fingerRadius) に接触・交差した瞬間に打鍵判定
      if (currentSmoothedY >= contactThresholdY) {
        state.state = 'TOUCHED';
        if (!isCoolingDown) {
          // 下向き速度に応じたベロシティ計算 (0.35 ~ 1.0)
          const normalizedSpeed = Math.max(0, downVy);
          const velocity = Math.min(1.0, Math.max(0.35, normalizedSpeed / 1.0));

          tapEvent = {
            handedness,
            tipIndex,
            name,
            x,
            y: currentSmoothedY,
            z,
            velocity,
            timestamp,
          };
          state.lastTapTime = timestamp;
        }
      }
    } else {
      // 接触中 (TOUCHED): 指先が判定領域上方 (contactThresholdY - releaseMargin) に持ち上がるまで再発火をロック
      if (currentSmoothedY < contactThresholdY - this.releaseMargin) {
        state.state = 'AIRBORNE';
      }
    }

    // 状態更新
    state.lastTime = timestamp;
    state.smoothedY = currentSmoothedY;

    return tapEvent;
  }

  /**
   * トラッキング中断時などの状態全リセット
   */
  public reset(): void {
    this.fingerStates.clear();
  }
}
