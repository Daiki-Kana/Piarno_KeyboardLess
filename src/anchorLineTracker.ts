/**
 * 相互アンカー追従ライン計算および打鍵判定ステートマシンモジュール
 * 
 * 指定指の先端座標を基準とし、手の基準スケール L_hand に比例した動的オフセットを加えることで
 * 常に指定指の直下（少し下）を追従するラインを算出する。
 * さらに、3段階＋RESETステートマシン（IDLE / ARMED / HIT / RESET）により
 * 机面への衝突・最下点反転の瞬間のみを正確に検知する。
 */

export type FingertipLandmarkIndex = 4 | 8 | 12 | 16 | 20;

export interface AnchorLineConfig {
  /**
   * 指定指の先端から判定ラインまでの直下オフセット比率（L_hand に対する比率）
   */
  lineOffsetRatio: number;

  /**
   * HIT発火後のクールダウン時間 (ms)
   */
  cooldownMs: number;

  /**
   * RESETからIDLEへ復帰するための上空マージン比率（L_hand に対する比率）
   */
  resetMarginRatio: number;

  /**
   * 各指ごとの解剖学的長さ差異比率（L_hand 比例係数）
   * 未指定の指はデフォルト値が使用される
   */
  fingerDiffRatios?: Partial<Record<FingertipLandmarkIndex, number>>;
}

/**
 * 各指の解剖学的長さ差異のデフォルト値（アンカー指に対する L_hand 比例オフセット）
 * - 親指 (4): アンカーは人差し指 (8)。親指先端は手首側にあるためマイナス
 * - 人差し指 (8): アンカーは中指 (12)。中指より少し手首側
 * - 中指 (12): アンカーは人差し指 (8)。人差し指より手先側
 * - 薬指 (16): アンカーは中指 (12)。中指より手首側
 * - 小指 (20): アンカーは薬指 (16)。薬指より手首側
 */
export const DEFAULT_FINGER_DIFF_RATIOS: Record<FingertipLandmarkIndex, number> = {
  4: -0.16,  // 親指 (Thumb)
  8: -0.05,  // 人差し指 (Index)
  12: +0.05, // 中指 (Middle)
  16: -0.06, // 薬指 (Ring)
  20: -0.14, // 小指 (Pinky)
};

/**
 * 指定指に対応するアンカー指のランドマークインデックスを取得
 */
export function getAnchorTipIndex(targetIndex: FingertipLandmarkIndex): FingertipLandmarkIndex {
  switch (targetIndex) {
    case 4:
      return 8;  // 親指 -> 人差し指 (8)
    case 8:
      return 12; // 人差し指 -> 中指 (12)
    case 12:
      return 8;  // 中指 -> 人差し指 (8)
    case 16:
      return 12; // 薬指 -> 中指 (12)
    case 20:
      return 16; // 小指 -> 薬指 (16)
    default:
      return 12;
  }
}

/**
 * ランドマークインデックスから指の表示名を取得
 */
export function getFingerInfo(index: FingertipLandmarkIndex): { nameEn: string; nameJp: string } {
  switch (index) {
    case 4:
      return { nameEn: 'THUMB', nameJp: '親指' };
    case 8:
      return { nameEn: 'INDEX', nameJp: '人差し指' };
    case 12:
      return { nameEn: 'MIDDLE', nameJp: '中指' };
    case 16:
      return { nameEn: 'RING', nameJp: '薬指' };
    case 20:
      return { nameEn: 'PINKY', nameJp: '小指' };
  }
}

export const DEFAULT_ANCHOR_CONFIG: AnchorLineConfig = {
  lineOffsetRatio: 0.50,
  cooldownMs: 80,
  resetMarginRatio: 0.10,
  fingerDiffRatios: { ...DEFAULT_FINGER_DIFF_RATIOS },
};

export type TapState = 'IDLE' | 'ARMED' | 'HIT' | 'RESET';

export interface TapEvaluation {
  state: TapState;
  isHit: boolean;
  velocity: number;
}

export interface AnchorLineResult {
  /** 手の基準スケール L_hand (ピクセル) */
  lHand: number;
  /** アンカー指先Y座標 (ピクセル) */
  anchorY: number;
  /** アンカー指のランドマークインデックス */
  anchorTipIndex: FingertipLandmarkIndex;
  /** アンカー指の名称 */
  anchorFingerName: string;
  /** 計算された判定ラインY座標 (ピクセル) */
  lineY: number;
  /** 指定指の先端X座標 (ピクセル) */
  targetX: number;
  /** 指定指の先端Y座標 (ピクセル) */
  targetY: number;
  /** 指定指のランドマークインデックス */
  targetTipIndex: FingertipLandmarkIndex;
  /** 指定指から判定ラインまでの垂直距離 (targetY - lineY: 負ならラインより上、正ならライン突破) */
  depthFromLine: number;
  /** オフセット幅 (ピクセル) */
  offsetPx: number;
  /** 現在の打鍵ステートマシン評価結果 */
  tapEvaluation: TapEvaluation;
}

export class AnchorLineTracker {
  private config: AnchorLineConfig;

  // ステートマシン内部状態
  private state: TapState = 'IDLE';
  private lastTargetY = 0;
  private lastHitTime = -9999;
  private lastTimestamp = -1;

  constructor(config: Partial<AnchorLineConfig> = {}) {
    this.config = {
      ...DEFAULT_ANCHOR_CONFIG,
      ...config,
      fingerDiffRatios: {
        ...DEFAULT_FINGER_DIFF_RATIOS,
        ...(config.fingerDiffRatios || {}),
      },
    };
  }

