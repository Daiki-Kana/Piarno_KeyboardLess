import { HandTracker, HandData, FingertipCoord } from './handTracker';
import { OneEuroFilter3D } from './oneEuroFilter';
import { TapDetector, TapEvent } from './tapDetector';
import { PianoSynth } from './pianoSynth';
import { SongSequencer } from './songSequencer';
import { VirtualPositionManager, TargetFinger, RIGHT_HAND_FIXED_FINGERS } from './virtualPositionManager';

// DOM 要素
const videoElement = document.getElementById('webcam') as HTMLVideoElement;
const canvasElement = document.getElementById('output-canvas') as HTMLCanvasElement;
const canvasCtx = canvasElement.getContext('2d')!;
const startOverlay = document.getElementById('start-overlay') as HTMLElement;
const cameraBtn = document.getElementById('camera-btn') as HTMLButtonElement;
const countdownBtn = document.getElementById('countdown-btn') as HTMLButtonElement;
const countdownDisplay = document.getElementById('countdown-display') as HTMLElement;

// デバッグUI 要素
const kSlider = document.getElementById('k-slider') as HTMLInputElement;
const kLabel = document.getElementById('debug-k-label') as HTMLElement;
const debugTargetFinger = document.getElementById('debug-target-finger') as HTMLElement;
const debugTargetVy = document.getElementById('debug-target-vy') as HTMLElement;
const debugMaxOtherVy = document.getElementById('debug-max-other-vy') as HTMLElement;
const debugRatio = document.getElementById('debug-ratio') as HTMLElement;
const debugLastResult = document.getElementById('debug-last-result') as HTMLElement;

// シーケンス進行パネル UI 要素
const seqProgress = document.getElementById('seq-progress') as HTMLElement;
const seqTargetFinger = document.getElementById('seq-target-finger') as HTMLElement;
const seqNextFinger = document.getElementById('seq-next-finger') as HTMLElement;

const tracker = new HandTracker();
const tapDetector = new TapDetector();
const pianoSynth = new PianoSynth();
const sequencer = new SongSequencer();
const positionManager = new VirtualPositionManager('C4', 'C4');
const filterMap = new Map<string, OneEuroFilter3D>();

// 英語指名マッピング定数
const FINGER_ENGLISH_NAMES: Record<number, string> = {
  4: 'Thumb',
  8: 'Index',
  12: 'Middle',
  16: 'Ring',
  20: 'Pinky',
};

/**
 * 指名・音階の英語フォーマット生成 (例: "Right Middle (E4)")
 */
function formatTargetFingerLabel(target: TargetFinger, note: { pitch: string }): string {
  const eng = FINGER_ENGLISH_NAMES[target.tipIndex] ?? target.name;
  return `${target.handedness} ${eng} (${note.pitch})`;
}

/**
 * 演奏シーケンス進行UIの更新 (進捗・現在指定指・次回予告指)
 */
function updateSequenceUI(): void {
  if (!seqProgress || !seqTargetFinger || !seqNextFinger) return;

  const currentIdx = sequencer.getCurrentIndex();
  const totalNotes = sequencer.getTotalNotes();
  seqProgress.textContent = `Note ${currentIdx + 1} / ${totalNotes}`;

  const currentNote = sequencer.getCurrentNote();
  seqTargetFinger.textContent = formatTargetFingerLabel(currentTarget, currentNote);

  const nextNote = sequencer.getNextNote();
  if (nextNote) {
    const nextTarget = RIGHT_HAND_FIXED_FINGERS[nextNote.pitch] ?? currentTarget;
    seqNextFinger.textContent = formatTargetFingerLabel(nextTarget, nextNote);
  } else {
    seqNextFinger.textContent = '-';
  }
}

// 係数 K スライダーの動的バインド
if (kSlider && kLabel) {
  kSlider.value = tapDetector.getRelativeVelocityRatio().toFixed(1);
  kLabel.textContent = `K: ${kSlider.value}`;

  kSlider.addEventListener('input', () => {
    const val = parseFloat(kSlider.value);
    tapDetector.setRelativeVelocityRatio(val);
    kLabel.textContent = `K: ${val.toFixed(1)}`;
  });
}

// 仮想ポジション管理により動的に決定される現在の打鍵監視対象指 (右手限定メリーさんの羊)
let currentTarget: TargetFinger = positionManager.assignTargetFinger(sequencer.getCurrentNote());
updateSequenceUI();

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

