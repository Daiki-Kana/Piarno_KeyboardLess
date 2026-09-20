/**
 * 指先の垂直方向減速ピークによる机タップ（打鍵）検知エンジン
 */

/** 他指との相対速度比率ガード係数K (Winner-Take-All, デフォルト: 1.3) */
export const DEFAULT_RELATIVE_VELOCITY_RATIO_K = 1.3;

/** 1フレームあたりの最大物理許容移動量 (画面高の割合, デフォルト: 0.08 = 8%) */
export const MAX_PHYSICAL_DISPLACEMENT_PER_FRAME = 0.08;

export interface TapDetectorConfig {
  /** 能動的振り下ろしとみなす最小垂直速度 (正規化座標/s, デフォルト: 0.25) */
  minDownVelocity?: number;
  /** 机衝突時の急減速加速度ピーク閾値 (/s², 負値, デフォルト: -5.5) */
  minDecelPeak?: number;
  /** 振り下ろし開始から着地インパクトまでの許容時間窓 (ms, デフォルト: 200) */
  maxDownToImpactMs?: number;
  /** 打鍵後の不応期 (ms, チャタリング防止, デフォルト: 180) */
  cooldownMs?: number;
  /** 他指との相対速度比率K: targetFingerVy > maxOtherVy * K (デフォルト: 1.3) */
  relativeVelocityRatio?: number;
  /** 1フレームあたりの最大物理許容垂直移動量 (画面高に対する割合, デフォルト: 0.08) */
  maxDisplacementPerFrame?: number;
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
  /** 現フレームでの垂直速度 (下向き正) */
  currentVy: number;
  /** 現フレームでの垂直加速度 */
  currentAy: number;
  /** 直前の速度 (減速直前速度) */
  prevVy: number;
  /** 物理量を計算した直近フレームのタイムスタンプ */
  lastComputedTime: number;
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
  private relativeVelocityRatio: number;
  private maxDisplacementPerFrame: number;
  private fingerStates = new Map<string, FingerState>();

  /** 直近のTapGate判定結果（リアルタイムデバッグ表示用） */
  private latestGateResult = {
    targetFingerName: '未検出',
    targetVy: 0,
    maxOtherVy: 0,
    ratio: 0,
    lastResult: 'WAITING' as 'PASS: 打鍵発火' | 'BLOCKED: 共連れ抑止' | 'WAITING',
    timestamp: 0,
  };

  constructor(config: TapDetectorConfig = {}) {
    this.minDownVelocity = config.minDownVelocity ?? 0.25;
    this.minDecelPeak = config.minDecelPeak ?? -5.5;
    this.maxDownToImpactMs = config.maxDownToImpactMs ?? 200;
    this.cooldownMs = config.cooldownMs ?? 180;
    this.relativeVelocityRatio = config.relativeVelocityRatio ?? DEFAULT_RELATIVE_VELOCITY_RATIO_K;
    this.maxDisplacementPerFrame = config.maxDisplacementPerFrame ?? MAX_PHYSICAL_DISPLACEMENT_PER_FRAME;
  }

  /**
   * 指定した手（スロット）の全指先状態を一括リセット（画面外からの復帰初フレーム用）
   */
  resetSlot(handedness: 'Left' | 'Right'): void {
    for (const tipIndex of [4, 8, 12, 16, 20]) {
      const key = `${handedness}_${tipIndex}`;
      this.fingerStates.delete(key);
    }
  }

  /**
   * 打鍵成立直後、その手の全指の運動履歴をリセットしクールダウン状態にする
   * 打鍵時の手の連動や衝撃の残存による次指の即時誤爆を防止する
   */
  resetAfterTap(handedness: 'Left' | 'Right', timestamp: number): void {
    for (const tipIndex of [4, 8, 12, 16, 20]) {
      const key = `${handedness}_${tipIndex}`;
      const state = this.fingerStates.get(key);
      if (state) {
        state.lastTapTime = timestamp;
        state.lastActiveDownTime = -9999;
        state.maxActiveDownVy = 0;
        state.currentVy = 0;
        state.prevVy = 0;
        state.lastVy = 0;
      }
    }
  }

  /**
   * 相対速度比率Kの動的更新
   */
  setRelativeVelocityRatio(k: number): void {
    this.relativeVelocityRatio = Math.max(1.0, Math.min(2.5, k));
  }

  /**
   * 現在の相対速度比率Kを取得
   */
  getRelativeVelocityRatio(): number {
    return this.relativeVelocityRatio;
  }

  /**
   * 直近のTapGate判定結果を取得
   */
  getLatestGateResult() {
    return this.latestGateResult;
  }

