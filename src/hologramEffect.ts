/**
 * ARホログラムエフェクト管理クラス
 * 音響や打鍵検知から独立して視覚演出を一元管理する
 */

/**
 * ターゲット指情報
 */
export interface TargetFingerInfo {
  fingerId: number;
  hand: 'Left' | 'Right';
}

/**
 * 2次元座標
 */
export interface Point2D {
  x: number;
  y: number;
}

/**
 * 打鍵イベント情報
 */
export interface TapTriggerEvent {
  fingerId: number;
  position: Point2D;
  timestamp: number;
}

/**
 * ホログラム演出の描画スタイル定数（白黒・モノトーン基調）
 */
export const HOLOGRAM_STYLES = {
  // カラー定義（モノトーン・白黒基調）
  COLOR_WHITE_SOLID: 'rgba(255, 255, 255, 1.0)',
  COLOR_WHITE_HIGH: 'rgba(255, 255, 255, 0.85)',
  COLOR_WHITE_MID: 'rgba(255, 255, 255, 0.7)',
  COLOR_WHITE_LOW: 'rgba(255, 255, 255, 0.2)',
  COLOR_BLACK_SOLID: 'rgba(0, 0, 0, 1.0)',
  COLOR_BLACK_ALPHA: 'rgba(0, 0, 0, 0.6)',

  // 連続打鍵数に応じたカラー定義
  // 1回: 水色 (Cyan)
  COLOR_1TAP_STROKE: 'rgba(0, 229, 255, 0.95)',
  COLOR_1TAP_FILL: 'rgba(0, 229, 255, 0.22)',
  COLOR_1TAP_GLOW: '#00e5ff',

  // 2回: 緑 (Green)
  COLOR_2TAP_STROKE: 'rgba(0, 230, 118, 0.95)',
  COLOR_2TAP_FILL: 'rgba(0, 230, 118, 0.22)',
  COLOR_2TAP_GLOW: '#00e676',

  // 3回以上: 黄色 (Yellow)
  COLOR_3TAP_STROKE: 'rgba(255, 214, 0, 0.95)',
  COLOR_3TAP_FILL: 'rgba(255, 214, 0, 0.22)',
  COLOR_3TAP_GLOW: '#ffd600',

  // 線幅
  LINE_WIDTH_MARKER: 2.5,
  LINE_WIDTH_THIN: 1.0,

  // 発光（ネオングロー）設定
  GLOW_BLUR: 10,

  // アニメーション定数
  FADE_DURATION_MS: 250,
} as const;

/**
 * 打鍵ホログラムエフェクト（ショックウェーブ波紋＋スターダスト粒子＋インパクト閃光）のスタイル定義
 */
export const TAP_EFFECT_STYLE = {
  // 全体継続時間 (ms)
  DURATION_MS: 320,

  // コア閃光フラッシュ持続時間 (ms)
  FLASH_DURATION_MS: 75,

  // 最大波紋半径基準 (px)
  BASE_RIPPLE_RADIUS: 48,

  // パーティクル飛散数
  PARTICLE_COUNT: 8,

  // 発光グローブラー (px)
  GLOW_BLUR: 15,
} as const;

/**
 * 打鍵時に弾け飛ぶ光の微粒子（スターダスト）
 */
export interface TapParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  glowColor: string;
}

/**
 * 打鍵インパクトエフェクト情報
 */
export interface TapImpactEffect {
  fingerId: number;
  position: Point2D; // 正規化座標
  pixelPos?: Point2D; // 初期生成時の実ピクセル座標
  startTime: number;
  duration: number;
  velocity: number;
  consecutiveCount: number;
  particles: TapParticle[];
}

// 後方互換用エイリアス
export type ContactDot = TapImpactEffect;
export const CONTACT_DOT_STYLE = TAP_EFFECT_STYLE;

/**
 * ARホログラムエフェクトマネージャー
 */
export class HologramEffectManager {
  private currentTarget: TargetFingerInfo | null = null;
  private nextTarget: TargetFingerInfo | null = null;
  private consecutiveCount: number = 1;
  private lastTimestamp: number = 0;
  private tapEffects: TapImpactEffect[] = [];

