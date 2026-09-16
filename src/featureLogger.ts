import { HandData } from './handTracker';

export interface RecordedFrame {
  timestamp: number;
  features: [number, number, number, number, number, number]; // [rx, ry, rz, vx, vy, vz]
  label: number; // 1: HIT, 0: 通常
  imageBitmap?: ImageBitmap;
  hands?: HandData[]; // レビュー描画用の骨格ランドマーク
}

export interface FeatureLoggerStatus {
  frameCount: number;
  hitCount: number;
  isRecording: boolean;
  isTracked: boolean;
  targetHand: string;
}

export class FeatureLogger {
  private isRecording = false;
  private isHitActive = false;
  private recordedFrames: RecordedFrame[] = [];
  private hitCount = 0;

  private lastR: { x: number; y: number; z: number } | null = null;
  private lastTimestamp: number | null = null;

  // キャプチャ用オフスクリーンCanvas（メモリ効率と高速描画のため640px幅に最適化）
  private captureCanvas: HTMLCanvasElement | null = null;
  private captureCtx: CanvasRenderingContext2D | null = null;
  private readonly CAPTURE_WIDTH = 640;

  // UI コールバック
  private onStatusUpdate?: (status: FeatureLoggerStatus) => void;
  private onRecordingStopped?: (frames: RecordedFrame[]) => void;

  constructor(
    onStatusUpdate?: (status: FeatureLoggerStatus) => void,
    onRecordingStopped?: (frames: RecordedFrame[]) => void
  ) {
    this.onStatusUpdate = onStatusUpdate;
    this.onRecordingStopped = onRecordingStopped;
  }

  public get recording(): boolean {
    return this.isRecording;
  }

  public get count(): number {
    return this.recordedFrames.length;
  }

  public get hits(): number {
    return this.hitCount;
  }

  public get frames(): RecordedFrame[] {
    return this.recordedFrames;
  }

  /**
   * 録画の開始 / 停止トグル
   */
  public toggleRecording(): boolean {
    if (this.isRecording) {
      this.stopRecording();
    } else {
      this.startRecording();
    }
    return this.isRecording;
  }

  public startRecording(): void {
    // 既存のImageBitmapがあればメモリ解放
    this.clearRecordedBitmaps();

    this.isRecording = true;
    this.recordedFrames = [];
    this.hitCount = 0;
    this.lastR = null;
    this.lastTimestamp = null;
    this.notifyStatus(false, 'None');
  }

  public stopRecording(): void {
    if (!this.isRecording) return;
    this.isRecording = false;
    this.lastR = null;
    this.lastTimestamp = null;
    this.notifyStatus(false, 'None');

    if (this.onRecordingStopped) {
      this.onRecordingStopped(this.recordedFrames);
    }
  }

  /**
   * HIT状態の設定（Spaceキー押下中またはHITボタンプッシュ中）
   */
  public setHit(active: boolean): void {
    if (active && !this.isHitActive) {
      if (this.isRecording) {
        this.hitCount++;
      }
    }
    this.isHitActive = active;
  }

  /**
   * 指定インデックスのフレームの打鍵ラベルをトグル
   */
  public toggleFrameLabel(index: number): number {
    if (index < 0 || index >= this.recordedFrames.length) return 0;
    const current = this.recordedFrames[index].label;
    const next = current === 1 ? 0 : 1;
    this.recordedFrames[index].label = next;

    // マークされた総数を再計算
    this.hitCount = this.recordedFrames.filter((f) => f.label === 1).length;
    return next;
  }

  /**
   * 指定インデックスのフレームの打鍵ラベルを直接設定
   */
  public setFrameLabel(index: number, label: number): void {
    if (index < 0 || index >= this.recordedFrames.length) return;
    this.recordedFrames[index].label = label;
    this.hitCount = this.recordedFrames.filter((f) => f.label === 1).length;
  }

