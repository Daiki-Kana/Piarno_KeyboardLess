/**
 * ジャイロ・加速度センサー（重力ベクトル）による机面自動キャリブレーションモジュール
 * ピンホールカメラ投影モデルに基づき、スマートフォンの設置傾き角（ピッチ角）から
 * 現実の机面の画面正規化Y座標（y_rope）を動的に算出し、追従させる。
 */

export type CalibrationStatus = 'Sensor Calibrated' | 'Fallback';
export type PermissionStatus = 'pending' | 'granted' | 'denied' | 'unsupported';

export interface DeskCalibratorConfig {
  /** 垂直画角 (rad, 一般的なスマートフォンインカメラはおよそ 55度 = 0.96 rad) */
  verticalFovRad?: number;
  /** 机上スタンド設置時の想定基準ピッチ角 (度数法, デフォルト: 15度) */
  standBiasPitchDeg?: number;
  /** 基準ピッチ角での机面Y座標 (デフォルト: 0.72) */
  baseRopeY?: number;
  /** 角度変化に対する机面移動の感度ゲイン (デフォルト: 0.35。角度変化に対して細かく繊細に上下追従させる) */
  pitchSensitivity?: number;
  /** 加速度センサー値（重力ベクトル）の指数平滑化係数 (EMA, 0.0 ~ 1.0, デフォルト: 0.15) */
  smoothingAlpha?: number;
  /** 描画フレーム間でのロープY座標の追従平滑化係数 (0.0 ~ 1.0, デフォルト: 0.15) */
  ropeSmoothingAlpha?: number;
  /** 1フレームあたりの最大ロープ移動量 (急激な跳ね上がりを抑えるレートリミット, デフォルト: 0.015) */
  maxJumpPerFrame?: number;
  /** センサー取得不可時の安全なフォールバックY座標 (デフォルト: 0.75) */
  fallbackRopeY?: number;
}

export interface CalibrationState {
  status: CalibrationStatus;
  permissionStatus: PermissionStatus;
  /** スマホのピッチ角（度数法: 垂直起立時0°、後ろ倒れで仰角+、前倒れで俯角-） */
  pitchDeg: number | null;
  /** ピンホール投影モデルから導出された机面Y座標 (0.0 ~ 1.0) */
  calibratedRopeY: number;
}

export class DeskCalibrator {
  private verticalFovRad: number;
  private standBiasPitchDeg: number;
  private baseRopeY: number;
  private pitchSensitivity: number;
  private smoothingAlpha: number;
  private ropeSmoothingAlpha: number;
  private maxJumpPerFrame: number;
  private fallbackRopeY: number;

  private status: CalibrationStatus = 'Fallback';
  private permissionStatus: PermissionStatus = 'pending';
  private usingMotionSensor: boolean = false;
  private smoothedGx: number | null = null;
  private smoothedGy: number | null = null;
  private smoothedGz: number | null = null;
  private smoothedPitchDeg: number | null = null;
  private targetRopeY: number;
  private currentRopeY: number;
  private manualOffset: number = 0; // ユーザーの手動微調整オフセット
  private isListening: boolean = false;
  private lastSensorTimestamp: number = 0;
  private lastStepTimestamp: number = 0;

  constructor(config: DeskCalibratorConfig = {}) {
    // 垂直画角: デフォルト 55° (約0.9599 rad)
    this.verticalFovRad = config.verticalFovRad ?? (55 * Math.PI) / 180;
    // スマホスタンド等で机上に立てた際の一般的な後傾角（約15度）
    this.standBiasPitchDeg = config.standBiasPitchDeg ?? 15;
    // 基準角度での机面Y座標
    this.baseRopeY = config.baseRopeY ?? 0.72;
    // 角度変化に対する変位感度 (0.35に設定し、1度あたり約0.006のきめ細かな変位を実現)
    this.pitchSensitivity = config.pitchSensitivity ?? 0.35;
    this.smoothingAlpha = config.smoothingAlpha ?? 0.15;
    this.ropeSmoothingAlpha = config.ropeSmoothingAlpha ?? 0.15;
    this.maxJumpPerFrame = config.maxJumpPerFrame ?? 0.015;
    this.fallbackRopeY = config.fallbackRopeY ?? 0.75;
    this.targetRopeY = this.fallbackRopeY;
    this.currentRopeY = this.fallbackRopeY;

    // 初期状態でのパーミッションAPIサポート確認
    if (typeof window !== 'undefined') {
      if (
        typeof DeviceOrientationEvent === 'undefined' &&
        !('ondeviceorientation' in window)
      ) {
        this.permissionStatus = 'unsupported';
      }
    }
  }