  /**
   * 指定した手の指定指および他指の現在の垂直下向き速度と比率を取得（リアルタイムUI用）
   */
  getLiveSpeedInfo(
    handedness: 'Left' | 'Right',
    tipIndex: number
  ): { targetVy: number; maxOtherVy: number; ratio: number } {
    const targetState = this.fingerStates.get(`${handedness}_${tipIndex}`);
    const targetVy = targetState ? Math.max(0, targetState.currentVy) : 0;

    let maxOtherVy = 0;
    for (const otherTipIndex of [4, 8, 12, 16, 20]) {
      if (otherTipIndex === tipIndex) continue;
      const otherState = this.fingerStates.get(`${handedness}_${otherTipIndex}`);
      if (otherState) {
        const downVy = Math.max(0, otherState.currentVy);
        if (downVy > maxOtherVy) {
          maxOtherVy = downVy;
        }
      }
    }

    const effectiveOtherVy = maxOtherVy < 0.02 ? 0 : maxOtherVy;
    const ratio = effectiveOtherVy > 0.0001 ? targetVy / effectiveOtherVy : (targetVy > 0 ? 99.99 : 0);

    return {
      targetVy,
      maxOtherVy: effectiveOtherVy,
      ratio,
    };
  }

  /**
   * 指先の物理量（速度・加速度・振り下ろし状態）を更新またはキャッシュ取得
   */
  private updateFingerDynamics(
    handedness: 'Left' | 'Right',
    tipIndex: number,
    y: number,
    timestamp: number
  ): { vy: number; ay: number; lastVy: number } | null {
    const key = `${handedness}_${tipIndex}`;
    let state = this.fingerStates.get(key);

    if (!state) {
      state = {
        lastTime: timestamp,
        lastY: y,
        lastVy: 0,
        currentVy: 0,
        currentAy: 0,
        prevVy: 0,
        lastComputedTime: timestamp,
        lastActiveDownTime: -9999,
        maxActiveDownVy: 0,
        lastTapTime: -9999,
      };
      this.fingerStates.set(key, state);
      return null;
    }

    // 同一フレーム内ですでに計算済みの場合はキャッシュを返却
    if (state.lastComputedTime === timestamp) {
      return {
        vy: state.currentVy,
        ay: state.currentAy,
        lastVy: state.prevVy,
      };
    }

    const dt = (timestamp - state.lastTime) / 1000.0; // 秒単位

    // タイムスタンプ異常または長時間追跡中断時はリセット
    if (dt <= 0.001 || dt > 0.3) {
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

    // 垂直方向速度 (下向き移動を正とする)
    const vy = (y - state.lastY) / dt;
    // 垂直方向加速度 (下向き加速が正、急減速・衝突が負の急峻ピーク)
    const ay = (vy - state.lastVy) / dt;
    const prevVy = state.lastVy;

    // 能動的振り下ろし（アクティブダウン）の検知と記憶
    const isWeakFinger = tipIndex === 4 || tipIndex === 20 || tipIndex === 16;
    const effectiveMinDownVelocity = isWeakFinger ? this.minDownVelocity * 0.40 : this.minDownVelocity;
    if (vy >= effectiveMinDownVelocity) {
      state.lastActiveDownTime = timestamp;
      state.maxActiveDownVy = Math.max(state.maxActiveDownVy, vy);
    }

    // 指が上向きに引き上げられた場合は振り下ろし状態をクリア
    if (vy < -0.15) {
      state.lastActiveDownTime = -9999;
      state.maxActiveDownVy = 0;
    }

    // 状態更新
    state.currentVy = vy;
    state.currentAy = ay;
    state.prevVy = prevVy;
    state.lastComputedTime = timestamp;
    state.lastTime = timestamp;
    state.lastY = y;
    state.lastVy = vy;

    return { vy, ay, lastVy: prevVy };
  }

  /**
   * 同手内の全指先の最新座標を一括登録し、各指の垂直速度 (vy) を同期更新する
   * 他指との相対速度比較（Winner-Take-All）を正確に行うために打鍵評価前に呼び出す
   */
  updateHandFingertips(
    handedness: 'Left' | 'Right',
    fingertips: { tipIndex: number; y: number }[],
    timestamp: number
  ): void {
    for (const tip of fingertips) {
      this.updateFingerDynamics(handedness, tip.tipIndex, tip.y, timestamp);
    }
  }

  /**
   * 単一の指先座標を評価し、能動的振り下ろし＋机衝突の急減速が成立した場合に TapEvent を返す
   * 打鍵確定直前に同手の他指との相対速度比較（Winner-Take-All）を行い、つられた指の誤爆を防止する
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
    const dynamics = this.updateFingerDynamics(handedness, tipIndex, y, timestamp);
    const state = this.fingerStates.get(key);

    if (!dynamics || !state) {
      return null;
    }

    const { vy, ay, lastVy } = dynamics;

    // 親指(4)、小指(20)、薬指(16)は独立した垂直可動域が小さく力が出にくいため、感度を専用ブースト
    const isWeakFinger = tipIndex === 4 || tipIndex === 20 || tipIndex === 16;
    const effectiveMinDownVelocity = isWeakFinger ? this.minDownVelocity * 0.40 : this.minDownVelocity;
    const effectiveMinDecelPeak = isWeakFinger ? this.minDecelPeak * 0.40 : this.minDecelPeak;
    const effectiveAyThreshold = isWeakFinger ? -3.0 : -6.0;

    const timeSinceLastTap = timestamp - state.lastTapTime;
    const isCoolingDown = timeSinceLastTap < this.cooldownMs;

    let tapEvent: TapEvent | null = null;

    if (!isCoolingDown) {
      // 直近 (maxDownToImpactMs 以内) に十分なスピードの振り下ろしが発生しているか
      const hasRecentActiveDown =
        timestamp - state.lastActiveDownTime <= this.maxDownToImpactMs &&
        state.maxActiveDownVy >= effectiveMinDownVelocity;

      // 段階2: 机衝突による物理的急減速（負の急峻な加速度ピーク または 強い制動）
      const hasDecelPeak = ay <= effectiveMinDecelPeak;
      const hasSharpVelocityDrop =
        lastVy >= effectiveMinDownVelocity &&
        vy <= lastVy * 0.40 &&
        ay <= effectiveAyThreshold;

      if (hasRecentActiveDown && (hasDecelPeak || hasSharpVelocityDrop)) {
        // 振り下ろしピーク速度を元にベロシティ (0.2 ~ 1.0) を算出
        const impactSpeed = Math.max(lastVy, state.maxActiveDownVy);
        const velocity = Math.min(1.0, Math.max(0.2, impactSpeed / (isWeakFinger ? 1.0 : 1.6)));

        // --- 要件: 他指との相対速度比較（Winner-Take-All）発火ガード ---
        // 打鍵指の振り下ろし速度（衝突時の減速前速度とアクティブダウン最大速度を考慮）
        const targetFingerVy = Math.max(vy, lastVy, state.maxActiveDownVy);

        // 同手内の他4本の指について、下向き速度 (vy <= 0 は 0 として扱う) の最大値を走査
        let maxOtherVy = 0;
        for (const otherTipIndex of [4, 8, 12, 16, 20]) {
          if (otherTipIndex === tipIndex) continue;
          const otherState = this.fingerStates.get(`${handedness}_${otherTipIndex}`);
          if (otherState) {
            const downVy = Math.max(0, otherState.currentVy);
            if (downVy > maxOtherVy) {
              maxOtherVy = downVy;
            }
          }
        }

        // 他指がほぼ静止状態 (0.02未満) の場合は 0 として扱い、ゼロ除算や不当なブロックを回避
        const effectiveOtherVy = maxOtherVy < 0.02 ? 0 : maxOtherVy;
        const ratio = effectiveOtherVy > 0.0001 ? targetFingerVy / effectiveOtherVy : 99.99;
        const ratioStr = effectiveOtherVy > 0.0001 ? ratio.toFixed(2) : '∞';
        const fingerLabel = `${handedness === 'Left' ? '左手' : '右手'}${name}`;

        // 相対速度比率条件: targetFingerVy > maxOtherVy * K を満たす場合のみ発火
        if (targetFingerVy <= effectiveOtherVy * this.relativeVelocityRatio) {
          // 他指の下降速度の方が速い、または他指につられて動いた誤爆と判定し破棄
          this.latestGateResult = {
            targetFingerName: fingerLabel,
            targetVy: targetFingerVy,
            maxOtherVy: effectiveOtherVy,
            ratio,
            lastResult: 'BLOCKED: 共連れ抑止',
            timestamp,
          };
          console.log(
            `[TapGate] BLOCKED: targetVy=${targetFingerVy.toFixed(2)}, maxOtherVy=${effectiveOtherVy.toFixed(2)}, ratio=${ratioStr}, K=${this.relativeVelocityRatio.toFixed(1)}`
          );
          return null;
        }

        this.latestGateResult = {
          targetFingerName: fingerLabel,
          targetVy: targetFingerVy,
          maxOtherVy: effectiveOtherVy,
          ratio,
          lastResult: 'PASS: 打鍵発火',
          timestamp,
        };
        console.log(
          `[TapGate] PASS: targetVy=${targetFingerVy.toFixed(2)}, maxOtherVy=${effectiveOtherVy.toFixed(2)}, ratio=${ratioStr}, K=${this.relativeVelocityRatio.toFixed(1)}`
        );

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

    return tapEvent;
  }

  /**
   * トラッキング中断時などの状態全リセット
   */
  reset(): void {
    this.fingerStates.clear();
  }
}