  /**
   * フレーム毎の特徴量算出および映像・骨格の記録処理
   * RECがオフの場合はメモリアロケーションを一切行わず即座に復帰
   * @param hands smoothHandFingertips で平滑化された HandData 配列
   * @param timestamp performance.now() タイムスタンプ
   * @param videoElement カメラ映像キャプチャ元の HTMLVideoElement
   */
  public processFrame(
    hands: HandData[],
    timestamp: number,
    videoElement?: HTMLVideoElement
  ): void {
    if (!this.isRecording) {
      return;
    }

    // 右手優先、なければ検出された最初の対象手を取得
    const targetHand = hands.find((h) => h.handedness === 'Right') ?? hands[0];

    if (!targetHand || !targetHand.allLandmarks || targetHand.allLandmarks.length < 9) {
      // 手が画面外に出た際は不連続な速度計算を避けるため履歴を初期化
      this.lastR = null;
      this.lastTimestamp = null;
      this.notifyStatus(false, 'None');
      return;
    }

    const wrist = targetHand.allLandmarks[0];   // Wrist (landmark 0)
    const mcp = targetHand.allLandmarks[5];     // Index MCP (landmark 5)
    const tip = targetHand.allLandmarks[8];     // Index Tip (landmark 8)

    // スケール正規化基準長 L = ||Index MCP - Wrist||
    const dx = mcp.x - wrist.x;
    const dy = mcp.y - wrist.y;
    const dz = mcp.z - wrist.z;
    const L = Math.hypot(dx, dy, dz) || 1e-6;

    // 局所相対位置 r(t) = (Index Tip - Index MCP) / L
    const rx = (tip.x - mcp.x) / L;
    const ry = (tip.y - mcp.y) / L;
    const rz = (tip.z - mcp.z) / L;

    // 局所相対速度 v(t) = (r(t) - r(t - Δt)) / Δt
    let vx = 0;
    let vy = 0;
    let vz = 0;

    if (this.lastR !== null && this.lastTimestamp !== null && timestamp > this.lastTimestamp) {
      const dt = (timestamp - this.lastTimestamp) / 1000; // 秒換算
      if (dt > 0) {
        vx = (rx - this.lastR.x) / dt;
        vy = (ry - this.lastR.y) / dt;
        vz = (rz - this.lastR.z) / dt;
      }
    }

    this.lastR = { x: rx, y: ry, z: rz };
    this.lastTimestamp = timestamp;

    const label = this.isHitActive ? 1 : 0;

    // フレームオブジェクトを作成
    const frameData: RecordedFrame = {
      timestamp,
      features: [rx, ry, rz, vx, vy, vz],
      label,
      hands: this.cloneHands(hands),
    };

    // 映像フレームを軽量Bitmapとしてキャプチャ
    if (videoElement && videoElement.videoWidth > 0) {
      this.captureVideoFrame(videoElement).then((bmp) => {
        frameData.imageBitmap = bmp;
      }).catch((err) => {
        console.warn('[FeatureLogger] フレーム画像キャプチャ失敗:', err);
      });
    }

    this.recordedFrames.push(frameData);
    this.notifyStatus(true, targetHand.handedness);
  }

  /**
   * メモリ効率化のため映像を縮小Canvasに描画してImageBitmap化
   */
  private async captureVideoFrame(video: HTMLVideoElement): Promise<ImageBitmap> {
    const aspect = video.videoHeight / (video.videoWidth || 1);
    const targetW = this.CAPTURE_WIDTH;
    const targetH = Math.round(targetW * aspect);

    if (!this.captureCanvas) {
      this.captureCanvas = document.createElement('canvas');
    }
    if (this.captureCanvas.width !== targetW || this.captureCanvas.height !== targetH) {
      this.captureCanvas.width = targetW;
      this.captureCanvas.height = targetH;
      this.captureCtx = this.captureCanvas.getContext('2d');
    }

    if (this.captureCtx) {
      this.captureCtx.drawImage(video, 0, 0, targetW, targetH);
      return createImageBitmap(this.captureCanvas);
    } else {
      return createImageBitmap(video);
    }
  }

  /**
   * 骨格データのディープコピー（参照共有による後続フレームでの値書き換わりを防止）
   */
  private cloneHands(hands: HandData[]): HandData[] {
    return hands.map((h) => ({
      handedness: h.handedness,
      score: h.score,
      centerX: h.centerX,
      fingertips: h.fingertips.map((f) => ({ ...f })),
      allLandmarks: h.allLandmarks.map((l) => ({ ...l })),
    }));
  }

  /**
   * 保持しているすべてのImageBitmapを閉じてメモリを解放
   */
  public clearRecordedBitmaps(): void {
    for (const fr of this.recordedFrames) {
      if (fr.imageBitmap) {
        fr.imageBitmap.close();
      }
    }
    this.recordedFrames = [];
  }

  /**
   * 記録したフレームデータを既存の1D-TCN学習スクリプト互換のJSONファイルとしてダウンロード
   */
  public exportJSON(): void {
    if (this.recordedFrames.length === 0) {
      return;
    }

    // 学習パイプライン（train_1d_tcn.py）が期待するデータ構造のみ抽出
    const exportData = this.recordedFrames.map((f) => ({
      timestamp: f.timestamp,
      features: f.features,
      label: f.label,
    }));

    const jsonStr = JSON.stringify(exportData, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    this.downloadBlob(blob, 'json');
  }

  /**
   * 記録したフレームデータをCSVファイルとしてダウンロード
   */
  public exportCSV(): void {
    if (this.recordedFrames.length === 0) {
      return;
    }

    const header = 'timestamp,rx,ry,rz,vx,vy,vz,label\n';
    const rows = this.recordedFrames
      .map((f) => `${f.timestamp},${f.features.join(',')},${f.label}`)
      .join('\n');

    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' });
    this.downloadBlob(blob, 'csv');
  }

  private downloadBlob(blob: Blob, extension: string): void {
    const url = URL.createObjectURL(blob);
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const yyyy = now.getFullYear();
    const mm = pad(now.getMonth() + 1);
    const dd = pad(now.getDate());
    const hh = pad(now.getHours());
    const min = pad(now.getMinutes());
    const ss = pad(now.getSeconds());
    const fileName = `dataset_index_${yyyy}${mm}${dd}_${hh}${min}${ss}.${extension}`;

    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  private notifyStatus(isTracked: boolean, targetHand: string): void {
    if (this.onStatusUpdate) {
      this.onStatusUpdate({
        frameCount: this.recordedFrames.length,
        hitCount: this.hitCount,
        isRecording: this.isRecording,
        isTracked,
        targetHand,
      });
    }
  }
}

