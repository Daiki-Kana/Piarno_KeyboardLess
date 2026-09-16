import { FeatureLogger, RecordedFrame } from './featureLogger';

/**
 * コマ送り手動ラベリングUI（Frame-Step Labeler）コントローラー
 * 録画された短時間の打鍵動作を1フレーム単位で確認し、打鍵瞬間を目視指定してラベル付けするUI
 */
export class FrameStepLabeler {
  private featureLogger: FeatureLogger;
  private frames: RecordedFrame[] = [];
  private currentIndex = 0;
  private isOpen = false;

  // DOM 要素
  private modal: HTMLElement;
  private viewport: HTMLElement;
  private canvas: HTMLCanvasElement;
  private canvasCtx: CanvasRenderingContext2D;
  private timelineCanvas: HTMLCanvasElement;
  private timelineCtx: CanvasRenderingContext2D;
  private seekbar: HTMLInputElement;
  private frameCounter: HTMLElement;
  private hitBadge: HTMLElement;
  private overlayBadge: HTMLElement;
  private metricsPos: HTMLElement;
  private metricsVel: HTMLElement;
  private markBtn: HTMLButtonElement;
  private markText: HTMLElement;

  private prev5Btn: HTMLButtonElement;
  private prevBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;
  private next5Btn: HTMLButtonElement;
  private exportJsonBtn: HTMLButtonElement;
  private exportCsvBtn: HTMLButtonElement;
  private closeBtn: HTMLButtonElement;

  private keydownHandler = (e: KeyboardEvent) => this.handleKeyDown(e);

