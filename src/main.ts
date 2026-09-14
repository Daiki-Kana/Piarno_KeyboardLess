import { HandTracker, HandData, FingertipCoord } from './handTracker';
import { TapDetector, TapEvent, DebugRopeInfo } from './tapDetector';
import { DeskCalibrator } from './deskCalibrator';
import { PianoSynth } from './pianoSynth';
import { SongSequencer } from './songSequencer';
import { VirtualPositionManager, TargetFinger } from './virtualPositionManager';

// DOM 要素
const videoElement = document.getElementById('webcam') as HTMLVideoElement;
const canvasElement = document.getElementById('output-canvas') as HTMLCanvasElement;
const canvasCtx = canvasElement.getContext('2d')!;
const startOverlay = document.getElementById('start-overlay') as HTMLElement;
const cameraBtn = document.getElementById('camera-btn') as HTMLButtonElement;
const countdownBtn = document.getElementById('countdown-btn') as HTMLButtonElement;
const countdownDisplay = document.getElementById('countdown-display') as HTMLElement;

// デバッグHUD用DOM要素（横画面セーフエリア対応オーバーレイ）
const hudPerm = document.getElementById('hud-perm') as HTMLElement;
const hudCalib = document.getElementById('hud-calib') as HTMLElement;
const hudPitch = document.getElementById('hud-pitch') as HTMLElement;
const hudState = document.getElementById('hud-state') as HTMLElement;
const hudTipY = document.getElementById('hud-tip-y') as HTMLElement;
const hudRopeY = document.getElementById('hud-rope-y') as HTMLElement;
const hudDiff = document.getElementById('hud-diff') as HTMLElement;
const hudTarget = document.getElementById('hud-target') as HTMLElement;
const hudBtnUp = document.getElementById('hud-btn-up') as HTMLButtonElement;
const hudBtnDown = document.getElementById('hud-btn-down') as HTMLButtonElement;

const tracker = new HandTracker();
const deskCalibrator = new DeskCalibrator({ fallbackRopeY: 0.75 });
const tapDetector = new TapDetector({
  ropeY: 0.75,
  fingerRadius: 0.025,
  releaseMargin: 0.03,
  smoothingAlpha: 0.4,
  maxJumpPerFrame: 0.08,
  cooldownMs: 80,
});
const pianoSynth = new PianoSynth();
const sequencer = new SongSequencer();
const positionManager = new VirtualPositionManager('C4', 'C4');

// 指先座標の指数平滑化（EMA）と外れ値ジャンプガード用ステート
interface SmoothedPoint {
  x: number;
  y: number;
  z: number;
  lastTime: number;
}
const pointSmoothMap = new Map<string, SmoothedPoint>();

// 仮想ポジション管理により動的に決定される現在の打鍵監視対象指 (targetFinger)
let currentTarget: TargetFinger = positionManager.assignTargetFinger(sequencer.getCurrentNote());

// デバッグHUD用の最新ターゲット指先Y座標
let latestTargetTipY: number | null = null;

// 打鍵波紋エフェクト情報
interface VisualTapRipple {
  x: number; // 正規化座標 (0 ~ 1)
  y: number;
  startTime: number;
  duration: number;
  velocity: number;
}
const activeRipples: VisualTapRipple[] = [];

// 直近の打鍵時刻を保持（指先フラッシュ表示用）
const recentTapMap = new Map<string, number>();

let isCameraRunning = false;
let isStartingCamera = false;
let isPlaying = false;
let mediaStream: MediaStream | null = null;
let lastTimestamp = -1;

/**
 * 初期化処理
 */
async function initializeApp() {
  try {
    cameraBtn.textContent = 'モデル読み込み中...';
    cameraBtn.disabled = true;
    // ※ iOS Safari ではページ読み込み時の権限要求は即時拒否されるため、
    // ボタンタップ時のユーザージェスチャー直下で最優先要求する
    await tracker.init();
    cameraBtn.textContent = 'カメラを開始';
    cameraBtn.disabled = false;
    updateDebugHUD();
  } catch (error) {
    console.error('HandTracker 初期化失敗:', error);
    cameraBtn.textContent = '初期化に失敗しました';
  }
}

