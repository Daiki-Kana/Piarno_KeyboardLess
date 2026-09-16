import { HandTracker, HandData } from './handTracker';
import { PianoSynth } from './pianoSynth';
import { SongSequencer } from './songSequencer';
import {
  AnchorLineTracker,
  AnchorLineResult,
  FingertipLandmarkIndex,
  getAnchorTipIndex,
} from './anchorLineTracker';

// DOM 要素
const videoElement = document.getElementById('webcam') as HTMLVideoElement;
const canvasElement = document.getElementById('output-canvas') as HTMLCanvasElement;
const canvasCtx = canvasElement.getContext('2d')!;
const startOverlay = document.getElementById('start-overlay') as HTMLElement;
const cameraBtn = document.getElementById('camera-btn') as HTMLButtonElement;
const countdownBtn = document.getElementById('countdown-btn') as HTMLButtonElement;
const countdownDisplay = document.getElementById('countdown-display') as HTMLElement;

// 演奏HUD要素
const hudFingerEl = document.getElementById('hud-finger');
const hudNoteEl = document.getElementById('hud-note');
const hudProgressEl = document.getElementById('hud-progress');

const tracker = new HandTracker();
const pianoSynth = new PianoSynth();
const sequencer = new SongSequencer();
const anchorTracker = new AnchorLineTracker();

let currentAnchorResult: AnchorLineResult | null = null;


// 打鍵波紋エフェクト情報
interface VisualTapRipple {
  x: number; // 正規化座標 (0 ~ 1)
  y: number;
  startTime: number;
  duration: number;
  velocity: number;
}
const activeRipples: VisualTapRipple[] = [];
let recentHitTimestamp = -9999;

let isCameraRunning = false;
let isStartingCamera = false;
let isPlaying = false;
let mediaStream: MediaStream | null = null;



/**
 * 初期化処理
 */
