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
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
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
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      this.activeDelegate = 'CPU';
    }

    this.isInitialized = true;
  }

  // フレーム間での手の追跡継続性（左右誤反転防止用）
  private prevRightCenter: { x: number; y: number; z: number } | null = null;
  private prevLeftCenter: { x: number; y: number; z: number } | null = null;

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
      this.prevRightCenter = null;
      this.prevLeftCenter = null;
      return hands;
    }

    // 各手の重心座標とMediaPipe推定ラベルを取得
    interface RawHandCandidate {
      landmarks: { x: number; y: number; z: number }[];
      confidenceScore: number;
      mediaPipeHandedness: 'Left' | 'Right';
      centerX: number;
      centerY: number;
      centerZ: number;
    }

    const candidates: RawHandCandidate[] = results.landmarks.map((landmarks, i) => {
      let confidenceScore = 0;
      let mediaPipeHandedness: 'Left' | 'Right' = 'Right';

      if (results.handednesses && results.handednesses[i] && results.handednesses[i][0]) {
        const h = results.handednesses[i][0];
        confidenceScore = h.score ?? 0;
        // MediaPipe Tasks-Vision の categoryName ('Left' | 'Right')
        if (h.categoryName === 'Left' || h.categoryName === 'Right') {
          mediaPipeHandedness = h.categoryName;
        }
      }

      // 手首(0)と各MCP(5, 9, 13, 17)を中心とした手の平の重心
      const palmPoints = [landmarks[0], landmarks[5], landmarks[9], landmarks[13], landmarks[17]];
      const centerX = palmPoints.reduce((acc, pt) => acc + pt.x, 0) / palmPoints.length;
      const centerY = palmPoints.reduce((acc, pt) => acc + pt.y, 0) / palmPoints.length;
      const centerZ = palmPoints.reduce((acc, pt) => acc + pt.z, 0) / palmPoints.length;

      return {
        landmarks,
        confidenceScore,
        mediaPipeHandedness,
        centerX,
        centerY,
        centerZ,
      };
    });

    const buildHandData = (cand: RawHandCandidate, handedness: 'Left' | 'Right'): HandData => {
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

    if (candidates.length === 2) {
      // 2本の手が検出されている場合:
      // 鏡像前面カメラ映像では、画面左側（X大）が左手、画面右側（X小）が右手
      // X座標の大小関係と前フレーム座標の距離を考慮して安定割り当て
      candidates.sort((a, b) => b.centerX - a.centerX); // [0]が画面左(左手領域), [1]が画面右(右手領域)

      const leftHand = buildHandData(candidates[0], 'Left');
      const rightHand = buildHandData(candidates[1], 'Right');

      this.prevLeftCenter = { x: candidates[0].centerX, y: candidates[0].centerY, z: candidates[0].centerZ };
      this.prevRightCenter = { x: candidates[1].centerX, y: candidates[1].centerY, z: candidates[1].centerZ };

      hands.push(leftHand, rightHand);
    } else {
      // 1本の手のみ検出されている場合:
      // 演奏・打鍵は右手優先のため、画面極端左側(X > 0.75)でない限り安定して右手(Right)にロック
      const cand = candidates[0];
      let assignedHandedness: 'Left' | 'Right';

      if (this.prevRightCenter && !this.prevLeftCenter) {
        // 直前フレームで右手を追跡していた場合、右手追跡を一貫して維持
        assignedHandedness = 'Right';
      } else if (this.prevLeftCenter && !this.prevRightCenter) {
        // 直前フレームで左手を追跡していた場合、中央より右側(X < 0.40)に来たら右手に切り替え
        assignedHandedness = cand.centerX < 0.40 ? 'Right' : 'Left';
      } else if (this.prevRightCenter && this.prevLeftCenter) {
        // 直前まで両手あったが片手になった場合: 右手中心に近いか判定
        const distToR = Math.hypot(cand.centerX - this.prevRightCenter.x, cand.centerY - this.prevRightCenter.y);
        const distToL = Math.hypot(cand.centerX - this.prevLeftCenter.x, cand.centerY - this.prevLeftCenter.y);
        assignedHandedness = distToR <= distToL ? 'Right' : 'Left';
      } else {
        // 新規検出時: 画面極端左側(X > 0.75)でない限り、演奏対象手である右手(Right)として初期化
        assignedHandedness = cand.centerX > 0.75 ? 'Left' : 'Right';
      }

      if (assignedHandedness === 'Right') {
        this.prevRightCenter = { x: cand.centerX, y: cand.centerY, z: cand.centerZ };
        this.prevLeftCenter = null;
      } else {
        this.prevLeftCenter = { x: cand.centerX, y: cand.centerY, z: cand.centerZ };
        this.prevRightCenter = null;
      }

      hands.push(buildHandData(cand, assignedHandedness));
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
