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
 * 接地感演出（影風コンタクトドット）のスタイル定義
 */
export const CONTACT_DOT_STYLE = {
  // 描画モード: 'neon' (視認性重視のネオン発光) または 'shadow' (濃いグレー〜黒の接地影風)
  MODE: 'neon' as 'neon' | 'shadow',

  // 寿命（打鍵リズムを邪魔しない短尺: 100〜140ms）
  DURATION_MS: 120,

  // ポップアニメーション時間（0〜30ms）
  POP_TIME_MS: 30,

  // 初期スケール（出現直後）
  INITIAL_SCALE: 0.3,

  // ポップピークスケール（わずかなオーバーシュート）
  PEAK_SCALE: 1.08,

  // 安定時スケール（30ms以降）
  STEADY_SCALE: 1.0,

  // 接地点最大半径 (px: 7〜10pxの極小サイズ)
  MAX_RADIUS_PX: 8.5,

  // 内側コア円半径 (px)
  INNER_RADIUS_PX: 3.5,

  // 接地影風モード時の色彩定義
  SHADOW_OUTER_COLOR: 'rgba(0, 0, 0, 0.6)',
  SHADOW_INNER_COLOR: 'rgba(0, 0, 0, 0.85)',
  SHADOW_STROKE_COLOR: 'rgba(20, 20, 20, 0.9)',

  // ネオンモード時の微小シャドウブラー (px)
  NEON_SHADOW_BLUR: 4,
} as const;

/**
 * 接地ドット（ContactDot）情報
 */
export interface ContactDot {
  fingerId: number;
  position: Point2D;
  startTime: number;
  duration: number;
  consecutiveCount: number;
}

/**
 * ARホログラムエフェクトマネージャー
 */
export class HologramEffectManager {
  private currentTarget: TargetFingerInfo | null = null;
  private nextTarget: TargetFingerInfo | null = null;
  private consecutiveCount: number = 1;
  private lastTimestamp: number = 0;
  private contactDots: ContactDot[] = [];

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
   * 打鍵イベントを受信し、指先直下に小さな接地ドット（ContactDot）を生成
   * @param fingerId 打鍵された指番号
   * @param position 指先の正規化座標 (x: 0~1, y: 0~1)
   */
  public triggerTap(fingerId: number, position: Point2D): void {
    this.contactDots.push({
      fingerId,
      position,
      startTime: this.lastTimestamp,
      duration: CONTACT_DOT_STYLE.DURATION_MS,
      consecutiveCount: this.consecutiveCount,
    });
  }