// 見切れ・画面外復帰検知用スロット管理
let lastDetectedSlots = new Set<'Left' | 'Right'>();

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

    // カメラ起動完了: 半透明プレビューに切り替え、手首キャリブレーション待機
    startOverlay.classList.add('preview');
    cameraBtn.style.display = 'none';
    countdownBtn.style.display = 'block';
    countdownBtn.textContent = 'スタート';

    tracker.resetCalibration();
    tracker.setPlaying(false);
    lastDetectedSlots.clear();

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
  tracker.setPlaying(true);
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

      // 両手10本の指先トラッキング
      const rawHands = tracker.detect(videoElement, now);

      // 見切れ・画面外からの復帰ガード（フィルターステートリセット & 初回判定スキップ）
      const currentDetectedSlots = new Set<'Left' | 'Right'>(rawHands.map((h) => h.handedness as 'Left' | 'Right'));
      for (const slot of ['Left', 'Right'] as const) {
        const isPresent = currentDetectedSlots.has(slot);
        const wasPresent = lastDetectedSlots.has(slot);

        if (isPresent && !wasPresent) {
          // 該当スロットの全指の OneEuroFilter3D をリセットして現在位置で再同期
          for (const tip of [4, 8, 12, 16, 20]) {
            const key = `${slot}_${tip}`;
            filterMap.get(key)?.reset();
          }
          // TapDetector の状態を一括リセットし、復帰初フレームの速度計算・打鍵判定を強制スキップ
          tapDetector.resetSlot(slot);
        }
      }
      lastDetectedSlots = currentDetectedSlots;

      // 高速追従平滑化座標および打鍵検知
      const smoothedHands = processHandsAndDetectTaps(rawHands, now);

      // Canvasにターゲットのみ強調描画（テキストUIは完全非表示）
      renderTracking(smoothedHands, now);

      // 相対速度ガード デバッグ情報およびシーケンスUIのリアルタイム更新
      updateDebugGateUI();
      updateSequenceUI();
    }

    requestAnimationFrame(loop);
  };

  requestAnimationFrame(loop);
}

/**
 * 相対速度ガード デバッグ情報のリアルタイム更新
 */
function updateDebugGateUI() {
  if (!debugTargetFinger) return;

  const currentNote = sequencer.getCurrentNote();
  debugTargetFinger.textContent = formatTargetFingerLabel(currentTarget, currentNote);

  const liveSpeed = tapDetector.getLiveSpeedInfo(currentTarget.handedness, currentTarget.tipIndex);
  debugTargetVy.textContent = liveSpeed.targetVy.toFixed(2);
  debugMaxOtherVy.textContent = liveSpeed.maxOtherVy.toFixed(2);
  debugRatio.textContent = liveSpeed.maxOtherVy > 0.0001
    ? (liveSpeed.targetVy / liveSpeed.maxOtherVy).toFixed(2)
    : (liveSpeed.targetVy > 0 ? '∞' : '0.00');

  const gateResult = tapDetector.getLatestGateResult();
  if (gateResult.lastResult === 'PASS: 打鍵発火') {
    debugLastResult.textContent = 'PASS: 打鍵発火';
    debugLastResult.className = 'debug-value debug-result-pass';
  } else if (gateResult.lastResult === 'BLOCKED: 共連れ抑止') {
    debugLastResult.textContent = 'BLOCKED: 共連れ抑止';
    debugLastResult.className = 'debug-value debug-result-blocked';
  } else {
    debugLastResult.textContent = 'WAITING';
    debugLastResult.className = 'debug-value debug-result-waiting';
  }
}

/**
 * 指先座標を平滑化し、打鍵を検知
 * 左手・右手それぞれの打鍵不発を防ぐため、指定指に加えて同手の主要指もフォールバック監視
 */