/**
 * 1. Webカメラの起動と構え確認プレビューの表示
 */
async function startCamera() {
  if (isCameraRunning || isStartingCamera) return;

  // 【iOS Safari最優先要件】ユーザージェスチャー直下で権限ダイアログを要求（他のいかなる非同期awaitより前に実行）
  const permPromise = deskCalibrator.requestPermissionAndStart();

  isStartingCamera = true;

  try {
    cameraBtn.textContent = 'カメラ起動中...';
    cameraBtn.disabled = true;

    // Web Audio API のオーディオコンテキストをユーザー操作契機で確実に起動
    await pianoSynth.ensureContext();

    // センサー権限要求の完了を待機し、HUDを即時更新
    await permPromise;
    updateDebugHUD();

    // iOS Safari 必須属性
    videoElement.setAttribute('playsinline', 'true');
    videoElement.setAttribute('webkit-playsinline', 'true');
    videoElement.muted = true;

    // 横画面を前提としたカメラ解像度の取得 (640x480 / 30fps)
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
    } catch (constraintErr) {
      console.warn('カメラ制約取得失敗。基本制約で再試行します:', constraintErr);
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false,
      });
    }

    videoElement.srcObject = mediaStream;

    // loadeddata を待機して再生と解像度確定を保証
    await new Promise<void>((resolve) => {
      const onReady = async () => {
        videoElement.removeEventListener('loadeddata', onReady);
        try {
          await videoElement.play();
        } catch (playErr) {
          console.warn('再生待機エラー:', playErr);
        }
        resolve();
      };
      if (videoElement.readyState >= 2 && videoElement.videoWidth > 0) {
        onReady();
      } else {
        videoElement.addEventListener('loadeddata', onReady);
      }
    });

    // Canvas 解像度をビデオと同期
    if (videoElement.videoWidth > 0 && videoElement.videoHeight > 0) {
      canvasElement.width = videoElement.videoWidth;
      canvasElement.height = videoElement.videoHeight;
    }

    isCameraRunning = true;
    isStartingCamera = false;

    // カメラ起動完了: 半透明プレビューに切り替え、ユーザーが机に手を構える準備ができるようにする
    startOverlay.classList.add('preview');
    cameraBtn.style.display = 'none';
    countdownBtn.style.display = 'block';
    countdownBtn.textContent = 'スタート';

    lastTimestamp = -1;
    startTrackingLoop();
  } catch (err) {
    console.error('Webカメラ取得失敗:', err);
    cameraBtn.textContent = 'カメラの取得に失敗しました';
    cameraBtn.disabled = false;
    isStartingCamera = false;
    alert('カメラへのアクセスを許可してください。');
  }
}

/**
 * 2. ボタン押下によってカウントダウンを開始し、演奏へ突入
 */
async function startCountdown() {
  if (!isCameraRunning || isPlaying) return;

  countdownBtn.style.display = 'none';
  countdownDisplay.classList.add('show');

  const countdownSequence = ['3', '2', '1', 'START!'];
  for (const text of countdownSequence) {
    countdownDisplay.textContent = text;
    await new Promise((resolve) => setTimeout(resolve, text === 'START!' ? 350 : 850));
  }

  // カウントダウン完了: オーバーレイを完全非表示にし、演奏を開始
  startOverlay.classList.add('hidden');
  countdownDisplay.classList.remove('show');
  isPlaying = true;
  lastTimestamp = -1;
}

/**
 * 超低遅延トラッキング描画ループ
 */
