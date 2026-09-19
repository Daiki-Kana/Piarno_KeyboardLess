import { HandTracker, HandData, FingertipCoord } from './handTracker';
import { OneEuroFilter3D } from './oneEuroFilter';
import { TapDetector, TapEvent } from './tapDetector';
import { PianoSynth } from './pianoSynth';
import { SongSequencer } from './songSequencer';
import { VirtualPositionManager, TargetFinger, RIGHT_HAND_FIXED_FINGERS } from './virtualPositionManager';
import { HologramEffectManager } from './hologramEffect';

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
const hologramEffect = new HologramEffectManager();
const filterMap = new Map<string, OneEuroFilter3D>();
/**
 * 各指の骨格キネマティクス設定
 * 机面接地オクルージョン時に、空中の健全な手前関節（PIP → DIP）から指先（TIP）位置を幾何学的に復元
 */
interface FingerKinematics {
  tipIndex: number;
  dipIndex: number; // 親指の場合は IP(3)
  pipIndex: number; // 親指の場合は MCP(2)
  boneRatio: number; // DIP-TIP と PIP-DIP の骨長比率
  adjacentTips: number[]; // 隣接する指先インデックス
}

const FINGER_KINEMATICS: Record<number, FingerKinematics> = {
  4: { tipIndex: 4, dipIndex: 3, pipIndex: 2, boneRatio: 0.85, adjacentTips: [8] },
  8: { tipIndex: 8, dipIndex: 7, pipIndex: 6, boneRatio: 0.80, adjacentTips: [4, 12] },
  12: { tipIndex: 12, dipIndex: 11, pipIndex: 10, boneRatio: 0.80, adjacentTips: [8, 16] },
  16: { tipIndex: 16, dipIndex: 15, pipIndex: 14, boneRatio: 0.80, adjacentTips: [12, 20] },
  20: { tipIndex: 20, dipIndex: 19, pipIndex: 18, boneRatio: 0.80, adjacentTips: [16] },
};

// 接地インパクトロック管理（打鍵成立瞬間から40ms間、ターゲット指の座標を固定）
interface ImpactLockState {
  hand: 'Left' | 'Right';
  tipIndex: number;
  pos: { x: number; y: number; z: number };
  expiresAt: number;
}
let impactLock: ImpactLockState | null = null;

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
 * 現在の音符から、同じターゲット指が連続して何回打鍵されるか（残り回数）を算出
 * 1回: 水色 / 2回: 緑 / 3回以上: 黄色
 */