  /**
   * オフセット比率の更新
   */
  setOffsetRatio(ratio: number): void {
    this.config.lineOffsetRatio = Math.max(0.01, Math.min(0.80, ratio));
  }

  /**
   * 特定の指に対する解剖学的オフセット比率の更新
   */
  setFingerDiffRatio(fingerIndex: FingertipLandmarkIndex, ratio: number): void {
    if (!this.config.fingerDiffRatios) {
      this.config.fingerDiffRatios = { ...DEFAULT_FINGER_DIFF_RATIOS };
    }
    this.config.fingerDiffRatios[fingerIndex] = ratio;
  }

  /**
   * 現在の設定を取得
   */
  getConfig(): AnchorLineConfig {
    return { ...this.config };
  }

  /**
   * 手の基準スケール L_hand を算出
   * 手首（Landmark 0）から中指MCP（Landmark 9）のピクセル間距離
   */
  calculateHandScale(
    landmarks: { x: number; y: number; z: number }[],
    canvasWidth: number,
    canvasHeight: number
  ): number {
    const wrist = landmarks[0];
    const middleMcp = landmarks[9];

    if (!wrist || !middleMcp) return 0;

    const x0 = wrist.x * canvasWidth;
    const y0 = wrist.y * canvasHeight;
    const x9 = middleMcp.x * canvasWidth;
    const y9 = middleMcp.y * canvasHeight;

    return Math.hypot(x9 - x0, y9 - y0);
  }

  /**
   * 指定指の切り替え時などにステートマシンをリセット
   */
  resetState(): void {
    this.state = 'IDLE';
    this.lastTargetY = 0;
    this.lastTimestamp = -1;
  }

  /**
   * 打鍵判定ステートマシンのステップ実行
   * 
   * - IDLE: 指先が Line_Y より上空。ラインを通過した瞬間に即座に HIT 発火！
   * - HIT: 発音後、直ちに RESET へ移行
   * - RESET: 指先が Line_Y - (L_hand * resetMarginRatio) より上空に戻ったら IDLE へ復帰
   */
  private updateStateMachine(
    targetY: number,
    lineY: number,
    lHand: number,
    timestamp: number
  ): TapEvaluation {
    let dt = this.lastTimestamp > 0 ? (timestamp - this.lastTimestamp) / 1000.0 : 0.016;
    if (dt <= 0.001 || dt > 0.3) dt = 0.016;

    const vy = (targetY - this.lastTargetY) / dt; // 下向きが正 (px/s)
    let isHit = false;
    let velocity = 0;

    // リセット閾値（Line_Y より一定量上空）
    const resetThresholdY = lineY - (lHand * this.config.resetMarginRatio);

    switch (this.state) {
      case 'IDLE': {
        // ライン通過の瞬間に即座に打鍵を発火
        if (targetY >= lineY) {
          const isCooldownElapsed = timestamp - this.lastHitTime >= this.config.cooldownMs;
          if (isCooldownElapsed) {
            this.state = 'HIT';
            this.lastHitTime = timestamp;
            isHit = true;
            const normalizedVel = (Math.max(vy, 30)) / 300;
            velocity = Math.min(1.0, Math.max(0.4, normalizedVel));
          }
        }
        break;
      }

      case 'HIT': {
        this.state = 'RESET';
        break;
      }

      case 'RESET': {
        // 指先が基準ラインより上空（マージン分）に戻った時点でIDLEへ復帰
        if (targetY < resetThresholdY) {
          this.state = 'IDLE';
        }
        break;
      }
    }

    this.lastTargetY = targetY;
    this.lastTimestamp = timestamp;

    return {
      state: this.state,
      isHit,
      velocity,
    };
  }

  /**
   * 動的ラインの計算および打鍵判定ステートマシンの実行
   */
  calculateLine(
    landmarks: { x: number; y: number; z: number }[],
    targetTipIndex: FingertipLandmarkIndex,
    canvasWidth: number,
    canvasHeight: number,
    timestamp: number
  ): AnchorLineResult | null {
    if (!landmarks || landmarks.length < 21) return null;

    // 手の基準スケール L_hand を算出
    const lHand = this.calculateHandScale(landmarks, canvasWidth, canvasHeight);
    if (lHand <= 0) return null;

    const targetTip = landmarks[targetTipIndex];
    if (!targetTip) return null;

    // 指定指に対応するアンカー指を取得
    const anchorTipIndex = getAnchorTipIndex(targetTipIndex);
    const anchorTip = landmarks[anchorTipIndex];
    if (!anchorTip) return null;

    const targetX = targetTip.x * canvasWidth;
    const targetY = targetTip.y * canvasHeight;
    const anchorY = anchorTip.y * canvasHeight;

    const anchorInfo = getFingerInfo(anchorTipIndex);
    const anchorFingerName = `${anchorInfo.nameJp} (Landmark ${anchorTipIndex})`;

    // 指固有の解剖学的長さ比率を取得
    const fingerDiffRatio =
      this.config.fingerDiffRatios?.[targetTipIndex] ??
      DEFAULT_FINGER_DIFF_RATIOS[targetTipIndex] ??
      0;

    // アンカー指のY座標を基準とした相互アンカー追従ライン Line_Y
    const offsetPx = (fingerDiffRatio + this.config.lineOffsetRatio) * lHand;
    const lineY = anchorY + offsetPx;
    const depthFromLine = targetY - lineY;

    // 3段階ステートマシンの評価
    const tapEvaluation = this.updateStateMachine(targetY, lineY, lHand, timestamp);

    return {
      lHand,
      anchorY,
      anchorTipIndex,
      anchorFingerName,
      lineY,
      targetX,
      targetY,
      targetTipIndex,
      depthFromLine,
      offsetPx,
      tapEvaluation,
    };
  }
}