function startTrackingLoop() {
  const loop = () => {
    if (!isCameraRunning) return;

    const now = performance.now();

    if (videoElement.currentTime !== lastTimestamp) {
      lastTimestamp = videoElement.currentTime;

      // 解像度変化（端末の回転等）への追従
      if (
        videoElement.videoWidth > 0 &&
        (canvasElement.width !== videoElement.videoWidth ||
          canvasElement.height !== videoElement.videoHeight)
      ) {
        canvasElement.width = videoElement.videoWidth;
        canvasElement.height = videoElement.videoHeight;
      }

      // センサー自動キャリブレーションによる机面Y座標の動的反映
      const calibState = deskCalibrator.getState();
      tapDetector.setRopeY(calibState.calibratedRopeY);

      // 両手10本の指先トラッキング
      const rawHands = tracker.detect(videoElement, now);

      // 高速追従平滑化座標および打鍵検知
      const smoothedHands = processHandsAndDetectTaps(rawHands, now);

      // Canvasにターゲットのみ強調描画（テキストUIは完全非表示）
      renderTracking(smoothedHands, now);
    }

    requestAnimationFrame(loop);
  };

  requestAnimationFrame(loop);
}

/**
 * 単一指先の座標平滑化（外れ値ジャンプガード＋指数移動平均 EMA）
 * 机面付近でのノイズ飛びを物理的に防止し、滑らかな軌道を実現
 */
function smoothFingertip(
  key: string,
  raw: { x: number; y: number; z: number },
  timestamp: number
): { x: number; y: number; z: number } {
  const state = pointSmoothMap.get(key);
  if (!state) {
    const initial = { x: raw.x, y: raw.y, z: raw.z, lastTime: timestamp };
    pointSmoothMap.set(key, initial);
    return initial;
  }

  const dt = (timestamp - state.lastTime) / 1000.0;
  if (dt > 0.3 || dt <= 0.0) {
    state.x = raw.x;
    state.y = raw.y;
    state.z = raw.z;
    state.lastTime = timestamp;
    return state;
  }

  // 1フレームあたりの最大許容移動量（外れ値・瞬間ジャンプの遮断ガード）
  const maxJump = 0.08;
  const dx = Math.max(-maxJump, Math.min(maxJump, raw.x - state.x));
  const dy = Math.max(-maxJump, Math.min(maxJump, raw.y - state.y));
  const dz = Math.max(-maxJump, Math.min(maxJump, raw.z - state.z));

  const targetX = state.x + dx;
  const targetY = state.y + dy;
  const targetZ = state.z + dz;

  // 指数平滑化 (EMA: alpha = 0.40) で遅延を抑えつつジッターを除去
  const alpha = 0.40;
  state.x = alpha * targetX + (1.0 - alpha) * state.x;
  state.y = alpha * targetY + (1.0 - alpha) * state.y;
  state.z = alpha * targetZ + (1.0 - alpha) * state.z;
  state.lastTime = timestamp;

  return { x: state.x, y: state.y, z: state.z };
}

/**
 * 指先座標を平滑化し、打鍵を検知
 * 左右判定の反転フリップを防止し、画面描画マーカーと判定座標の両方を強力に平滑化
 */