  /**
   * 現在および次のターゲット指、および現在の連続打鍵数を指定
   * @param currentTarget 現在打鍵すべきターゲット指
   * @param nextTarget 次に打鍵すべきターゲット指
   * @param consecutiveCount 現在の指で連続して打鍵すべき残り回数 (1: 水色, 2: 緑, 3以上: 黄色)
   */
  public setTargets(
    currentTarget: TargetFingerInfo | null,
    nextTarget: TargetFingerInfo | null,
    consecutiveCount: number = 1
  ): void {
    this.currentTarget = currentTarget;
    this.nextTarget = nextTarget;
    this.consecutiveCount = consecutiveCount;
  }

  /**
   * 打鍵イベントを受信し、指先接地点にネオンショックウェーブ＆飛沫パーティクルを生成
   * @param fingerId 打鍵された指番号
   * @param position 指先の正規化座標 (x: 0~1, y: 0~1)
   * @param velocity 打鍵の強さ（相対速度・ベロシティ）
   * @param pixelPos 実ピクセル座標（オプション）
   */
  public triggerTap(
    fingerId: number,
    position: Point2D,
    velocity: number = 1.0,
    pixelPos?: Point2D
  ): void {
    const effect: TapImpactEffect = {
      fingerId,
      position,
      pixelPos,
      startTime: this.lastTimestamp,
      duration: TAP_EFFECT_STYLE.DURATION_MS,
      velocity: Math.max(0.6, velocity),
      consecutiveCount: this.consecutiveCount,
      particles: [],
    };

    if (pixelPos) {
      this.initParticles(effect, pixelPos.x, pixelPos.y);
    }

    this.tapEffects.push(effect);
  }

  /**
   * 時間経過によるアニメーション状態の更新
   * @param timestamp 現在のタイムスタンプ (ms)
   */
  public update(timestamp: number): void {
    this.lastTimestamp = timestamp;

    // 寿命を迎えたエフェクトを除外
    if (this.tapEffects.length > 0) {
      this.tapEffects = this.tapEffects.filter(
        (effect) => timestamp - effect.startTime < effect.duration
      );

      // 飛散パーティクルの位置更新（速度減衰＋わずかな上昇気流）
      for (const effect of this.tapEffects) {
        for (const p of effect.particles) {
          p.x += p.vx;
          p.y += p.vy;
          p.vx *= 0.92;
          p.vy *= 0.92;
        }
      }
    }
  }

  /**
   * Canvasへのホログラム描画
   * @param ctx 描画対象の2Dコンテキスト
   * @param landmarksMap 各手のキー ('Left' | 'Right') とランドマーク配列 (正規化座標) のマップ
   */
  public render(
    ctx: CanvasRenderingContext2D,
    landmarksMap: Map<string, Point2D[]>
  ): void {
    const width = ctx.canvas.width;
    const height = ctx.canvas.height;
    if (width === 0 || height === 0) return;

    // 0. 打鍵時の指先ホログラムエフェクト（ショックウェーブ波紋＋スターダスト＋閃光）描画
    this.renderTapEffects(ctx, width, height);

    if (landmarksMap.size === 0) return;

    const currentPos = this.getTargetPixelPosition(
      this.currentTarget,
      landmarksMap,
      width,
      height
    );
    const nextPos = this.getTargetPixelPosition(
      this.nextTarget,
      landmarksMap,
      width,
      height
    );

    // 同一指の連続打鍵判定
    const isConsecutiveSameFinger = Boolean(
      this.currentTarget &&
        this.nextTarget &&
        this.currentTarget.hand === this.nextTarget.hand &&
        this.currentTarget.fingerId === this.nextTarget.fingerId
    );

    // 1. 次指への空中立体アーチ（両座標が存在し、同一指連続打鍵でない場合のみ描画）
    if (currentPos && nextPos && !isConsecutiveSameFinger) {
      this.renderProjectionArch(ctx, currentPos, nextPos);
    }

    // 2. 現在のターゲット指への円マーカー描画（シンプルな丸表示、連続打鍵数で色分け）
    if (currentPos) {
      this.renderTargetRing(ctx, currentPos);
    }
  }