  constructor(featureLogger: FeatureLogger) {
    this.featureLogger = featureLogger;

    // DOM要素のバインド
    this.modal = document.getElementById('review-modal') as HTMLElement;
    this.viewport = this.modal.querySelector('.review-viewport') as HTMLElement;
    this.canvas = document.getElementById('review-canvas') as HTMLCanvasElement;
    this.canvasCtx = this.canvas.getContext('2d')!;
    this.timelineCanvas = document.getElementById('review-timeline-canvas') as HTMLCanvasElement;
    this.timelineCtx = this.timelineCanvas.getContext('2d')!;
    this.seekbar = document.getElementById('review-seekbar') as HTMLInputElement;
    this.frameCounter = document.getElementById('review-frame-counter') as HTMLElement;
    this.hitBadge = document.getElementById('review-hit-badge') as HTMLElement;
    this.overlayBadge = document.getElementById('review-overlay-badge') as HTMLElement;
    this.metricsPos = document.getElementById('review-feat-pos') as HTMLElement;
    this.metricsVel = document.getElementById('review-feat-vel') as HTMLElement;
    this.markBtn = document.getElementById('review-mark-btn') as HTMLButtonElement;
    this.markText = document.getElementById('review-mark-text') as HTMLElement;

    this.prev5Btn = document.getElementById('review-prev5-btn') as HTMLButtonElement;
    this.prevBtn = document.getElementById('review-prev-btn') as HTMLButtonElement;
    this.nextBtn = document.getElementById('review-next-btn') as HTMLButtonElement;
    this.next5Btn = document.getElementById('review-next5-btn') as HTMLButtonElement;
    this.exportJsonBtn = document.getElementById('review-export-json-btn') as HTMLButtonElement;
    this.exportCsvBtn = document.getElementById('review-export-csv-btn') as HTMLButtonElement;
    this.closeBtn = document.getElementById('review-close-btn') as HTMLButtonElement;

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    // シークバー操作
    this.seekbar.addEventListener('input', () => {
      this.goToFrame(parseInt(this.seekbar.value, 10));
    });

    // コマ送りボタン
    this.prevBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.stepFrame(-1);
    });
    this.nextBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.stepFrame(1);
    });
    this.prev5Btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.stepFrame(-5);
    });
    this.next5Btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.stepFrame(5);
    });

    // 打鍵マークトグルボタン
    this.markBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleCurrentMark();
    });

    // エクスポートボタン
    this.exportJsonBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.featureLogger.exportJSON();
    });
    this.exportCsvBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.featureLogger.exportCSV();
    });

    // 閉じるボタン
    this.closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.close();
    });
  }

  /**
   * コマ送りレビューモーダルを開く
   */
  public open(frames: RecordedFrame[]): void {
    if (!frames || frames.length === 0) {
      console.warn('[FrameStepLabeler] 記録されたフレームが存在しません');
      return;
    }

    this.frames = frames;
    this.currentIndex = 0;
    this.isOpen = true;

    // シークバーの範囲を設定
    this.seekbar.min = '0';
    this.seekbar.max = (frames.length - 1).toString();
    this.seekbar.value = '0';

    // タイムラインCanvasの内部解像度を設定
    this.updateTimelineResolution();

    // モーダルを表示
    this.modal.classList.remove('hidden');

    // キーボードショートカットのリスナーを登録
    window.addEventListener('keydown', this.keydownHandler);

    // 初期フレームとタイムラインの描画
    this.updateUI();
  }

  /**
   * モーダルを閉じる
   */
  public close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.modal.classList.add('hidden');
    window.removeEventListener('keydown', this.keydownHandler);
  }

  /**
   * 指定したインデックスのフレームへ移動
   */
  public goToFrame(index: number): void {
    if (this.frames.length === 0) return;
    const clamped = Math.max(0, Math.min(this.frames.length - 1, index));
    if (clamped !== this.currentIndex || this.seekbar.value !== clamped.toString()) {
      this.currentIndex = clamped;
      this.seekbar.value = clamped.toString();
      this.updateUI();
    }
  }

  /**
   * 指定フレーム数分移動
   */
  public stepFrame(delta: number): void {
    this.goToFrame(this.currentIndex + delta);
  }

  /**
   * 現在表示中フレームの打鍵マーク状態をトグル
   */
  public toggleCurrentMark(): void {
    if (this.frames.length === 0) return;
    const newLabel = this.featureLogger.toggleFrameLabel(this.currentIndex);
    this.frames[this.currentIndex].label = newLabel;
    this.updateUI();
  }

  /**
   * キーボードショートカット処理
   */
  private handleKeyDown(e: KeyboardEvent): void {
    if (!this.isOpen) return;

    if (e.code === 'ArrowLeft') {
      e.preventDefault();
      this.stepFrame(e.shiftKey ? -5 : -1);
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      this.stepFrame(e.shiftKey ? 5 : 1);
    } else if (e.code === 'Space' || e.code === 'KeyM' || e.code === 'Enter') {
      e.preventDefault();
      this.toggleCurrentMark();
    } else if (e.code === 'Escape') {
      e.preventDefault();
      this.close();
    }
  }

  /**
   * UIおよびCanvas全体の更新
   */
  private updateUI(): void {
    if (this.frames.length === 0) return;

    const frame = this.frames[this.currentIndex];
    const totalFrames = this.frames.length;
    const isMarked = frame.label === 1;

    // 1. フレームカウンタ表示の更新
    this.frameCounter.textContent = `Frame: ${this.currentIndex + 1} / ${totalFrames}`;

    // 2. 打鍵マーク数バッジの更新
    const totalHits = this.frames.filter((f) => f.label === 1).length;
    this.hitBadge.textContent = `${totalHits} HIT${totalHits !== 1 ? 'S' : ''} MARKED`;
    if (totalHits > 0) {
      this.hitBadge.classList.add('has-hits');
    } else {
      this.hitBadge.classList.remove('has-hits');
    }

    // 3. 現在フレームのマーク状態表示と打鍵指定ボタン
    if (isMarked) {
      this.viewport.classList.add('marked-hit');
      this.overlayBadge.textContent = '● HIT (打鍵)';
      this.overlayBadge.classList.add('marked');
      this.markBtn.classList.add('is-marked');
      this.markText.textContent = '打鍵指定中 (解除: Mark Hit)';
    } else {
      this.viewport.classList.remove('marked-hit');
      this.overlayBadge.textContent = 'NORMAL';
      this.overlayBadge.classList.remove('marked');
      this.markBtn.classList.remove('is-marked');
      this.markText.textContent = '打鍵指定 (Mark Hit)';
    }

    // 4. 特徴量（Pos / Vel）HUDの更新
    const [rx, ry, rz, vx, vy, vz] = frame.features;
    this.metricsPos.textContent = `Pos: [${rx.toFixed(2)}, ${ry.toFixed(2)}, ${rz.toFixed(2)}]`;
    this.metricsVel.textContent = `Vel: [${vx.toFixed(2)}, ${vy.toFixed(2)}, ${vz.toFixed(2)}]`;

    // 5. メインプレビューCanvasの描画（映像＋骨格オーバーレイ）
    this.renderFrameCanvas(frame);

    // 6. タイムラインCanvasの描画
    this.renderTimeline();
  }

  /**
   * 現在フレームのプレビュー描画（映像 + 骨格オーバーレイ）
   */
  private renderFrameCanvas(frame: RecordedFrame): void {
    const ctx = this.canvasCtx;

    // 画像サイズに応じてCanvas内部解像度を調整
    if (frame.imageBitmap) {
      if (this.canvas.width !== frame.imageBitmap.width || this.canvas.height !== frame.imageBitmap.height) {
        this.canvas.width = frame.imageBitmap.width;
        this.canvas.height = frame.imageBitmap.height;
      }
      ctx.drawImage(frame.imageBitmap, 0, 0);
    } else {
      ctx.fillStyle = '#111111';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.fillStyle = '#666666';
      ctx.font = '14px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('NO VIDEO FRAME', this.canvas.width / 2, this.canvas.height / 2);
    }

    const width = this.canvas.width;
    const height = this.canvas.height;

    // 骨格オーバーレイの描画（右手優先の対象手1本のみ描画し、ゴースト重なりを防止）
    if (frame.hands && frame.hands.length > 0) {
      const hand = frame.hands.find((h) => h.handedness === 'Right') ?? frame.hands[0];
      if (hand && hand.allLandmarks && hand.allLandmarks.length > 0) {

        // 手の主要ボーンライン（白黒コントラスト）
        this.drawHandSkeleton(ctx, hand.allLandmarks, width, height);

        // 人差し指（Wrist: 0, MCP: 5, Tip: 8）のベクトルと打鍵ターゲット強調
        const wrist = hand.allLandmarks[0];
        const mcp = hand.allLandmarks[5];
        const tip = hand.allLandmarks[8];

        if (wrist && mcp && tip) {
          const wx = wrist.x * width;
          const wy = wrist.y * height;
          const mx = mcp.x * width;
          const my = mcp.y * height;
          const tx = tip.x * width;
          const ty = tip.y * height;

          // Wrist -> MCP 基準線 (破線)
          ctx.beginPath();
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
          ctx.lineWidth = 1.5;
          ctx.moveTo(wx, wy);
          ctx.lineTo(mx, my);
          ctx.stroke();
          ctx.setLineDash([]);

          // MCP -> Tip 局所相対ベクトル線 (実線)
          ctx.beginPath();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2.5;
          ctx.moveTo(mx, my);
          ctx.lineTo(tx, ty);
          ctx.stroke();

          // 指先ターゲットマーク
          ctx.beginPath();
          ctx.arc(tx, ty, frame.label === 1 ? 16 : 10, 0, 2 * Math.PI);
          ctx.fillStyle = frame.label === 1 ? '#ffffff' : 'rgba(255, 255, 255, 0.3)';
          ctx.fill();
          ctx.strokeStyle = '#000000';
          ctx.lineWidth = 2;
          ctx.stroke();

          if (frame.label === 1) {
            // 打鍵フレームでは中心に黒点
            ctx.beginPath();
            ctx.arc(tx, ty, 4, 0, 2 * Math.PI);
            ctx.fillStyle = '#000000';
            ctx.fill();
          }
        }
      }
    }

    // 打鍵指定フレームの場合、プレビュー外枠を強調
    if (frame.label === 1) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 6;
      ctx.strokeRect(3, 3, width - 6, height - 6);
    }
  }

  /**
   * 手の骨格ラインの描画
   */
  private drawHandSkeleton(
    ctx: CanvasRenderingContext2D,
    landmarks: { x: number; y: number; z: number }[],
    width: number,
    height: number
  ): void {
    // 指の関節接続インデックス定義
    const fingerJoints = [
      [0, 1, 2, 3, 4],    // 親指
      [0, 5, 6, 7, 8],    // 人差し指
      [0, 9, 10, 11, 12], // 中指
      [0, 13, 14, 15, 16],// 薬指
      [0, 17, 18, 19, 20],// 小指
      [5, 9, 13, 17],     // 掌横ライン
    ];

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 1.2;

    for (const jointPath of fingerJoints) {
      ctx.beginPath();
      for (let i = 0; i < jointPath.length; i++) {
        const pt = landmarks[jointPath[i]];
        if (!pt) continue;
        const x = pt.x * width;
        const y = pt.y * height;
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }

    // 各ランドマークポイント
    for (let i = 0; i < landmarks.length; i++) {
      const pt = landmarks[i];
      if (!pt) continue;
      const x = pt.x * width;
      const y = pt.y * height;
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, 2 * Math.PI);
      ctx.fillStyle = i === 8 ? '#ffffff' : 'rgba(255, 255, 255, 0.7)';
      ctx.fill();
    }
  }

  /**
   * タイムラインCanvasの内部解像度調整
   */
  private updateTimelineResolution(): void {
    const rect = this.timelineCanvas.getBoundingClientRect();
    const w = rect.width > 0 ? rect.width : 600;
    this.timelineCanvas.width = Math.round(w * window.devicePixelRatio);
    this.timelineCanvas.height = Math.round(14 * window.devicePixelRatio);
  }

  /**
   * タイムラインCanvasの描画（マーク済み打鍵フレームの可視化と現在位置）
   */
  private renderTimeline(): void {
    const ctx = this.timelineCtx;
    const w = this.timelineCanvas.width;
    const h = this.timelineCanvas.height;
    const totalFrames = this.frames.length;

    if (totalFrames === 0) return;

    // 背景クリア
    ctx.fillStyle = '#111111';
    ctx.fillRect(0, 0, w, h);

    // マークされたフレームの位置に白い縦線を描画
    for (let i = 0; i < totalFrames; i++) {
      if (this.frames[i].label === 1) {
        const x = Math.round((i / (totalFrames - 1 || 1)) * (w - 2)) + 1;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x - 1, 0, 3, h);
      }
    }

    // 現在フレームのインジケーター（コントラストのある反転バー）
    const currX = Math.round((this.currentIndex / (totalFrames - 1 || 1)) * (w - 2)) + 1;
    ctx.fillStyle = 'rgba(180, 180, 180, 0.9)';
    ctx.fillRect(currX - 2, 0, 4, h);
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1;
    ctx.strokeRect(currX - 2, 0, 4, h);
  }
}