function processHandsAndDetectTaps(hands: HandData[], timestamp: number): HandData[] {
  let noteTriggeredInThisFrame = false;
  let targetFoundInHands = false;

  const result = hands.map((hand) => {
    // handTracker でヒステリシス考慮済みの handedness を優先
    const resolvedHandedness: 'Left' | 'Right' =
      hand.handedness === 'Unknown'
        ? (hand.centerX > 0.46 ? 'Left' : 'Right')
        : (hand.handedness as 'Left' | 'Right');

    const isTargetHand = resolvedHandedness === currentTarget.handedness;

    const smoothedFingertips: FingertipCoord[] = hand.fingertips.map((tip) => {
      const key = `${resolvedHandedness}_${tip.tipIndex}`;

      // 指先座標の強力な平滑化と外れ値ジャンプガード
      const smoothed = smoothFingertip(key, { x: tip.x, y: tip.y, z: tip.z }, timestamp);

      // 該当指（targetFinger）かどうか
      const isTargetFinger = isTargetHand && tip.tipIndex === currentTarget.tipIndex;

      if (isTargetFinger) {
        targetFoundInHands = true;
        latestTargetTipY = smoothed.y;
      }

      // 演奏中かつ対象手の場合の打鍵判定（ターゲット指優先、同手の他指でも打鍵抜けを防止）
      const canEvaluateTap =
        isPlaying &&
        !noteTriggeredInThisFrame &&
        (isTargetFinger || isTargetHand);

      if (canEvaluateTap) {
        const tapEvent: TapEvent | null = tapDetector.processFingertip(
          resolvedHandedness,
          tip.tipIndex,
          tip.name,
          smoothed.x,
          smoothed.y,
          smoothed.z,
          timestamp
        );

        if (tapEvent) {
          noteTriggeredInThisFrame = true;

          // 現在の音符を即座に発音
          const currentNote = sequencer.getCurrentNote();
          if (currentNote.chord && currentNote.chord.length > 0) {
            pianoSynth.playChord(currentNote.chord as number[], tapEvent.velocity);
          } else {
            pianoSynth.playNote(currentNote.frequency, tapEvent.velocity);
          }

          console.log(
            `[Tap 発音成功] ${resolvedHandedness}手 ${tip.name} -> ` +
            `♪ ${currentNote.solfege}(${currentNote.pitch}, ${currentNote.frequency.toFixed(1)}Hz)`
          );

          // 打鍵波紋エフェクト
          activeRipples.push({
            x: smoothed.x,
            y: smoothed.y,
            startTime: timestamp,
            duration: 260,
            velocity: tapEvent.velocity,
          });

          // 打鍵直後フラッシュ用タイムスタンプ記憶
          recentTapMap.set(key, timestamp);

          // シーケンサーを1音前進
          const { nextNote } = sequencer.advance();

          // 次のターゲット指を決定
          currentTarget = positionManager.assignTargetFinger(nextNote);
        }
      }

      return {
        tipIndex: tip.tipIndex,
        name: tip.name,
        x: smoothed.x,
        y: smoothed.y,
        z: smoothed.z,
      };
    });

    return {
      ...hand,
      handedness: resolvedHandedness,
      fingertips: smoothedFingertips,
    };
  });

  if (!targetFoundInHands) {
    // ターゲット指が画面内に検知されていない場合はnull
    latestTargetTipY = null;
  }

  return result;
}

/**
 * 机上の打鍵基準線（仮想ロープ）をCanvasに描画
 * あらゆる背景・机面色でも確実に視認できるよう、黒のアウトライン（3px）付きの赤線（1.5px）で描画
 */
function renderVirtualRope(width: number, height: number) {
  const ropeY = tapDetector.getRopeY();
  const py = ropeY * height;

  canvasCtx.save();
  // 1. 黒のアウトライン (線幅 3px) で下地を作成
  canvasCtx.strokeStyle = '#000000';
  canvasCtx.lineWidth = 3;
  canvasCtx.setLineDash([]); // 実線で途切れなく明瞭に表示
  canvasCtx.beginPath();
  canvasCtx.moveTo(0, py);
  canvasCtx.lineTo(width, py);
  canvasCtx.stroke();

  // 2. 赤の実線 (線幅 1.5px) で鮮明に重ね描き
  canvasCtx.strokeStyle = '#ff3333';
  canvasCtx.lineWidth = 1.5;
  canvasCtx.beginPath();
  canvasCtx.moveTo(0, py);
  canvasCtx.lineTo(width, py);
  canvasCtx.stroke();
  canvasCtx.restore();

  // 画面右側に控えめなラベル表示（CSS scaleX(-1) を相殺補正）
  canvasCtx.save();
  canvasCtx.translate(width, 0);
  canvasCtx.scale(-1, 1);
  canvasCtx.fillStyle = '#ff3333';
  canvasCtx.font = 'bold 11px monospace';
  canvasCtx.textAlign = 'right';
  canvasCtx.textBaseline = 'bottom';
  canvasCtx.shadowColor = '#000000';
  canvasCtx.shadowBlur = 3;
  canvasCtx.fillText(`ROPE (y=${ropeY.toFixed(2)})`, width - 12, py - 3);
  canvasCtx.restore();
}

/**
 * 画面左上のデバッグHUD (横画面セーフエリア対応HTMLオーバーレイ) の内容を更新
 */