  /**
   * 打鍵時に飛散するスターダスト・パーティクルの初期化
   */
  private initParticles(effect: TapImpactEffect, px: number, py: number): void {
    effect.pixelPos = { x: px, y: py };
    const count = TAP_EFFECT_STYLE.PARTICLE_COUNT;
    const velScale = Math.min(1.8, Math.max(0.8, effect.velocity));

    let glowColor = '#00e5ff';
    let baseColor = 'rgba(0, 229, 255, ';
    if (effect.consecutiveCount >= 3) {
      glowColor = '#ffd600';
      baseColor = 'rgba(255, 214, 0, ';
    } else if (effect.consecutiveCount === 2) {
      glowColor = '#00e676';
      baseColor = 'rgba(0, 230, 118, ';
    }

    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
      const speed = (2.2 + Math.random() * 3.4) * velScale;
      const isWhite = i % 2 === 0;

      effect.particles.push({
        x: px,
        y: py,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 0.7,
        size: 1.8 + Math.random() * 2.2,
        color: isWhite ? 'rgba(255, 255, 255, 0.95)' : `${baseColor}0.95)`,
        glowColor: isWhite ? '#ffffff' : glowColor,
      });
    }
  }

  /**
   * 打鍵ホログラムエフェクト（ショックウェーブ波紋＋パーティクル＋発光閃光）の描画
   */
  private renderTapEffects(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number
  ): void {
    if (this.tapEffects.length === 0) return;

    for (const effect of this.tapEffects) {
      const elapsed = this.lastTimestamp - effect.startTime;
      if (elapsed < 0 || elapsed >= effect.duration) continue;

      const progress = elapsed / effect.duration; // 0.0 ~ 1.0
      const px = effect.pixelPos ? effect.pixelPos.x : effect.position.x * width;
      const py = effect.pixelPos ? effect.pixelPos.y : effect.position.y * height;

      // 初回パーティクル生成（未初期化の場合）
      if (effect.particles.length === 0) {
        this.initParticles(effect, px, py);
      }

      // 連続打鍵数に応じたネオンカラー
      let strokeColor = 'rgba(0, 229, 255, ';
      let glowColor = '#00e5ff';
      if (effect.consecutiveCount >= 3) {
        strokeColor = 'rgba(255, 214, 0, ';
        glowColor = '#ffd600';
      } else if (effect.consecutiveCount === 2) {
        strokeColor = 'rgba(0, 230, 118, ';
        glowColor = '#00e676';
      }

      const easeOut = 1 - Math.pow(1 - progress, 3);
      const velScale = Math.min(1.8, Math.max(0.7, effect.velocity));
      const ringAlpha = Math.max(0, 1.0 - progress);

      ctx.save();

      // 1. コア・インパクト閃光（打鍵直後 0 ~ 75ms）
      if (elapsed < TAP_EFFECT_STYLE.FLASH_DURATION_MS) {
        const flashProgress = elapsed / TAP_EFFECT_STYLE.FLASH_DURATION_MS;
        const flashAlpha = 1.0 - flashProgress;
        const flashRadius = 14 * (1.0 - flashProgress * 0.3) * velScale;

        // 中心高輝度ホワイト閃光
        ctx.beginPath();
        ctx.arc(px, py, flashRadius, 0, 2 * Math.PI);
        ctx.fillStyle = `rgba(255, 255, 255, ${(0.95 * flashAlpha).toFixed(3)})`;
        ctx.shadowColor = '#ffffff';
        ctx.shadowBlur = 18 * flashAlpha;
        ctx.fill();

        // 周囲ネオンハロー
        ctx.beginPath();
        ctx.arc(px, py, flashRadius * 1.6, 0, 2 * Math.PI);
        ctx.fillStyle = `${strokeColor}${(0.45 * flashAlpha).toFixed(3)})`;
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = 24 * flashAlpha;
        ctx.fill();
      }

      // 2. メイン・ショックウェーブリング (外側波紋)
      const outerRadius = 14 + (TAP_EFFECT_STYLE.BASE_RIPPLE_RADIUS * velScale) * easeOut;

      ctx.beginPath();
      ctx.arc(px, py, outerRadius, 0, 2 * Math.PI);
      ctx.lineWidth = Math.max(1.0, 3.2 * (1.0 - progress * 0.65));
      ctx.strokeStyle = `${strokeColor}${(ringAlpha * 0.95).toFixed(3)})`;
      ctx.shadowColor = glowColor;
      ctx.shadowBlur = TAP_EFFECT_STYLE.GLOW_BLUR * ringAlpha;
      ctx.stroke();

      // 波紋内側の微かな発光面
      ctx.beginPath();
      ctx.arc(px, py, outerRadius, 0, 2 * Math.PI);
      ctx.fillStyle = `${strokeColor}${(ringAlpha * 0.12).toFixed(3)})`;
      ctx.fill();

      // 3. セカンダリ・追従リング (内側波紋)
      const innerProgress = Math.max(0, (progress - 0.08) / 0.92);
      if (innerProgress > 0) {
        const innerEase = 1 - Math.pow(1 - innerProgress, 2.5);
        const innerRadius = 8 + (TAP_EFFECT_STYLE.BASE_RIPPLE_RADIUS * 0.62 * velScale) * innerEase;
        const innerAlpha = Math.max(0, 1.0 - innerProgress);

        ctx.beginPath();
        ctx.arc(px, py, innerRadius, 0, 2 * Math.PI);
        ctx.lineWidth = Math.max(0.8, 1.8 * (1.0 - innerProgress));
        ctx.strokeStyle = `rgba(255, 255, 255, ${(innerAlpha * 0.85).toFixed(3)})`;
        ctx.shadowColor = '#ffffff';
        ctx.shadowBlur = 8 * innerAlpha;
        ctx.stroke();
      }

      // 4. スターダスト・パーティクル（光の飛沫）
      for (const p of effect.particles) {
        const pAlpha = ringAlpha;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(0.6, p.size * ringAlpha), 0, 2 * Math.PI);
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.glowColor;
        ctx.shadowBlur = 8 * pAlpha;
        ctx.fill();
      }

      ctx.restore();
    }
  }

  /**
   * 指定したターゲット指のキャンバスピクセル座標を取得（画面外または未検出時はnull）
   */
  private getTargetPixelPosition(
    target: TargetFingerInfo | null,
    landmarksMap: Map<string, Point2D[]>,
    width: number,
    height: number
  ): Point2D | null {
    if (!target) return null;
    const handLandmarks = landmarksMap.get(target.hand);
    if (!handLandmarks || target.fingerId < 0 || target.fingerId >= handLandmarks.length) {
      return null;
    }
    const rawPoint = handLandmarks[target.fingerId];
    if (!rawPoint) return null;

    // 画面外または無効値ガード
    if (
      Number.isNaN(rawPoint.x) ||
      Number.isNaN(rawPoint.y) ||
      rawPoint.x < 0 ||
      rawPoint.x > 1 ||
      rawPoint.y < 0 ||
      rawPoint.y > 1
    ) {
      return null;
    }

    return {
      x: rawPoint.x * width,
      y: rawPoint.y * height,
    };
  }

  /**
   * ターゲット指のシンプルな円マーカー描画（波紋なし・連続打鍵数に応じた色分け）
   * 1回: 水色 / 2回: 緑 / 3回以上: 黄色
   * @param ctx 描画コンテキスト
   * @param currentPos ターゲット指のピクセル座標
   */
  private renderTargetRing(
    ctx: CanvasRenderingContext2D,
    currentPos: Point2D
  ): void {
    ctx.save();

    // 連続打鍵数に応じた色設定（1回: 水色 / 2回: 緑 / 3回以上: 黄色）
    let strokeColor: string;
    let fillColor: string;
    let glowColor: string;

    if (this.consecutiveCount >= 3) {
      strokeColor = HOLOGRAM_STYLES.COLOR_3TAP_STROKE;
      fillColor = HOLOGRAM_STYLES.COLOR_3TAP_FILL;
      glowColor = HOLOGRAM_STYLES.COLOR_3TAP_GLOW;
    } else if (this.consecutiveCount === 2) {
      strokeColor = HOLOGRAM_STYLES.COLOR_2TAP_STROKE;
      fillColor = HOLOGRAM_STYLES.COLOR_2TAP_FILL;
      glowColor = HOLOGRAM_STYLES.COLOR_2TAP_GLOW;
    } else {
      strokeColor = HOLOGRAM_STYLES.COLOR_1TAP_STROKE;
      fillColor = HOLOGRAM_STYLES.COLOR_1TAP_FILL;
      glowColor = HOLOGRAM_STYLES.COLOR_1TAP_GLOW;
    }

    // ネオングロー（発光）設定
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = HOLOGRAM_STYLES.GLOW_BLUR;

    const radius = 16;

    // 半透明の背景塗り（肌色や木目背景から浮かび上がらせる）
    ctx.beginPath();
    ctx.arc(currentPos.x, currentPos.y, radius, 0, 2 * Math.PI);
    ctx.fillStyle = fillColor;
    ctx.fill();

    // 明瞭な円周輪郭線
    ctx.lineWidth = HOLOGRAM_STYLES.LINE_WIDTH_MARKER;
    ctx.strokeStyle = strokeColor;
    ctx.stroke();

    // 中心の高輝度ドット
    ctx.beginPath();
    ctx.arc(currentPos.x, currentPos.y, 3.5, 0, 2 * Math.PI);
    ctx.fillStyle = strokeColor;
    ctx.fill();

    ctx.restore();
  }

  /**
   * 次指への空中立体アーチ（視線誘導破線）の描画
   * @param ctx 描画コンテキスト
   * @param startPos 現在指のピクセル座標
   * @param endPos 次回指のピクセル座標
   */
  private renderProjectionArch(
    ctx: CanvasRenderingContext2D,
    startPos: Point2D,
    endPos: Point2D
  ): void {
    ctx.save();

    // 始点から終点へ向けて上方に凸となる2次ベジェ曲線
    const cpX = (startPos.x + endPos.x) / 2;
    const midY = (startPos.y + endPos.y) / 2;
    const dist = Math.hypot(endPos.x - startPos.x, endPos.y - startPos.y);
    const archHeight = Math.min(40, Math.max(20, dist * 0.25));
    const cpY = midY - archHeight;

    // 現在指側（打鍵色）から次指側（薄い白）への線形グラデーション
    let startColor = 'rgba(0, 229, 255, 0.7)';
    if (this.consecutiveCount >= 3) {
      startColor = 'rgba(255, 214, 0, 0.7)';
    } else if (this.consecutiveCount === 2) {
      startColor = 'rgba(0, 230, 118, 0.7)';
    }

    const gradient = ctx.createLinearGradient(startPos.x, startPos.y, endPos.x, endPos.y);
    gradient.addColorStop(0, startColor);
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0.15)');

    ctx.strokeStyle = gradient;
    ctx.lineWidth = HOLOGRAM_STYLES.LINE_WIDTH_THIN;

    // 極細の破線 (4px 線 / 4px 空白)
    ctx.setLineDash([4, 4]);

    // データパルス流動: 時間経過に応じて lineDashOffset を減算し、始点から終点へ光が流れるように見せる
    ctx.lineDashOffset = -((this.lastTimestamp * 0.02) % 8);

    ctx.beginPath();
    ctx.moveTo(startPos.x, startPos.y);
    ctx.quadraticCurveTo(cpX, cpY, endPos.x, endPos.y);
    ctx.stroke();

    ctx.restore();
  }

  /**
   * 現在保持しているターゲット情報を取得（デバッグ・検証用）
   */
  public getCurrentTarget(): TargetFingerInfo | null {
    return this.currentTarget;
  }

  /**
   * 次のターゲット情報を取得（デバッグ・検証用）
   */
  public getNextTarget(): TargetFingerInfo | null {
    return this.nextTarget;
  }
}
