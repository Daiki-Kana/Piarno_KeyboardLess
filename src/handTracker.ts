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
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.4,
        minTrackingConfidence: 0.4,
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
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.4,
        minTrackingConfidence: 0.4,
      });
      this.activeDelegate = 'CPU';
    }

    this.isInitialized = true;
  }

  // 片手検出時の左右反転チラつき防止用ヒステリシス状態
  private lastSingleHandedness: 'Left' | 'Right' | null = null;

  /**
   * ビデオフレームから両手の指先座標を検出
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

    // 各手の中心X座標を算出し、左右空間位置を判定
    // (前面カメラの生映像では、ユーザーの左手は x > 0.5、右手は x < 0.5 に映る)
    interface RawHandCandidate {
      landmarks: { x: number; y: number; z: number }[];
      confidenceScore: number;
      centerX: number;
    }

    const candidates: RawHandCandidate[] = results.landmarks.map((landmarks, i) => {
      let confidenceScore = 0;
      if (results.handednesses && results.handednesses[i] && results.handednesses[i][0]) {
        confidenceScore = results.handednesses[i][0].score ?? 0;
      }
      // 手首(0)と各指先の中間値として全体重心Xを算出
      const centerX = landmarks.reduce((acc, pt) => acc + pt.x, 0) / landmarks.length;
      return { landmarks, confidenceScore, centerX };
    });

    if (candidates.length === 2) {
      // 2本の手が検出されている場合: X座標が大きい方(鏡像で画面左側)が確実に左手、小さい方が右手
      candidates.sort((a, b) => b.centerX - a.centerX); // 降順: [0]が左手, [1]が右手

      const assignHandedness = (cand: RawHandCandidate, handedness: 'Left' | 'Right'): HandData => {
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

      hands.push(assignHandedness(candidates[0], 'Left'));
      hands.push(assignHandedness(candidates[1], 'Right'));
      this.lastSingleHandedness = null;
    } else {
      // 1本の手のみ検出されている場合: 境界ヒステリシスで左右反転フリップを防止
      candidates.forEach((cand) => {
        let handedness: 'Left' | 'Right';
        if (this.lastSingleHandedness === 'Left') {
          // 左手状態から右手へ切り替えるには明確に右側 (x < 0.38) へ移動する必要がある
          handedness = cand.centerX < 0.38 ? 'Right' : 'Left';
        } else if (this.lastSingleHandedness === 'Right') {
          // 右手状態から左手へ切り替えるには明確に左側 (x > 0.54) へ移動する必要がある
          handedness = cand.centerX > 0.54 ? 'Left' : 'Right';
        } else {
          handedness = cand.centerX > 0.46 ? 'Left' : 'Right';
        }
        this.lastSingleHandedness = handedness;

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
        hands.push({
          handedness,
          score: cand.confidenceScore,
          fingertips,
          allLandmarks: cand.landmarks,
          centerX: cand.centerX,
        });
      });
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