function updateDebugHUD() {
  const calibState = deskCalibrator.getState();
  const debugInfo: DebugRopeInfo | null = tapDetector.getDebugInfo(currentTarget.handedness, currentTarget.tipIndex);
  const stateText = debugInfo ? debugInfo.state : (latestTargetTipY !== null && latestTargetTipY >= tapDetector.getRopeY() ? 'TOUCHED' : 'AIRBORNE');
  const tipY = debugInfo ? debugInfo.yTip : latestTargetTipY;
  const tipYText = tipY !== null ? tipY.toFixed(3) : '--';
  const ropeY = tapDetector.getRopeY();
  const ropeYText = ropeY.toFixed(3);
  const diffText =
    tipY !== null
      ? (tipY - ropeY >= 0 ? `+${(tipY - ropeY).toFixed(3)}` : (tipY - ropeY).toFixed(3))
      : '--';
  const pitchText =
    calibState.pitchDeg !== null
      ? `${calibState.pitchDeg >= 0 ? '+' : ''}${calibState.pitchDeg.toFixed(1)}°`
      : '--';

  if (hudPerm) {
    hudPerm.textContent = calibState.permissionStatus;
    hudPerm.className = `hud-perm-${calibState.permissionStatus}`;
  }
  if (hudCalib) {
    hudCalib.textContent = calibState.status;
    hudCalib.className = calibState.status === 'Sensor Calibrated' ? 'hud-status-calibrated' : 'hud-status-fallback';
  }
  if (hudPitch) {
    hudPitch.textContent = pitchText;
  }
  if (hudState) {
    hudState.textContent = stateText;
    hudState.className = stateText === 'TOUCHED' ? 'hud-state-touched' : 'hud-state-airborne';
  }
  if (hudTipY) {
    hudTipY.textContent = tipYText;
  }
  if (hudRopeY) {
    hudRopeY.textContent = ropeYText;
  }
  if (hudDiff) {
    hudDiff.textContent = diffText;
  }
  if (hudTarget) {
    hudTarget.textContent = currentTarget.name;
  }
}

/**
 * Canvas描画: 仮想ロープ・波紋・ターゲット指・デバッグHUDを描画
 */