  /**
   * 時間経過によるアニメーション状態の更新
   * @param timestamp 現在のタイムスタンプ (ms)
   */
  public update(timestamp: number): void {
    this.lastTimestamp = timestamp;

    // 寿命を迎えたコンタクトドットを安全に除外
    if (this.contactDots.length > 0) {
      this.contactDots = this.contactDots.filter(
        (dot) => timestamp - dot.startTime < dot.duration
      );
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

    // 0. 机タップ時の接地感演出（影風コンタクトドット）描画
    this.renderContactDots(ctx, width, height);

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
   * 机タップ時の接地感演出（影風コンタクトドット）の描画
   * 外側へ広がる光を排除し、タップした接地点に指の影のような小さな二重丸がポンと現れて素早く消える
   */
  private renderContactDots(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number
  ): void {
    if (this.contactDots.length === 0) return;

    for (const dot of this.contactDots) {
      const elapsed = this.lastTimestamp - dot.startTime;
      if (elapsed < 0 || elapsed >= dot.duration) continue;

      // 1. ポップ & フェードアウト アニメーション計算
      let scale: number;
      let alpha: number;

      if (elapsed <= CONTACT_DOT_STYLE.POP_TIME_MS) {
        // 出現直後（0〜30ms）: スケールが 0.3 からピーク（1.08）まで素早くポップ
        const t = elapsed / CONTACT_DOT_STYLE.POP_TIME_MS;
        const popEase = Math.sin(t * (Math.PI / 2));
        scale = CONTACT_DOT_STYLE.INITIAL_SCALE +
          (CONTACT_DOT_STYLE.PEAK_SCALE - CONTACT_DOT_STYLE.INITIAL_SCALE) * popEase;
        alpha = 1.0;
      } else {
        // 残り時間（30〜120ms）: スケールは固定（1.0）のまま不透明度が直線的にフェードアウト
        const fadeT = (elapsed - CONTACT_DOT_STYLE.POP_TIME_MS) /
          (dot.duration - CONTACT_DOT_STYLE.POP_TIME_MS);
        scale = CONTACT_DOT_STYLE.STEADY_SCALE;
        alpha = Math.max(0, 1.0 - Math.min(1.0, fadeT));
      }

      const px = dot.position.x * width;
      const py = dot.position.y * height;
      const outerRadius = CONTACT_DOT_STYLE.MAX_RADIUS_PX * scale;
      const innerRadius = CONTACT_DOT_STYLE.INNER_RADIUS_PX * scale;

      ctx.save();

      if (CONTACT_DOT_STYLE.MODE === 'shadow') {
        // パターン1: 接地影風（濃いグレー〜黒の半透明影）
        const cFillOuter = `rgba(0, 0, 0, ${(0.55 * alpha).toFixed(3)})`;
        const cStrokeOuter = `rgba(20, 20, 20, ${(0.8 * alpha).toFixed(3)})`;
        const cFillInner = `rgba(0, 0, 0, ${(0.85 * alpha).toFixed(3)})`;

        // 外側影円
        ctx.beginPath();
        ctx.arc(px, py, outerRadius, 0, 2 * Math.PI);
        ctx.fillStyle = cFillOuter;
        ctx.fill();
        ctx.lineWidth = 1.0;
        ctx.strokeStyle = cStrokeOuter;
        ctx.stroke();

        // 内側コア影
        ctx.beginPath();
        ctx.arc(px, py, innerRadius, 0, 2 * Math.PI);
        ctx.fillStyle = cFillInner;
        ctx.fill();
      } else {
        // パターン2: ネオンモード（高輝度ネオン ＋ 微小グロー、連続打鍵数カラー連動）
        let glowColor: string;
        let cFillOuter: string;
        let cStrokeOuter: string;
        let cFillInner: string;

        if (dot.consecutiveCount >= 3) {
          // 3回以上: 黄色
          glowColor = '#ffd600';
          cFillOuter = `rgba(255, 214, 0, ${(0.35 * alpha).toFixed(3)})`;
          cStrokeOuter = `rgba(255, 230, 0, ${(0.95 * alpha).toFixed(3)})`;
          cFillInner = `rgba(255, 245, 120, ${(0.9 * alpha).toFixed(3)})`;
        } else if (dot.consecutiveCount === 2) {
          // 2回: 緑
          glowColor = '#00e676';
          cFillOuter = `rgba(0, 230, 118, ${(0.35 * alpha).toFixed(3)})`;
          cStrokeOuter = `rgba(0, 255, 136, ${(0.95 * alpha).toFixed(3)})`;
          cFillInner = `rgba(130, 255, 190, ${(0.9 * alpha).toFixed(3)})`;
        } else {
          // 1回: 水色
          glowColor = '#00f0ff';
          cFillOuter = `rgba(0, 229, 255, ${(0.35 * alpha).toFixed(3)})`;
          cStrokeOuter = `rgba(0, 240, 255, ${(0.95 * alpha).toFixed(3)})`;
          cFillInner = `rgba(160, 250, 255, ${(0.9 * alpha).toFixed(3)})`;
        }

        // 微小な接地エッジ発光
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = CONTACT_DOT_STYLE.NEON_SHADOW_BLUR;

        // 1. 接地ドット外側円（内側塗り＋極細輪郭線）
        ctx.beginPath();
        ctx.arc(px, py, outerRadius, 0, 2 * Math.PI);
        ctx.fillStyle = cFillOuter;
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = cStrokeOuter;
        ctx.stroke();

        // 2. 接地点コア円
        ctx.beginPath();
        ctx.arc(px, py, innerRadius, 0, 2 * Math.PI);
        ctx.fillStyle = cFillInner;
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