async function initializeApp() {
  try {
    cameraBtn.textContent = 'モデル読み込み中...';
    cameraBtn.disabled = true;
    await tracker.init();
    cameraBtn.textContent = 'カメラを開始';
    cameraBtn.disabled = false;
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
  isStartingCamera = true;

  try {
    cameraBtn.textContent = 'カメラ起動中...';
    cameraBtn.disabled = true;

    // Web Audio API のオーディオコンテキストをユーザー操作契機で確実に起動
    await pianoSynth.ensureContext();

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

  // オーディオコンテキストを確実にアクティブ化
  await pianoSynth.ensureContext();

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
}

/**
 * 超低遅延トラッキング描画ループ
 * requestVideoFrameCallback を活用し、カメラ映像のフレーム更新と完全同期させて遅延を極限まで排除
 */
function startTrackingLoop() {
  const onFrame = () => {
    if (!isCameraRunning) return;

    const now = performance.now();

    // 解像度変化（端末の回転等）への追従
    if (
      videoElement.videoWidth > 0 &&
      (canvasElement.width !== videoElement.videoWidth ||
        canvasElement.height !== videoElement.videoHeight)
    ) {
      canvasElement.width = videoElement.videoWidth;
      canvasElement.height = videoElement.videoHeight;
    }

    // MediaPipeによる最新フレームの生トラッキング
    const rawHands = tracker.detect(videoElement, now);

    // シーケンサーから現在のターゲット音符・指を取得
    const currentNote = sequencer.getCurrentNote();
    const targetTipIndex: FingertipLandmarkIndex =
      (currentNote.targetFingerTipIndex as FingertipLandmarkIndex) ?? 12;
    const targetHand: 'Right' | 'Left' = (currentNote.hand as 'Right' | 'Left') ?? 'Right';

    // 指定された手の相互アンカー追従ラインおよびステートマシン判定を計算
    currentAnchorResult = null;
    let activeHandData = rawHands.find((h) => h.handedness === targetHand);
    // 片手のみ検出されている場合は、左右判定のブレによる不発を防ぐためその手を対象とする
    if (!activeHandData && rawHands.length === 1) {
      activeHandData = rawHands[0];
    }

    if (activeHandData && activeHandData.allLandmarks) {
      currentAnchorResult = anchorTracker.calculateLine(
        activeHandData.allLandmarks,
        targetTipIndex,
        canvasElement.width,
        canvasElement.height,
        now
      );

      // HIT 検知時の発音およびシーケンサー連携（非指定指は完全にマスク）
      if (currentAnchorResult && currentAnchorResult.tapEvaluation.isHit) {
        const velocity = currentAnchorResult.tapEvaluation.velocity;

        // Web Audio API のコンテキストを確実に再開して発音
        pianoSynth.ensureContext();
        if (currentNote.chord && currentNote.chord.length > 0) {
          pianoSynth.playChord(currentNote.chord as number[], velocity);
        } else {
          pianoSynth.playNote(currentNote.frequency, velocity);
        }

        console.log(
          `[HIT 打鍵成功] ${currentNote.targetFingerLabel} (${currentNote.targetFingerName}) -> ` +
          `♪ ${currentNote.solfege}(${currentNote.pitch}, ${currentNote.frequency.toFixed(1)}Hz)`
        );

        recentHitTimestamp = now;

        // 打鍵波紋エフェクト
        activeRipples.push({
          x: currentAnchorResult.targetX / canvasElement.width,
          y: currentAnchorResult.targetY / canvasElement.height,
          startTime: now,
          duration: 280,
          velocity,
        });

        // シーケンサーを1音前進（末尾到達時は先頭へ自動ループ）
        sequencer.advance();
        anchorTracker.resetState();
      }
    }

    // 次のターゲット音符・指情報でHUDと描画ターゲットを即時更新
    const activeNote = sequencer.getCurrentNote();
    const activeTip: FingertipLandmarkIndex =
      (activeNote.targetFingerTipIndex as FingertipLandmarkIndex) ?? 12;
    const activeHand: 'Right' | 'Left' = (activeNote.hand as 'Right' | 'Left') ?? 'Right';

    // HUD表示のリアルタイム更新
    if (hudFingerEl) {
      hudFingerEl.textContent = `${activeNote.targetFingerLabel} (${activeNote.targetFingerName})`;
    }
    if (hudNoteEl) {
      hudNoteEl.textContent = `${activeNote.pitch} (${activeNote.solfege})`;
    }
    if (hudProgressEl) {
      hudProgressEl.textContent = `${sequencer.getCurrentIndex() + 1} / ${sequencer.getTotalNotes()}`;
    }

    // Canvasに相互アンカー追従ライン、指先、ステート、波紋を描画（次の指を即時反映）
    renderTracking(rawHands, now, currentAnchorResult, activeTip, activeHand);

    // 次フレームの同期要求
    if ('requestVideoFrameCallback' in videoElement) {
      videoElement.requestVideoFrameCallback(onFrame);
    } else {
      requestAnimationFrame(onFrame);
    }
  };

  if ('requestVideoFrameCallback' in videoElement) {
    videoElement.requestVideoFrameCallback(onFrame);
  } else {
    requestAnimationFrame(onFrame);
  }
}

// デバッグ数値・オフセット調整・ステート用 DOM 要素
const debugStateEl = document.getElementById('debug-state');
const debugScaleEl = document.getElementById('debug-scale');
const debugLineEl = document.getElementById('debug-line');
const debugDepthEl = document.getElementById('debug-depth');
const offsetValEl = document.getElementById('offset-val');
const btnOffsetInc = document.getElementById('btn-offset-inc');
const btnOffsetDec = document.getElementById('btn-offset-dec');

let currentOffsetRatio = 0.50;

// オフセット微調整ボタンのイベント
if (btnOffsetInc) {
  btnOffsetInc.addEventListener('click', (e) => {
    e.stopPropagation();
    currentOffsetRatio = Math.min(0.80, Math.round((currentOffsetRatio + 0.01) * 100) / 100);
    anchorTracker.setOffsetRatio(currentOffsetRatio);
    if (offsetValEl) offsetValEl.textContent = `${Math.round(currentOffsetRatio * 100)}%`;
  });
}

if (btnOffsetDec) {
  btnOffsetDec.addEventListener('click', (e) => {
    e.stopPropagation();
    currentOffsetRatio = Math.max(0.01, Math.round((currentOffsetRatio - 0.01) * 100) / 100);
    anchorTracker.setOffsetRatio(currentOffsetRatio);
    if (offsetValEl) offsetValEl.textContent = `${Math.round(currentOffsetRatio * 100)}%`;
  });
}

/**
 * Canvas描画:
 * 現在のターゲット指（Index / Middle）の直下に張り付く Line_Y をステートに応じた白黒デザインで描画
 */
function renderTracking(
  hands: HandData[],
  currentTimestamp: number,
  anchorResult: AnchorLineResult | null,
  targetTipIndex: FingertipLandmarkIndex,
  targetHand: 'Right' | 'Left'
) {
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
    const baseRadius = 8;
    const maxRadius = 38 + ripple.velocity * 16;
    const currentRadius = baseRadius + (maxRadius - baseRadius) * Math.sin((progress * Math.PI) / 2);
    const alpha = (1.0 - progress) * 0.9;

    // 拡散する白い波紋リング
    canvasCtx.beginPath();
    canvasCtx.arc(rx, ry, currentRadius, 0, 2 * Math.PI);
    canvasCtx.strokeStyle = `rgba(255, 255, 255, ${alpha.toFixed(3)})`;
    canvasCtx.lineWidth = 2.0 * (1.0 - progress * 0.3);
    canvasCtx.stroke();

    // 内側の淡い白光
    canvasCtx.beginPath();
    canvasCtx.arc(rx, ry, currentRadius * 0.6, 0, 2 * Math.PI);
    canvasCtx.fillStyle = `rgba(255, 255, 255, ${(alpha * 0.2).toFixed(3)})`;
    canvasCtx.fill();
  }

  // 2. 各指先の位置を描画
  const isRecentlyHit = currentTimestamp - recentHitTimestamp < 140;
  const anchorTipIndex = getAnchorTipIndex(targetTipIndex);

  hands.forEach((hand) => {
    const isTargetHand = hand.handedness === targetHand;

    hand.fingertips.forEach((tip) => {
      const px = tip.x * width;
      const py = tip.y * height;
      const isTargetFinger = isTargetHand && tip.tipIndex === targetTipIndex;
      const isAnchorFinger = isTargetHand && tip.tipIndex === anchorTipIndex;

      if (isTargetFinger) {
        if (isRecentlyHit) {
          // 打鍵成功瞬間の高輝度白フラッシュ
          canvasCtx.beginPath();
          canvasCtx.arc(px, py, 16, 0, 2 * Math.PI);
          canvasCtx.fillStyle = '#ffffff';
          canvasCtx.fill();
          canvasCtx.lineWidth = 3;
          canvasCtx.strokeStyle = '#000000';
          canvasCtx.stroke();
        } else {
          // 通常時の指定ターゲット指マーク（白黒二重丸）
          canvasCtx.beginPath();
          canvasCtx.arc(px, py, 14, 0, 2 * Math.PI);
          canvasCtx.lineWidth = 3;
          canvasCtx.strokeStyle = '#000000';
          canvasCtx.stroke();

          canvasCtx.beginPath();
          canvasCtx.arc(px, py, 14, 0, 2 * Math.PI);
          canvasCtx.lineWidth = 1.5;
          canvasCtx.strokeStyle = '#ffffff';
          canvasCtx.stroke();

          // 中心白丸
          canvasCtx.beginPath();
          canvasCtx.arc(px, py, 4, 0, 2 * Math.PI);
          canvasCtx.fillStyle = '#ffffff';
          canvasCtx.fill();
        }
      } else if (isAnchorFinger) {
        // アンカー指の先端マーク（細い黒枠灰丸＋十字）
        canvasCtx.beginPath();
        canvasCtx.arc(px, py, 7, 0, 2 * Math.PI);
        canvasCtx.lineWidth = 2.5;
        canvasCtx.strokeStyle = '#000000';
        canvasCtx.stroke();

        canvasCtx.beginPath();
        canvasCtx.arc(px, py, 7, 0, 2 * Math.PI);
        canvasCtx.lineWidth = 1.2;
        canvasCtx.strokeStyle = '#aaaaaa';
        canvasCtx.stroke();

        // 十字マーク
        canvasCtx.beginPath();
        canvasCtx.moveTo(px - 4, py);
        canvasCtx.lineTo(px + 4, py);
        canvasCtx.moveTo(px, py - 4);
        canvasCtx.lineTo(px, py + 4);
        canvasCtx.lineWidth = 1.2;
        canvasCtx.strokeStyle = '#ffffff';
        canvasCtx.stroke();
      } else if (isTargetHand && [4, 8, 12, 16, 20].includes(tip.tipIndex)) {
        // 対象手だが非ターゲット・非アンカーの指（薄いグレーのドット）
        canvasCtx.beginPath();
        canvasCtx.arc(px, py, 3, 0, 2 * Math.PI);
        canvasCtx.fillStyle = '#444444';
        canvasCtx.fill();
      }
    });
  });

  // 3. 相互アンカー追従ライン（Line_Y）のリアルタイム描画（ステート別線種）
  if (anchorResult) {
    const { lineY, targetX, targetY, lHand, depthFromLine, tapEvaluation } = anchorResult;
    const halfWidth = Math.max(42, lHand * 0.4);
    const state = tapEvaluation.state;

    // (a) 指定指先端から判定ラインへの垂直ガイド線
    canvasCtx.save();
    canvasCtx.setLineDash([3, 3]);
    canvasCtx.beginPath();
    canvasCtx.moveTo(targetX, targetY);
    canvasCtx.lineTo(targetX, lineY);
    canvasCtx.lineWidth = 1.2;
    canvasCtx.strokeStyle = state === 'ARMED' ? 'rgba(255, 255, 255, 0.85)' : 'rgba(255, 255, 255, 0.4)';
    canvasCtx.stroke();
    canvasCtx.restore();

    // (b) 判定ライン本体（ステートに応じた視覚フィードバック）
    if (state === 'ARMED') {
      // ARMED状態: 二重線（ダブルライン）で進入中を強調
      [-2.5, 2.5].forEach((dy) => {
        canvasCtx.beginPath();
        canvasCtx.moveTo(targetX - halfWidth, lineY + dy);
        canvasCtx.lineTo(targetX + halfWidth, lineY + dy);
        canvasCtx.lineWidth = 3;
        canvasCtx.strokeStyle = '#000000';
        canvasCtx.stroke();

        canvasCtx.beginPath();
        canvasCtx.moveTo(targetX - halfWidth, lineY + dy);
        canvasCtx.lineTo(targetX + halfWidth, lineY + dy);
        canvasCtx.lineWidth = 1.5;
        canvasCtx.strokeStyle = '#ffffff';
        canvasCtx.stroke();
      });
    } else if (state === 'HIT' || isRecentlyHit) {
      // HIT状態: 太い高輝度白フラッシュライン
      canvasCtx.beginPath();
      canvasCtx.moveTo(targetX - halfWidth - 6, lineY);
      canvasCtx.lineTo(targetX + halfWidth + 6, lineY);
      canvasCtx.lineWidth = 6;
      canvasCtx.strokeStyle = '#000000';
      canvasCtx.stroke();

      canvasCtx.beginPath();
      canvasCtx.moveTo(targetX - halfWidth - 6, lineY);
      canvasCtx.lineTo(targetX + halfWidth + 6, lineY);
      canvasCtx.lineWidth = 3.5;
      canvasCtx.strokeStyle = '#ffffff';
      canvasCtx.stroke();
    } else if (state === 'RESET') {
      // RESET状態: 破線（復帰待機）
      canvasCtx.save();
      canvasCtx.setLineDash([4, 4]);
      canvasCtx.beginPath();
      canvasCtx.moveTo(targetX - halfWidth, lineY);
      canvasCtx.lineTo(targetX + halfWidth, lineY);
      canvasCtx.lineWidth = 3;
      canvasCtx.strokeStyle = '#000000';
      canvasCtx.stroke();

      canvasCtx.beginPath();
      canvasCtx.moveTo(targetX - halfWidth, lineY);
      canvasCtx.lineTo(targetX + halfWidth, lineY);
      canvasCtx.lineWidth = 1.5;
      canvasCtx.strokeStyle = '#aaaaaa';
      canvasCtx.stroke();
      canvasCtx.restore();
    } else {
      // IDLE状態: 通常の細い水平線（白1.5px＋黒下地3.5px）
      canvasCtx.beginPath();
      canvasCtx.moveTo(targetX - halfWidth, lineY);
      canvasCtx.lineTo(targetX + halfWidth, lineY);
      canvasCtx.lineWidth = 3.5;
      canvasCtx.strokeStyle = '#000000';
      canvasCtx.stroke();

      canvasCtx.beginPath();
      canvasCtx.moveTo(targetX - halfWidth, lineY);
      canvasCtx.lineTo(targetX + halfWidth, lineY);
      canvasCtx.lineWidth = 1.5;
      canvasCtx.strokeStyle = '#ffffff';
      canvasCtx.stroke();
    }

    // (c) 両端のティックマーク（垂直目盛り: 4px）
    const tickH = state === 'ARMED' ? 6 : 4;
    [-halfWidth, halfWidth].forEach((offset) => {
      canvasCtx.beginPath();
      canvasCtx.moveTo(targetX + offset, lineY - tickH);
      canvasCtx.lineTo(targetX + offset, lineY + tickH);
      canvasCtx.lineWidth = 3.5;
      canvasCtx.strokeStyle = '#000000';
      canvasCtx.stroke();

      canvasCtx.beginPath();
      canvasCtx.moveTo(targetX + offset, lineY - tickH);
      canvasCtx.lineTo(targetX + offset, lineY + tickH);
      canvasCtx.lineWidth = 1.5;
      canvasCtx.strokeStyle = '#ffffff';
      canvasCtx.stroke();
    });

    // (d) HTML上のステート＆数値更新
    if (debugStateEl) {
      debugStateEl.textContent = state;
      debugStateEl.className = `state-badge state-${state.toLowerCase()}`;
    }
    if (debugScaleEl) debugScaleEl.textContent = `L_hand: ${Math.round(lHand)}px`;
    if (debugLineEl) debugLineEl.textContent = `Line_Y: ${Math.round(lineY)}px`;
    if (debugDepthEl) {
      const depthRounded = Math.round(depthFromLine);
      debugDepthEl.textContent = `ΔY: ${depthRounded > 0 ? '+' : ''}${depthRounded}px`;
      if (depthRounded >= 0) {
        debugDepthEl.classList.add('crossed');
      } else {
        debugDepthEl.classList.remove('crossed');
      }
    }
  } else {
    if (debugStateEl) {
      debugStateEl.textContent = 'IDLE';
      debugStateEl.className = 'state-badge state-idle';
    }
    if (debugScaleEl) debugScaleEl.textContent = `L_hand: 検出待機中`;
    if (debugLineEl) debugLineEl.textContent = `Line_Y: --`;
    if (debugDepthEl) {
      debugDepthEl.textContent = `ΔY: --`;
      debugDepthEl.classList.remove('crossed');
    }
  }
}

// イベントリスナー
cameraBtn.addEventListener('click', startCamera);
countdownBtn.addEventListener('click', startCountdown);

// 画面タップでオーディオを確実に再開可能にする
window.addEventListener('pointerdown', () => {
  pianoSynth.ensureContext();
});

// アプリ開始
initializeApp();