function processHandsAndDetectTaps(hands: HandData[], timestamp: number): HandData[] {
  let noteTriggeredInThisFrame = false;

  return hands.map((hand) => {
    // HandTrackerの手首ID固定追跡（初期キャリブレーション＋手首間ユークリッド距離マッチング）による安定した左右スロットを使用
    const resolvedHandedness: 'Left' | 'Right' = hand.handedness === 'Left' ? 'Left' : 'Right';
    const isTargetHand = resolvedHandedness === currentTarget.handedness;

    // 1. 同手全指先の座標を平滑化
    const smoothedFingertips: FingertipCoord[] = hand.fingertips.map((tip) => {
      const key = `${resolvedHandedness}_${tip.tipIndex}`;

      // 各指先ごとの独立した 1 Euro Filter 3D インスタンス
      let filter = filterMap.get(key);
      if (!filter) {
        filter = new OneEuroFilter3D({ minCutoff: 0.8, beta: 4.0, dCutoff: 1.0 });
        filterMap.set(key, filter);
      }

      // 座標平滑化 (急な振り下ろしにも遅延なく追従)
      const smoothed = filter.filter({ x: tip.x, y: tip.y, z: tip.z }, timestamp);
      return {
        tipIndex: tip.tipIndex,
        name: tip.name,
        x: smoothed.x,
        y: smoothed.y,
        z: smoothed.z,
      };
    });

    // 2. 打鍵判定エンジンに同手全指の座標を同期（他指との相対速度比較のため全指の速度を一括更新）
    tapDetector.updateHandFingertips(resolvedHandedness, smoothedFingertips, timestamp);

    // 3. 演奏中かつ右手の打鍵判定（右手単独テスト）
    for (const tip of smoothedFingertips) {
      const key = `${resolvedHandedness}_${tip.tipIndex}`;
      const isTargetFinger = isTargetHand && tip.tipIndex === currentTarget.tipIndex;

      // 右手単独演奏テスト: 右手の指について打鍵判定（共連れ判定ログ記録も含む）
      const canEvaluateTap =
        isPlaying &&
        !noteTriggeredInThisFrame &&
        resolvedHandedness === 'Right';

      if (canEvaluateTap) {
        const tapEvent: TapEvent | null = tapDetector.processFingertip(
          resolvedHandedness,
          tip.tipIndex,
          tip.name,
          tip.x,
          tip.y,
          tip.z,
          timestamp
        );

        // 指定されたターゲット指で正しく打鍵（PASS）された場合のみ発音・進行
        if (tapEvent && isTargetFinger) {
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
            x: tip.x,
            y: tip.y,
            startTime: timestamp,
            duration: 260,
            velocity: tapEvent.velocity,
          });

          // 打鍵直後フラッシュ用タイムスタンプ記憶
          recentTapMap.set(key, timestamp);

          // シーケンサーを1音前進
          const { nextNote } = sequencer.advance();

          // 次のターゲット指を決定 (右手固定ポジション)
          currentTarget = positionManager.assignTargetFinger(nextNote);

          // シーケンス進行UIを即座に更新
          updateSequenceUI();
        }
      }
    }

    return {
      ...hand,
      handedness: resolvedHandedness,
      fingertips: smoothedFingertips,
    };
  });
}

/**
 * Canvas描画: targetFinger のみを白黒丸マークで強調表示し、打鍵時に波紋フィードバック
 * テキストUIは一切描画せず、純粋な視覚フィードバックのみを提供
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
          // 打鍵成功瞬間の高輝度白フラッシュ
          canvasCtx.beginPath();
          canvasCtx.arc(px, py, 18, 0, 2 * Math.PI);
          canvasCtx.fillStyle = '#ffffff';
          canvasCtx.fill();
          canvasCtx.lineWidth = 3;
          canvasCtx.strokeStyle = '#000000';
          canvasCtx.stroke();
        } else {
          // 外側の黒枠白ターゲットリング
          canvasCtx.beginPath();
          canvasCtx.arc(px, py, 16, 0, 2 * Math.PI);
          canvasCtx.lineWidth = 3;
          canvasCtx.strokeStyle = '#000000';
          canvasCtx.stroke();

          canvasCtx.beginPath();
          canvasCtx.arc(px, py, 16, 0, 2 * Math.PI);
          canvasCtx.lineWidth = 1.8;
          canvasCtx.strokeStyle = '#ffffff';
          canvasCtx.stroke();

          // 内側の白丸
          canvasCtx.beginPath();
          canvasCtx.arc(px, py, 7, 0, 2 * Math.PI);
          canvasCtx.fillStyle = '#ffffff';
          canvasCtx.fill();
          canvasCtx.lineWidth = 2;
          canvasCtx.strokeStyle = '#000000';
          canvasCtx.stroke();

          // 中心黒ドット
          canvasCtx.beginPath();
          canvasCtx.arc(px, py, 2, 0, 2 * Math.PI);
          canvasCtx.fillStyle = '#000000';
          canvasCtx.fill();
        }
      }
    });
  });

  // テキストUIは完全削除（renderTargetHUDなし）
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
