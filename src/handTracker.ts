import { FilesetResolver, HandLandmarker, HandLandmarkerResult } from '@mediapipe/tasks-vision';

export interface FingertipCoord {
  tipIndex: number;
  name: string;
  x: number;
  y: number;
  z: number;
}

export interface HandData {
  handedness: 'Left' | 'Right' | 'Unknown';
  score: number;
  fingertips: FingertipCoord[];
  allLandmarks: { x: number; y: number; z: number }[];
  centerX: number;
}

export const FINGERTIP_INDICES = [
  { index: 4, name: '親指' },
  { index: 8, name: '人差指' },
  { index: 12, name: '中指' },
  { index: 16, name: '薬指' },
  { index: 20, name: '小指' },
] as const;

export class HandTracker {
  private handLandmarker: HandLandmarker | null = null;
  private isInitialized = false;
  private lastTimestamp = -1;
  public activeDelegate: 'GPU' | 'CPU' = 'GPU';

  // 手首アンカーおよび追跡フェーズ管理
  private leftWristAnchor: { x: number; y: number } | null = null;
  private rightWristAnchor: { x: number; y: number } | null = null;
  private isCalibrated = false;
  private isPlaying = false;

  /**
   * 演奏中フェーズの切り替え
   */
  public setPlaying(playing: boolean): void {
    this.isPlaying = playing;
  }

  /**
   * キャリブレーションおよび手首アンカーのリセット
   */
  public resetCalibration(): void {
    this.leftWristAnchor = null;
    this.rightWristAnchor = null;
    this.isCalibrated = false;
    this.isPlaying = false;
  }

  /**
   * MediaPipe Tasks-Vision の FilesetResolver と HandLandmarker を初期化
   * iOS Safari 等で WebGL/OffscreenCanvas が制限される場合、CPU へ自動フォールバック
   */
  async init(): Promise<void> {
    if (this.isInitialized) return;

    // context7 で確認した最新推奨パス（Wasm Fileset 及び モデルアセット）を使用
    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
    );

    const modelAssetPath =
      'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