function getConsecutiveTapCount(): number {
  const currentIdx = sequencer.getCurrentIndex();
  const total = sequencer.getTotalNotes();
  let count = 1;

  for (let i = currentIdx + 1; i < total; i++) {
    const note = sequencer.getNoteAt(i);
    if (!note) break;
    const nextTarget = RIGHT_HAND_FIXED_FINGERS[note.pitch] ?? positionManager.assignTargetFinger(note);
    if (
      nextTarget &&
      nextTarget.handedness === currentTarget.handedness &&
      nextTarget.tipIndex === currentTarget.tipIndex
    ) {
      count++;
    } else {
      break;
    }
  }

  return count;
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
  let nextTarget: TargetFinger | null = null;
  if (nextNote) {
    nextTarget = RIGHT_HAND_FIXED_FINGERS[nextNote.pitch] ?? currentTarget;
    seqNextFinger.textContent = formatTargetFingerLabel(nextTarget, nextNote);
  } else {
    seqNextFinger.textContent = '-';
  }

  const consecutiveCount = getConsecutiveTapCount();

  // ホログラムマネージャーへターゲット指情報および連続打鍵回数を同期 (1回: 水色, 2回: 緑, 3回以上: 黄色)
  hologramEffect.setTargets(
    { fingerId: currentTarget.tipIndex, hand: currentTarget.handedness },
    nextTarget ? { fingerId: nextTarget.tipIndex, hand: nextTarget.handedness } : null,
    consecutiveCount
  );
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
    impactLock = null;

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

      // ホログラム演出のアニメーション状態更新
      hologramEffect.update(now);

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
 * 骨格幾何学（Kinematic Reconstruction）により机面接地時の隣指吸着・オクルージョンを完全排除
 */
function processHandsAndDetectTaps(hands: HandData[], timestamp: number): HandData[] {
  let noteTriggeredInThisFrame = false;

  return hands.map((hand) => {
    // HandTrackerの手首ID固定追跡による安定した左右スロットを使用
    const resolvedHandedness: 'Left' | 'Right' = hand.handedness === 'Left' ? 'Left' : 'Right';
    const isTargetHand = resolvedHandedness === currentTarget.handedness;

    // 手のひらの基準スケール（手首 0 と 中指付け根 9 のユークリッド距離）
    const wristPt = hand.allLandmarks[0];
    const middleMcpPt = hand.allLandmarks[9];
    const palmScale =
      wristPt && middleMcpPt
        ? Math.hypot(wristPt.x - middleMcpPt.x, wristPt.y - middleMcpPt.y)
        : 0.15;
    const proximityThreshold = Math.max(0.020, palmScale * 0.18);

    // 生ランドマーク配列（各指のPIP, DIP, TIP等の関節座標を直接参照）
    const rawLandmarks = hand.allLandmarks;

    // 1. 同手全指先の座標を骨格復元および平滑化
    const smoothedFingertips: FingertipCoord[] = hand.fingertips.map((tip) => {
      const key = `${resolvedHandedness}_${tip.tipIndex}`;
      const isTarget = isTargetHand && tip.tipIndex === currentTarget.tipIndex;
      const kinCfg = FINGER_KINEMATICS[tip.tipIndex];

      // 各指先ごとの独立した 1 Euro Filter 3D インスタンス (beta: 1.5 で衝突時ノイズ遮断)
      let filter = filterMap.get(key);
      if (!filter) {
        filter = new OneEuroFilter3D({ minCutoff: 0.8, beta: 1.5, dCutoff: 1.0 });
        filterMap.set(key, filter);
      }

      let inputX = tip.x;
      let inputY = tip.y;
      let inputZ = tip.z;

      // -------------------------------------------------------------
      // 【骨格幾何学チェック & フォワード・キネマティクス復元】
      // 机面接地で指先を見失っても、空中の健全な関節（PIP → DIP）から真の指先位置を再計算
      // -------------------------------------------------------------
      if (kinCfg && rawLandmarks[kinCfg.pipIndex] && rawLandmarks[kinCfg.dipIndex]) {
        const pip = rawLandmarks[kinCfg.pipIndex];
        const dip = rawLandmarks[kinCfg.dipIndex];

        // 手前の健全な骨ベクトル (PIP -> DIP)
        const vBoneX = dip.x - pip.x;
        const vBoneY = dip.y - pip.y;
        const lenBone = Math.hypot(vBoneX, vBoneY);

        // 指先ベクトル (DIP -> MediaPipe生TIP)
        const vTipX = inputX - dip.x;
        const vTipY = inputY - dip.y;
        const lenTip = Math.hypot(vTipX, vTipY);

        if (lenBone > 0.005 && lenTip > 0.001) {
          // コサイン類似度（骨の向きと指先の向きの成す角）
          const cosTheta = (vBoneX * vTipX + vBoneY * vTipY) / (lenBone * lenTip);

          // ターゲット指限定: 隣接指のTIP先端との異常接近判定
          let isSnappingToNeighbor = false;
          if (isTarget) {
            for (const adjIdx of kinCfg.adjacentTips) {
              const neighborTip = rawLandmarks[adjIdx];
              if (neighborTip) {
                const distToNeighbor = Math.hypot(inputX - neighborTip.x, inputY - neighborTip.y);
                if (distToNeighbor < proximityThreshold) {
                  isSnappingToNeighbor = true;
                  break;
                }
              }
            }
          }

          // 異常判定（隣指吸着、または角度の異常折れ曲がり cosTheta < 0.60、または極端な骨長異常）
          const isAngleDeviated = cosTheta < 0.60;
          const isLengthDistorted = lenTip / lenBone > 1.6 || lenTip / lenBone < 0.35;

          if (isSnappingToNeighbor || isAngleDeviated || isLengthDistorted) {
            // ★幾何学的復元（Kinematic Reconstruction）★
            // 空中の安定した骨の向き（PIP -> DIP）の延長線上に、正常な骨長比率で指先を再配置
            const uX = vBoneX / lenBone;
            const uY = vBoneY / lenBone;
            const expectedLen = lenBone * kinCfg.boneRatio;

            inputX = dip.x + uX * expectedLen;
            inputY = dip.y + uY * expectedLen;
            inputZ = dip.z + (dip.z - pip.z) * kinCfg.boneRatio;
          }
        }
      }

      // 1 Euro Filter 3D による平滑化
      let smoothed = filter.filter({ x: inputX, y: inputY, z: inputZ }, timestamp);

      // 接地インパクト時の短尺座標ロック (40ms: 打鍵成立瞬間の座標に完全固定)
      if (
        impactLock &&
        impactLock.hand === resolvedHandedness &&
        impactLock.tipIndex === tip.tipIndex &&
        timestamp < impactLock.expiresAt
      ) {
        smoothed = {
          x: impactLock.pos.x,
          y: impactLock.pos.y,
          z: impactLock.pos.z,
        };
      }

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

    // 3. 演奏中かつ右手の打鍵判定（ターゲット指1本のみに限定）
    for (const tip of smoothedFingertips) {
      const isTargetFinger = isTargetHand && tip.tipIndex === currentTarget.tipIndex;

      // ターゲット以外の指は打鍵判定を完全にスキップ（誤爆・他指吸着防止）
      if (!isTargetFinger) {
        continue;
      }

      const key = `${resolvedHandedness}_${tip.tipIndex}`;

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
        if (tapEvent) {
          noteTriggeredInThisFrame = true;

          // 接地インパクトロック（40ms間、この瞬間の座標に固定）
          impactLock = {
            hand: resolvedHandedness,
            tipIndex: tip.tipIndex,
            pos: { x: tip.x, y: tip.y, z: tip.z },
            expiresAt: timestamp + 40,
          };

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

          // ホログラムマネージャーへ打鍵イベントを通知
          hologramEffect.triggerTap(tip.tipIndex, { x: tip.x, y: tip.y });

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

    // Layer 5: 描画パイプラインへの平滑化座標同期
    // allLandmarks の指先ランドマーク（4, 8, 12, 16, 20）を平滑化・クランプ後座標で上書き
    const updatedAllLandmarks = hand.allLandmarks.map((lm) => ({ ...lm }));
    smoothedFingertips.forEach((tip) => {
      if (updatedAllLandmarks[tip.tipIndex]) {
        updatedAllLandmarks[tip.tipIndex] = { x: tip.x, y: tip.y, z: tip.z };
      }
    });

    return {
      ...hand,
      handedness: resolvedHandedness,
      fingertips: smoothedFingertips,
      allLandmarks: updatedAllLandmarks,
    };
  });
}

/**
 * Canvas描画: targetFinger のみを白黒丸マークで強調表示し、打鍵時に波紋フィードバック
 * テキストUIは一切描画せず、純粋な視覚フィードバックのみを提供
 */
function renderTracking(hands: HandData[], currentTimestamp: number) {
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

  // 各手のランドマークマップを生成しホログラム演出（水色/緑/黄色マーカー＆空中アーチ）を描画
  const landmarksMap = new Map<string, { x: number; y: number }[]>();
  hands.forEach((hand) => {
    landmarksMap.set(
      hand.handedness,
      hand.allLandmarks.map((lm) => ({ x: lm.x, y: lm.y }))
    );
  });
  hologramEffect.render(canvasCtx, landmarksMap);

  const width = canvasElement.width;
  const height = canvasElement.height;

  // ターゲット指のみ打鍵成功フラッシュ（100ms以内）を描画
  // ※指定されたターゲット指以外へのマーカー表示は一切行わない
  hands.forEach((hand) => {
    hand.fingertips.forEach((tip) => {
      const isTarget =
        hand.handedness === currentTarget.handedness && tip.tipIndex === currentTarget.tipIndex;

      if (isTarget) {
        const key = `${hand.handedness}_${tip.tipIndex}`;
        const lastTapTime = recentTapMap.get(key) ?? -9999;
        const isRecentlyTapped = currentTimestamp - lastTapTime < 100;

        if (isRecentlyTapped) {
          const px = tip.x * width;
          const py = tip.y * height;

          // 打鍵成功瞬間の高輝度白フラッシュ
          canvasCtx.save();
          canvasCtx.beginPath();
          canvasCtx.arc(px, py, 18, 0, 2 * Math.PI);
          canvasCtx.fillStyle = '#ffffff';
          canvasCtx.shadowColor = '#ffffff';
          canvasCtx.shadowBlur = 15;
          canvasCtx.fill();
          canvasCtx.restore();
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
