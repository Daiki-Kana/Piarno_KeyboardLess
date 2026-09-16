import { HandData } from './handTracker';

export interface LoggedFrame {
  timestamp: number;
  features: [number, number, number, number, number, number]; // [rx, ry, rz, vx, vy, vz]
  label: number; // 1: HIT, 0: 通常
}

export class FeatureLogger {
  private isRecording = false;
  private isHitActive = false;
  private recordedFrames: LoggedFrame[] = [];
  private hitCount = 0;

  private lastR: { x: number; y: number; z: number } | null = null;
  private lastTimestamp: number | null = null;

  // UI コールバック
  private onStatusUpdate?: (status: { frameCount: number; hitCount: number; isRecording: boolean; isTracked: boolean; targetHand: string }) => void;

  constructor(onStatusUpdate?: (status: { frameCount: number; hitCount: number; isRecording: boolean; isTracked: boolean; targetHand: string }) => void) {
    this.onStatusUpdate = onStatusUpdate;
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
    this.isRecording = true;
    this.recordedFrames = [];
    this.hitCount = 0;
    this.lastR = null;
    this.lastTimestamp = null;
    this.notifyStatus(false, 'None');
  }

  public stopRecording(): void {
    this.isRecording = false;
    this.lastR = null;
    this.lastTimestamp = null;
    this.notifyStatus(false, 'None');
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
   * フレーム毎の特徴量算出および記録処理
   * RECがオフの場合はメモリアロケーションを一切行わず即座に復帰
   */
  public processFrame(hands: HandData[], timestamp: number): void {
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

    this.recordedFrames.push({
      timestamp,
      features: [rx, ry, rz, vx, vy, vz],
      label,
    });

    this.notifyStatus(true, targetHand.handedness);
  }

  /**
   * 記録したフレームデータをJSONファイルとしてダウンロード
   */
  public exportJSON(): void {
    if (this.recordedFrames.length === 0) {
      return;
    }

    const jsonStr = JSON.stringify(this.recordedFrames, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const yyyy = now.getFullYear();
    const mm = pad(now.getMonth() + 1);
    const dd = pad(now.getDate());
    const hh = pad(now.getHours());
    const min = pad(now.getMinutes());
    const ss = pad(now.getSeconds());
    const fileName = `dataset_index_${yyyy}${mm}${dd}_${hh}${min}${ss}.json`;

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