    try {
      this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.6,
        minTrackingConfidence: 0.6,
      });
      this.activeDelegate = 'GPU';
    } catch (gpuError) {
      console.warn('GPU初期化に失敗したためCPUフォールバックを実行します:', gpuError);
      this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath,
          delegate: 'CPU',
        },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.6,
        minTrackingConfidence: 0.6,
      });
      this.activeDelegate = 'CPU';
    }

    this.isInitialized = true;
  }

  /**
   * ビデオフレームから両手の指先座標を検出し、手首座標によるID固定スロット追跡を行う
   */
  detect(videoElement: HTMLVideoElement, timestamp: number): HandData[] {
    if (!this.handLandmarker || !this.isInitialized) {
      return [];
    }

    // iOS Safariでのタイマー精度やフレーム間引きによるタイムスタンプ逆転/重複防止
    if (timestamp <= this.lastTimestamp) {
      timestamp = this.lastTimestamp + 1;
    }
    this.lastTimestamp = timestamp;

    const results: HandLandmarkerResult = this.handLandmarker.detectForVideo(
      videoElement,
      timestamp
    );

    const hands: HandData[] = [];

    if (!results.landmarks || results.landmarks.length === 0) {
      return hands;
    }

    interface RawHandCandidate {
      landmarks: { x: number; y: number; z: number }[];
      confidenceScore: number;
      centerX: number;
      wrist: { x: number; y: number };
      screenX: number; // 画面表示基準のX座標 (CSS mirror反転 scaleX(-1) を考慮)
    }

    const candidates: RawHandCandidate[] = results.landmarks.map((landmarks, i) => {
      let confidenceScore = 0;
      if (results.handednesses && results.handednesses[i] && results.handednesses[i][0]) {
        confidenceScore = results.handednesses[i][0].score ?? 0;
      }
      const wristPoint = landmarks[0]; // 手首ランドマーク (landmark 0)
      const centerX = landmarks.reduce((acc, pt) => acc + pt.x, 0) / landmarks.length;
      return {
        landmarks,
        confidenceScore,
        centerX,
        wrist: { x: wristPoint.x, y: wristPoint.y },
        screenX: 1.0 - wristPoint.x, // 生座標反転 -> 画面左側が小、画面右側が大
      };
    });

    const createHandData = (cand: RawHandCandidate, handedness: 'Left' | 'Right'): HandData => {
      const fingertips: FingertipCoord[] = FINGERTIP_INDICES.map((tip) => {
        const point = cand.landmarks[tip.index];
        return {
          tipIndex: tip.index,
          name: tip.name,
          x: point.x,
          y: point.y,
          z: point.z,
        };
      });
      return {
        handedness,
        score: cand.confidenceScore,
        fingertips,
        allLandmarks: cand.landmarks,
        centerX: cand.centerX,
      };
    };

    const dist = (p1: { x: number; y: number }, p2: { x: number; y: number }) => {
      const dx = p1.x - p2.x;
      const dy = p1.y - p2.y;
      return Math.sqrt(dx * dx + dy * dy);
    };

    // =========================================================================
    // 1. 初期構え・キャリブレーションフェーズ（演奏開始前、または未キャリブレーション時）
    // =========================================================================
    if (!this.isPlaying || !this.isCalibrated || !this.leftWristAnchor || !this.rightWristAnchor) {
      if (candidates.length === 2) {
        // 2手検出時: 画面表示Xが小さい方を左手スロット、大きい方を右手スロットとして確定
        if (candidates[0].screenX <= candidates[1].screenX) {
          this.leftWristAnchor = { ...candidates[0].wrist };
          this.rightWristAnchor = { ...candidates[1].wrist };
          hands.push(createHandData(candidates[0], 'Left'));
          hands.push(createHandData(candidates[1], 'Right'));
        } else {
          this.leftWristAnchor = { ...candidates[1].wrist };
          this.rightWristAnchor = { ...candidates[0].wrist };
          hands.push(createHandData(candidates[1], 'Left'));
          hands.push(createHandData(candidates[0], 'Right'));
        }
        this.isCalibrated = true;
      } else {
        // 1手のみ検出時: 画面中央 (screenX = 0.5) を基準に暫定割り当て
        const cand = candidates[0];
        const handedness: 'Left' | 'Right' = cand.screenX < 0.5 ? 'Left' : 'Right';
        if (handedness === 'Left') {
          this.leftWristAnchor = { ...cand.wrist };
        } else {
          this.rightWristAnchor = { ...cand.wrist };
        }
        hands.push(createHandData(cand, handedness));
      }
      return hands;
    }

    // =========================================================================
    // 2. 演奏中フェーズ: 手首最近傍マッチング（MediaPipeの順序・ラベル無視のID固定）
    // =========================================================================
    if (candidates.length === 2) {
      // 候補0, 候補1 を leftWristAnchor, rightWristAnchor と総当たり比較
      const costA = dist(candidates[0].wrist, this.leftWristAnchor) + dist(candidates[1].wrist, this.rightWristAnchor);
      const costB = dist(candidates[0].wrist, this.rightWristAnchor) + dist(candidates[1].wrist, this.leftWristAnchor);

      if (costA <= costB) {
        // 候補0 -> Left, 候補1 -> Right
        this.leftWristAnchor = { ...candidates[0].wrist };
        this.rightWristAnchor = { ...candidates[1].wrist };
        hands.push(createHandData(candidates[0], 'Left'));
        hands.push(createHandData(candidates[1], 'Right'));
      } else {
        // 候補0 -> Right, 候補1 -> Left
        this.leftWristAnchor = { ...candidates[1].wrist };
        this.rightWristAnchor = { ...candidates[0].wrist };
        hands.push(createHandData(candidates[1], 'Left'));
        hands.push(createHandData(candidates[0], 'Right'));
      }
    } else {
      // 1手のみ検出時: 前フレームで保持している手首位置に近い方のスロットへ割り当て
      const cand = candidates[0];
      const distToLeft = dist(cand.wrist, this.leftWristAnchor);
      const distToRight = dist(cand.wrist, this.rightWristAnchor);

      if (distToLeft <= distToRight) {
        this.leftWristAnchor = { ...cand.wrist };
        hands.push(createHandData(cand, 'Left'));
      } else {
        this.rightWristAnchor = { ...cand.wrist };
        hands.push(createHandData(cand, 'Right'));
      }
    }

    return hands;
  }

  close(): void {
    if (this.handLandmarker) {
      this.handLandmarker.close();
      this.handLandmarker = null;
      this.isInitialized = false;
    }
  }
}
