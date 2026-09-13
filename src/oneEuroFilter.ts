/**
 * 1 Euro Filter (Casiez et al., CHI 2012)
 * 低速時の手振れジッターを除去しつつ、高速動作時のレイテンシを極小化する適応型ローパスフィルタ
 */

export interface OneEuroFilterConfig {
  /** 最小カットオフ周波数 (Hz) - 低速・静止時のジッター抑制 (デフォルト: 1.2) */
  minCutoff?: number;
  /** 速度係数 - 高速移動時のカットオフ上昇感度 (デフォルト: 8.0 ※正規化座標 0~1 向けに最適化) */
  beta?: number;
  /** 速度計算用の平滑化カットオフ周波数 (Hz) (デフォルト: 1.0) */
  dCutoff?: number;
}

class LowPassFilter {
  private y: number | null = null;
  private s: number | null = null;

  filter(value: number, alpha: number): number {
    if (this.y === null) {
      this.s = value;
    } else {
      this.s = alpha * value + (1.0 - alpha) * this.s!;
    }
    this.y = value;
    return this.s;
  }

  hasLast(): boolean {
    return this.y !== null;
  }

  last(): number {
    return this.s ?? 0;
  }

  reset(): void {
    this.y = null;
    this.s = null;
  }
}

export class OneEuroFilter {
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;
  private xFilter = new LowPassFilter();
  private dxFilter = new LowPassFilter();
  private lastTimestamp: number | null = null;

  constructor(config: OneEuroFilterConfig = {}) {
    this.minCutoff = config.minCutoff ?? 1.2;
    this.beta = config.beta ?? 8.0;
    this.dCutoff = config.dCutoff ?? 1.0;
  }

  /**
   * 単一値の平滑化
   * @param value 対象値
   * @param timestamp ミリ秒単位のタイムスタンプ (performance.now() 等)
   */
  filter(value: number, timestamp: number): number {
    if (this.lastTimestamp === null) {
      this.lastTimestamp = timestamp;
      return this.xFilter.filter(value, 1.0);
    }

    const dt = (timestamp - this.lastTimestamp) / 1000.0; // 秒単位
    this.lastTimestamp = timestamp;

    if (dt <= 0 || dt > 0.5) {
      // タイムスタンプ異常または長時間の中断時はリセット
      this.reset();
      this.lastTimestamp = timestamp;
      return this.xFilter.filter(value, 1.0);
    }

    // 速度（変化率）の算出と平滑化
    const prevValue = this.xFilter.last();
    const dx = (value - prevValue) / dt;
    const edx = this.dxFilter.filter(dx, this.alpha(dt, this.dCutoff));

    // 速度に応じた動的カットオフ周波数の計算
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.xFilter.filter(value, this.alpha(dt, cutoff));
  }

  private alpha(dt: number, cutoff: number): number {
    const tau = 1.0 / (2.0 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / dt);
  }

  reset(): void {
    this.xFilter.reset();
    this.dxFilter.reset();
    this.lastTimestamp = null;
  }
}

export interface Point3D {
  x: number;
  y: number;
  z: number;
}

export class OneEuroFilter3D {
  private filterX: OneEuroFilter;
  private filterY: OneEuroFilter;
  private filterZ: OneEuroFilter;

  constructor(config: OneEuroFilterConfig = {}) {
    this.filterX = new OneEuroFilter(config);
    this.filterY = new OneEuroFilter(config);
    this.filterZ = new OneEuroFilter(config);
  }

  filter(point: Point3D, timestamp: number): Point3D {
    return {
      x: this.filterX.filter(point.x, timestamp),
      y: this.filterY.filter(point.y, timestamp),
      z: this.filterZ.filter(point.z, timestamp),
    };
  }

  reset(): void {
    this.filterX.reset();
    this.filterY.reset();
    this.filterZ.reset();
  }
}