  /**
   * ユーザージェスチャー（ボタンタップ）直下で最優先実行される権限要求とリスナー開始
   * ※ iOS Safari では、いかなる非同期 await より前（同期的）に呼ぶ必要がある
   */
  public async requestPermissionAndStart(): Promise<boolean> {
    if (this.isListening) return true;

    // iOS 13+ Safari の DeviceOrientationEvent.requestPermission
    if (
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof (DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }).requestPermission === 'function'
    ) {
      try {
        const perm = await (DeviceOrientationEvent as unknown as { requestPermission: () => Promise<string> }).requestPermission();
        if (perm === 'granted') {
          this.permissionStatus = 'granted';
          this.attachListeners();
          return true;
        } else {
          console.warn('[DeskCalibrator] DeviceOrientation permission denied:', perm);
          this.permissionStatus = 'denied';
          this.status = 'Fallback';
          return false;
        }
      } catch (err) {
        console.warn('[DeskCalibrator] Error requesting orientation permission:', err);
        this.permissionStatus = 'denied';
        this.status = 'Fallback';
        return false;
      }
    } else if (typeof window !== 'undefined' && ('ondevicemotion' in window || 'ondeviceorientation' in window)) {
      // Android / PC等: requestPermission APIが不要な環境
      this.permissionStatus = 'granted';
      this.attachListeners();
      return true;
    } else {
      this.permissionStatus = 'unsupported';
      this.status = 'Fallback';
      return false;
    }
  }

  /**
   * センサーリスナーを登録
   */
  private attachListeners(): void {
    if (this.isListening) return;

    if (typeof window !== 'undefined' && 'ondevicemotion' in window) {
      window.addEventListener('devicemotion', this.handleMotion, true);
    }
    if (typeof window !== 'undefined' && 'ondeviceorientation' in window) {
      window.addEventListener('deviceorientation', this.handleOrientation, true);
    }

    this.isListening = true;
  }

  public getPermissionStatus(): PermissionStatus {
    return this.permissionStatus;
  }

  /**
   * 重力加速度ベクトル (accelerationIncludingGravity) による精密ピッチ角計算
   * 画面平面内成分と垂直法線成分の合成により、端末の向き（縦・横・回転方向）に依存せず
   * ジンバルロック・特異点のない完全連続な傾き角を算出する
   */
  private handleMotion = (event: DeviceMotionEvent): void => {
    const acc = event.accelerationIncludingGravity;
    if (!acc || acc.x === null || acc.y === null || acc.z === null) {
      return;
    }

    // 重力ベクトルが取得可能なため、優先フラグをセット
    this.usingMotionSensor = true;

    // 重力ベクトルのローパス平滑化（机打鍵時の振動ノイズを遮断）
    const alpha = this.smoothingAlpha;
    if (this.smoothedGx === null || this.smoothedGy === null || this.smoothedGz === null) {
      this.smoothedGx = acc.x;
      this.smoothedGy = acc.y;
      this.smoothedGz = acc.z;
    } else {
      this.smoothedGx = alpha * acc.x + (1.0 - alpha) * this.smoothedGx;
      this.smoothedGy = alpha * acc.y + (1.0 - alpha) * this.smoothedGy;
      this.smoothedGz = alpha * acc.z + (1.0 - alpha) * this.smoothedGz;
    }

    // 画面平面内の重力ベクトル大きさ
    const gPlane = Math.sqrt(
      this.smoothedGx * this.smoothedGx + this.smoothedGy * this.smoothedGy
    );
    const gz = this.smoothedGz;

    // ピッチ角計算: atan2(gz, gPlane)
    // 垂直直立時: gz ≈ 0 => 0°
    // スタンドで後ろに傾く(仰角): gz > 0 => 正の角度
    // 前に傾く(俯角): gz < 0 => 負の角度
    const computedPitchDeg = (Math.atan2(gz, Math.max(0.1, gPlane)) * 180) / Math.PI;

    if (!isNaN(computedPitchDeg)) {
      this.updatePitch(computedPitchDeg);
    }
  };

  /**
   * 端末の回転イベント（devicemotion未対応環境用のフォールバック）
   */
  private handleOrientation = (event: DeviceOrientationEvent): void => {
    // devicemotion が動作している場合は値の競合・重複ジャンプを防ぐため無視
    if (this.usingMotionSensor) return;

    if (event.beta === null && event.gamma === null) return;

    let rawPitch = 0;
    const orientationType = screen.orientation?.type || '';
    const isLandscape =
      orientationType.includes('landscape') ||
      Math.abs((window.orientation as number) || 0) === 90;

    if (isLandscape) {
      const orientationAngle =
        (screen.orientation?.angle ?? (window.orientation as number)) || 90;
      if (orientationAngle === 90) {
        rawPitch = event.gamma !== null ? -event.gamma : 0;
      } else {
        rawPitch = event.gamma !== null ? event.gamma : 0;
      }
    } else {
      const beta = event.beta ?? 90;
      rawPitch = beta - 90;
    }

    this.updatePitch(rawPitch);
  };

  /**
   * ピッチ角の平滑化と目標机面Y座標の更新
   */
  private updatePitch(rawPitchDeg: number): void {
    // 異常値ガード (-60° ~ +60° の範囲内に制限)
    const clampedPitch = Math.max(-60, Math.min(60, rawPitchDeg));

    if (this.smoothedPitchDeg === null) {
      this.smoothedPitchDeg = clampedPitch;
    } else {
      this.smoothedPitchDeg =
        this.smoothingAlpha * clampedPitch +
        (1.0 - this.smoothingAlpha) * this.smoothedPitchDeg;
    }

    this.status = 'Sensor Calibrated';
    this.lastSensorTimestamp = performance.now();

    // 目標ロープY座標を算出
    this.computeTargetRopeY();
  }

  /**
   * ピンホールカメラ投影モデルに基づく机面位置計算:
   * 机上スタンド設置基準角（standBiasPitchDeg: 15°）からの差分角に対して、
   * 感度ゲイン（pitchSensitivity: 0.35）を適用したピンホール投影変位量を加算。
   * これにより、角度の微小な変化に対してラインが一気に跳ねることなく、細かく繊細に上下する。
   */
  private computeTargetRopeY(): void {
    if (this.smoothedPitchDeg === null) {
      this.targetRopeY = this.fallbackRopeY + this.manualOffset;
      return;
    }

    // スタンド設置角からの差分角 (rad)
    const deltaPitchDeg = this.smoothedPitchDeg - this.standBiasPitchDeg;
    const deltaPitchRad = (deltaPitchDeg * Math.PI) / 180;

    // ピンホール投影変位量に感度ゲインを適用
    const tanVfovHalf = Math.tan(this.verticalFovRad / 2);
    const projectedDeltaY =
      (Math.tan(deltaPitchRad) / (2 * tanVfovHalf)) * this.pitchSensitivity;

    // 基準Y座標に変位を加算
    const calculatedY = this.baseRopeY + projectedDeltaY;

    // 画面安全表示範囲 (0.35 ~ 0.90) にクランプ
    const clampedBaseY = Math.max(0.35, Math.min(0.90, calculatedY));
    this.targetRopeY = clampedBaseY + this.manualOffset;
  }

  /**
   * ユーザーによる微調整オフセットの加算 (▲ / ▼ キー等)
   */
  public adjustManualOffset(delta: number): void {
    this.manualOffset += delta;
    // オフセットが過剰になりすぎないよう制限 (-0.3 ~ +0.3)
    this.manualOffset = Math.max(-0.3, Math.min(0.3, this.manualOffset));
    if (this.status === 'Fallback') {
      this.targetRopeY = this.fallbackRopeY + this.manualOffset;
      this.currentRopeY = this.targetRopeY;
    } else {
      this.computeTargetRopeY();
    }
  }

  /**
   * 現在のキャリブレーション状態を取得
   * 毎フレームの呼び出し時に目標値へ向けた滑らかな補間（LERP＋レートリミット）を適用
   */
  public getState(): CalibrationState {
    const now = performance.now();

    // 一定時間センサーが来ない場合は Fallback に移行
    if (
      this.status === 'Sensor Calibrated' &&
      now - this.lastSensorTimestamp > 2500
    ) {
      this.status = 'Fallback';
      this.targetRopeY = this.fallbackRopeY + this.manualOffset;
    }

    // 目標値（targetRopeY）に向けたフレーム間平滑化補間
    // 同一描画フレーム内（5ms未満）での多重呼び出し時は補間ステップを重複実行しないようガード
    if (now - this.lastStepTimestamp >= 5) {
      const diff = this.targetRopeY - this.currentRopeY;
      if (Math.abs(diff) > 0.0001) {
        const step = diff * this.ropeSmoothingAlpha;
        // 1フレームあたりの最大変化量でクランプ（急激な跳躍を防止し、細かく滑らかに追従）
        const clampedStep = Math.max(
          -this.maxJumpPerFrame,
          Math.min(this.maxJumpPerFrame, step)
        );
        this.currentRopeY += clampedStep;
      }
      this.lastStepTimestamp = now;
    }

    return {
      status: this.status,
      permissionStatus: this.permissionStatus,
      pitchDeg: this.smoothedPitchDeg,
      calibratedRopeY: Math.max(0.30, Math.min(0.92, this.currentRopeY)),
    };
  }

  /**
   * 破棄処理
   */
  public stop(): void {
    if (!this.isListening) return;
    if (typeof window !== 'undefined') {
      window.removeEventListener('devicemotion', this.handleMotion, true);
      window.removeEventListener('deviceorientation', this.handleOrientation, true);
    }
    this.isListening = false;
  }
}