function renderTracking(hands: HandData[], currentTimestamp: number) {
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

  const width = canvasElement.width;
  const height = canvasElement.height;

  // 1. 打鍵波紋エフェクトの描画 (白黒・ミニマル)
  for (let i = activeRipples.length - 1; i >= 0; i--) {
    const ripple = activeRipples[i];
    const elapsed = currentTimestamp - ripple.startTime;
    const progress = elapsed / ripple.duration;

    if (progress >= 1.0) {
      activeRipples.splice(i, 1);
      continue;
    }

    const rx = ripple.x * width;
    const ry = ripple.y * height;
    const baseRadius = 10;
    const maxRadius = 42 + ripple.velocity * 18;
    const currentRadius = baseRadius + (maxRadius - baseRadius) * Math.sin((progress * Math.PI) / 2);
    const alpha = (1.0 - progress) * 0.9;

    // 拡散する白い波紋リング
    canvasCtx.beginPath();
    canvasCtx.arc(rx, ry, currentRadius, 0, 2 * Math.PI);
    canvasCtx.strokeStyle = `rgba(255, 255, 255, ${alpha.toFixed(3)})`;
    canvasCtx.lineWidth = 2.5 * (1.0 - progress * 0.4);
    canvasCtx.stroke();

    // 内側の微かな光
    canvasCtx.beginPath();
    canvasCtx.arc(rx, ry, currentRadius * 0.65, 0, 2 * Math.PI);
    canvasCtx.fillStyle = `rgba(255, 255, 255, ${(alpha * 0.25).toFixed(3)})`;
    canvasCtx.fill();
  }

  // 2. 指先ポイントの描画（対象指のみ白黒二重丸で強調表示、他指は非表示）
  hands.forEach((hand) => {
    hand.fingertips.forEach((tip) => {
      const px = tip.x * width;
      const py = tip.y * height;

      const isTarget =
        hand.handedness === currentTarget.handedness && tip.tipIndex === currentTarget.tipIndex;

      const key = `${hand.handedness}_${tip.tipIndex}`;
      const lastTapTime = recentTapMap.get(key) ?? -9999;
      const isRecentlyTapped = currentTimestamp - lastTapTime < 120;

      if (isTarget) {
        if (isRecentlyTapped) {
          // 打鍵成功瞬間の高輝度白フラッシュ (半径 18 -> 24px)
          canvasCtx.beginPath();
          canvasCtx.arc(px, py, 24, 0, 2 * Math.PI);
          canvasCtx.fillStyle = '#ffffff';
          canvasCtx.fill();
          canvasCtx.lineWidth = 3.5;
          canvasCtx.strokeStyle = '#000000';
          canvasCtx.stroke();
        } else {
          // 外側の黒枠白ターゲットリング (半径 16 -> 22px)
          canvasCtx.beginPath();
          canvasCtx.arc(px, py, 22, 0, 2 * Math.PI);
          canvasCtx.lineWidth = 3.5;
          canvasCtx.strokeStyle = '#000000';
          canvasCtx.stroke();

          canvasCtx.beginPath();
          canvasCtx.arc(px, py, 22, 0, 2 * Math.PI);
          canvasCtx.lineWidth = 2.0;
          canvasCtx.strokeStyle = '#ffffff';
          canvasCtx.stroke();

          // 内側の白丸 (半径 7 -> 10px)
          canvasCtx.beginPath();
          canvasCtx.arc(px, py, 10, 0, 2 * Math.PI);
          canvasCtx.fillStyle = '#ffffff';
          canvasCtx.fill();
          canvasCtx.lineWidth = 2.5;
          canvasCtx.strokeStyle = '#000000';
          canvasCtx.stroke();

          // 中心黒ドット (半径 2 -> 3px)
          canvasCtx.beginPath();
          canvasCtx.arc(px, py, 3, 0, 2 * Math.PI);
          canvasCtx.fillStyle = '#000000';
          canvasCtx.fill();
        }
      }
    });
  });

  // 3. 机上の打鍵基準線（仮想ロープ）を波紋・指先マーカーの最前面に描画
  renderVirtualRope(width, height);

  // 4. 左上デバッグHUDの内容を更新 (横画面セーフエリア対応HTMLオーバーレイ)
  updateDebugHUD();
}

// イベントリスナー
cameraBtn.addEventListener('click', startCamera);
countdownBtn.addEventListener('click', startCountdown);

// デバッグHUDの [▲] [▼] ボタン直接クリックリスナー
if (hudBtnUp) {
  hudBtnUp.addEventListener('click', (e) => {
    e.stopPropagation();
    deskCalibrator.adjustManualOffset(-0.02);
    tapDetector.setRopeY(deskCalibrator.getState().calibratedRopeY);
    console.log(`[Rope位置] 上へ微調整: ${tapDetector.getRopeY().toFixed(2)}`);
  });
}

if (hudBtnDown) {
  hudBtnDown.addEventListener('click', (e) => {
    e.stopPropagation();
    deskCalibrator.adjustManualOffset(+0.02);
    tapDetector.setRopeY(deskCalibrator.getState().calibratedRopeY);
    console.log(`[Rope位置] 下へ微調整: ${tapDetector.getRopeY().toFixed(2)}`);
  });
}

// 画面タップでオーディオを確実に再開
window.addEventListener('pointerdown', () => {
  pianoSynth.ensureContext();
});

// キーボード上下矢印キー (↑ / ↓) でも即座にロープ高さを微調整可能
window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') {
    deskCalibrator.adjustManualOffset(-0.02);
    tapDetector.setRopeY(deskCalibrator.getState().calibratedRopeY);
    console.log(`[Rope位置] ↑微調整: ${tapDetector.getRopeY().toFixed(2)}`);
  } else if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') {
    deskCalibrator.adjustManualOffset(+0.02);
    tapDetector.setRopeY(deskCalibrator.getState().calibratedRopeY);
    console.log(`[Rope位置] ↓微調整: ${tapDetector.getRopeY().toFixed(2)}`);
  }
});

// アプリ開始
initializeApp();
