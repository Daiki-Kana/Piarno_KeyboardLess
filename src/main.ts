import { HandTracker, HandData, FingertipCoord } from "./handTracker";
import { OneEuroFilter3D } from "./oneEuroFilter";
import { PianoSynth } from "./pianoSynth";
import { SongSequencer } from "./songSequencer";
import { VirtualPositionManager, TargetFinger } from "./virtualPositionManager";
import { FeatureLogger } from "./featureLogger";
import { TcnTapDetector } from "./tcnTapDetector";
import { checkAndTriggerTcnTap } from "./checkAndTriggerTcnTap";

// DOM 要素
const videoElement = document.getElementById("webcam") as HTMLVideoElement;
const canvasElement = document.getElementById(
  "output-canvas",
) as HTMLCanvasElement;
const canvasCtx = canvasElement.getContext("2d")!;
const startOverlay = document.getElementById("start-overlay") as HTMLElement;
const cameraBtn = document.getElementById("camera-btn") as HTMLButtonElement;
const countdownBtn = document.getElementById(
  "countdown-btn",
) as HTMLButtonElement;
const countdownDisplay = document.getElementById(
  "countdown-display",
) as HTMLElement;

// データ収集UI要素
const recBtn = document.getElementById("rec-btn") as HTMLButtonElement;
const hitBtn = document.getElementById("hit-btn") as HTMLButtonElement;
const exportBtn = document.getElementById("export-btn") as HTMLButtonElement;
const loggerStatusIndicator = document.getElementById(
  "logger-status-indicator",
) as HTMLElement;
const statFrames = document.getElementById("stat-frames") as HTMLElement;
const statHits = document.getElementById("stat-hits") as HTMLElement;
const statHand = document.getElementById("stat-hand") as HTMLElement;

// 推論デバッグHUD要素 (白黒リアルタイム表示 & リアルタイム感度調整)
const hudTcnReady = document.getElementById("hud-tcn-ready") as HTMLElement;
const hudProb = document.getElementById("hud-prob") as HTMLElement;
const hudDecel = document.getElementById("hud-decel") as HTMLElement;
const hudTapCount = document.getElementById("hud-tap-count") as HTMLElement;
const hudToggleBtn = document.getElementById("hud-toggle-btn") as HTMLButtonElement;
const hudPanel = document.getElementById("hud-panel") as HTMLElement;
const sliderProb = document.getElementById("slider-prob") as HTMLInputElement;
const valProb = document.getElementById("val-prob") as HTMLElement;
const sliderDecel = document.getElementById("slider-decel") as HTMLInputElement;
const valDecel = document.getElementById("val-decel") as HTMLElement;
const sliderCooldown = document.getElementById("slider-cooldown") as HTMLInputElement;
const valCooldown = document.getElementById("val-cooldown") as HTMLElement;
const hudLogsList = document.getElementById("hud-logs-list") as HTMLElement;

let lastRenderedTapCount = -1;

function updateDebugHUD(): void {
  if (!hudTcnReady) return;
  const status = tcnDetector.getDebugStatus();
  if (status.errorMessage) {
    hudTcnReady.textContent = `TCN Error: ${status.errorMessage}`;
    hudTcnReady.style.textDecoration = 'underline';
  } else {
    hudTcnReady.textContent = `TCN Ready: ${status.isReady}`;
    hudTcnReady.style.textDecoration = '';
  }
  hudProb.textContent = `Prob: ${(status.prob * 100).toFixed(1)}%`;
  hudDecel.textContent = `Decel: ${status.decel.toFixed(2)}`;
  hudTapCount.textContent = `Tap Count: ${status.tapCount}`;

  // 打鍵検知があった場合のみ直近打鍵ログリストを軽量更新（無駄な毎フレーム再描画を回避）
  if (hudLogsList && status.tapCount !== lastRenderedTapCount) {
    lastRenderedTapCount = status.tapCount;
    if (status.recentLogs.length === 0) {
      hudLogsList.innerHTML = '<div class="hud-log-item empty">- 打鍵待機中 -</div>';
    } else {
      hudLogsList.innerHTML = status.recentLogs
        .map(
          (log, idx) =>
            `<div class="hud-log-item">#${status.tapCount - idx} [${log.timeStr}] Prob: ${(log.prob * 100).toFixed(1)}% | Decel: ${log.decel.toFixed(2)} | Vel: ${log.velocity.toFixed(2)}</div>`
        )
        .join('');
    }
  }
}

const tracker = new HandTracker();
export const tcnDetector = new TcnTapDetector();
export const pianoSynth = new PianoSynth();
export const sequencer = new SongSequencer();
export const positionManager = new VirtualPositionManager("C4", "C4");
const filterMap = new Map<string, OneEuroFilter3D>();

// 1D-TCN用 特徴量ロガーインスタンス（UI表示コールバックを接続）
const featureLogger = new FeatureLogger((status) => {
  statFrames.textContent = status.frameCount.toString();
  statHits.textContent = status.hitCount.toString();
  statHand.textContent = status.isTracked ? status.targetHand : "-";
  exportBtn.disabled = status.frameCount === 0;
});

// 仮想ポジション管理により動的に決定される現在の打鍵監視対象指 (targetFinger)
export let currentTarget: TargetFinger = positionManager.assignTargetFinger(
  sequencer.getCurrentNote(),
);

export function setCurrentTarget(target: TargetFinger): void {
  currentTarget = target;
}

// 打鍵波紋エフェクト情報
interface VisualTapRipple {
  x: number; // 正規化座標 (0 ~ 1)
  y: number;
  startTime: number;
  duration: number;
  velocity: number;
}
export const activeRipples: VisualTapRipple[] = [];

// 直近の打鍵時刻を保持（指先フラッシュ表示用）
export const recentTapMap = new Map<string, number>();

let isCameraRunning = false;
let isStartingCamera = false;
export let isPlaying = false;
let mediaStream: MediaStream | null = null;
let lastTimestamp = -1;

/**
 * 初期化処理
 */
async function initializeApp() {
  try {
    cameraBtn.disabled = true;

    // 1. MediaPipe 初期化
    cameraBtn.textContent = "MediaPipe初期化中...";
    console.log("[Init] 1. MediaPipe初期化開始...");
    try {
      await tracker.init();
      console.log("[Init] 1. MediaPipe初期化完了");
    } catch (mpErr) {
      console.error("[Init] MediaPipe初期化失敗:", mpErr);
      cameraBtn.textContent = `MediaPipe失敗: ${mpErr instanceof Error ? mpErr.message : String(mpErr)}`;
      return;
    }

    // 2. 1D-TCN モデル初期化（タイムアウト保護付き: 30秒）
    cameraBtn.textContent = "TCNモデル初期化中...";
    console.log("[Init] 2. TCNモデル初期化開始...");
    try {
      await Promise.race([
        tcnDetector.init(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("初期化タイムアウト (30秒経過)")), 30000)
        ),
      ]);
      console.log("[Init] 2. TCNモデル初期化完了");
    } catch (tcnErr) {
      console.error("[Init] TCNモデル初期化例外:", tcnErr);
    }

    updateDebugHUD();
    const status = tcnDetector.getDebugStatus();
    if (status.errorMessage) {
      console.warn("TCNモデル初期化でエラー発生:", status.errorMessage);
      cameraBtn.textContent = "カメラを開始 (TCN未完了)";
    } else {
      cameraBtn.textContent = "カメラを開始";
    }
    cameraBtn.disabled = false;
  } catch (error) {
    console.error("初期化失敗:", error);
    cameraBtn.textContent = "初期化に失敗しました";
    updateDebugHUD();
  }
}

/**
 * 1. Webカメラの起動と構え確認プレビューの表示
 */
async function startCamera() {
  if (isCameraRunning || isStartingCamera) return;
  isStartingCamera = true;

  try {
    cameraBtn.textContent = "カメラ起動中...";
    cameraBtn.disabled = true;

    // Web Audio API のオーディオコンテキストをユーザー操作契機で確実に起動
    await pianoSynth.ensureContext();

    // iOS Safari 必須属性
    videoElement.setAttribute("playsinline", "true");
    videoElement.setAttribute("webkit-playsinline", "true");
    videoElement.muted = true;

    // 横画面を前提としたカメラ解像度の取得 (640x480 / 30fps)
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
    } catch (constraintErr) {
      console.warn(
        "カメラ制約取得失敗。基本制約で再試行します:",
        constraintErr,
      );
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });
    }

    videoElement.srcObject = mediaStream;

    // loadeddata を待機して再生と解像度確定を保証
    await new Promise<void>((resolve) => {
      const onReady = async () => {
        videoElement.removeEventListener("loadeddata", onReady);
        try {
          await videoElement.play();
        } catch (playErr) {
          console.warn("再生待機エラー:", playErr);
        }
        resolve();
      };
      if (videoElement.readyState >= 2 && videoElement.videoWidth > 0) {
        onReady();
      } else {
        videoElement.addEventListener("loadeddata", onReady);
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
    startOverlay.classList.add("preview");
    cameraBtn.style.display = "none";
    countdownBtn.style.display = "block";
    countdownBtn.textContent = "スタート";

    lastTimestamp = -1;
    startTrackingLoop();
  } catch (err) {
    console.error("Webカメラ取得失敗:", err);
    cameraBtn.textContent = "カメラの取得に失敗しました";
    cameraBtn.disabled = false;
    isStartingCamera = false;
    alert("カメラへのアクセスを許可してください。");
  }
}

/**
 * 2. ボタン押下によってカウントダウンを開始し、演奏へ突入
 */
async function startCountdown() {
  if (!isCameraRunning || isPlaying) return;

  countdownBtn.style.display = "none";
  countdownDisplay.classList.add("show");

  const countdownSequence = ["3", "2", "1", "START!"];
  for (const text of countdownSequence) {
    countdownDisplay.textContent = text;
    await new Promise((resolve) =>
      setTimeout(resolve, text === "START!" ? 350 : 850),
    );
  }

  // カウントダウン完了: オーバーレイを完全非表示にし、演奏を開始
  startOverlay.classList.add("hidden");
  countdownDisplay.classList.remove("show");
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

      // 両手10本の指先トラッキング
      const rawHands = tracker.detect(videoElement, now);

      // 人差し指局所相対運動特徴量の記録（RECオフ時は即座にリターンしオーバーヘッドなし）
      featureLogger.processFrame(rawHands, now);

      // 高速追従平滑化座標の算出
      const smoothedHands = smoothHandFingertips(rawHands, now);

      // 学習データに基づく 1D-TCN モデル推論による人差し指打鍵検知（平滑化座標 smoothedHands を渡してノイズ排除）
      if (isCameraRunning) {
        checkAndTriggerTcnTap(smoothedHands, now);
      }

      // Canvasにターゲットのみ強調描画（テキストUIは完全非表示）
      renderTracking(smoothedHands, now);

      // 白黒ミニマル推論デバッグHUDのリアルタイム更新
      updateDebugHUD();
    }

    requestAnimationFrame(loop);
  };

  requestAnimationFrame(loop);
}

/**
 * 指先座標の平滑化処理 (1 Euro Filter 3D)
 */
function smoothHandFingertips(
  hands: HandData[],
  timestamp: number,
): HandData[] {
  return hands.map((hand) => {
    // 横画面空間位置の判定 (raw camera X > 0.46 は鏡像で画面左側 = 左手領域)
    const isLeftZone = hand.centerX > 0.46 || hand.handedness === "Left";
    const resolvedHandedness: "Left" | "Right" = isLeftZone ? "Left" : "Right";

    // 全ランドマークの平滑化 (One Euro Filter 3D)
    // tcnTapDetector (Wrist:0, MCP:5, Tip:8) に渡す際のエッジ吸着ノイズ・座標跳躍を抑止
    const smoothedAllLandmarks = hand.allLandmarks.map((pt, idx) => {
      const key = `${resolvedHandedness}_lm_${idx}`;
      let filter = filterMap.get(key);
      if (!filter) {
        filter = new OneEuroFilter3D({
          minCutoff: 0.8,
          beta: 4.0,
          dCutoff: 1.0,
        });
        filterMap.set(key, filter);
      }
      return filter.filter(pt, timestamp);
    });

    const smoothedFingertips: FingertipCoord[] = hand.fingertips.map((tip) => {
      const key = `${resolvedHandedness}_${tip.tipIndex}`;

      // 各指先ごとの独立した 1 Euro Filter 3D インスタンス
      let filter = filterMap.get(key);
      if (!filter) {
        filter = new OneEuroFilter3D({
          minCutoff: 0.8,
          beta: 4.0,
          dCutoff: 1.0,
        });
        filterMap.set(key, filter);
      }

      // 座標平滑化 (急な振り下ろしにも遅延なく追従)
      const smoothed = filter.filter(
        { x: tip.x, y: tip.y, z: tip.z },
        timestamp,
      );

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
      allLandmarks: smoothedAllLandmarks,
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
    const currentRadius =
      baseRadius +
      (maxRadius - baseRadius) * Math.sin((progress * Math.PI) / 2);
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

      // 人差し指のみをターゲットリング強調表示
      const isTarget = tip.tipIndex === 8;

      const key = `${hand.handedness}_${tip.tipIndex}`;
      const lastTapTime = recentTapMap.get(key) ?? -9999;
      const isRecentlyTapped = currentTimestamp - lastTapTime < 120;

      if (isTarget) {
        if (isRecentlyTapped) {
          // 打鍵成功瞬間の高輝度白フラッシュ
          canvasCtx.beginPath();
          canvasCtx.arc(px, py, 18, 0, 2 * Math.PI);
          canvasCtx.fillStyle = "#ffffff";
          canvasCtx.fill();
          canvasCtx.lineWidth = 3;
          canvasCtx.strokeStyle = "#000000";
          canvasCtx.stroke();
        } else {
          // 外側の黒枠白ターゲットリング
          canvasCtx.beginPath();
          canvasCtx.arc(px, py, 16, 0, 2 * Math.PI);
          canvasCtx.lineWidth = 3;
          canvasCtx.strokeStyle = "#000000";
          canvasCtx.stroke();

          canvasCtx.beginPath();
          canvasCtx.arc(px, py, 16, 0, 2 * Math.PI);
          canvasCtx.lineWidth = 1.8;
          canvasCtx.strokeStyle = "#ffffff";
          canvasCtx.stroke();

          // 内側の白丸
          canvasCtx.beginPath();
          canvasCtx.arc(px, py, 7, 0, 2 * Math.PI);
          canvasCtx.fillStyle = "#ffffff";
          canvasCtx.fill();
          canvasCtx.lineWidth = 2;
          canvasCtx.strokeStyle = "#000000";
          canvasCtx.stroke();

          // 中心黒ドット
          canvasCtx.beginPath();
          canvasCtx.arc(px, py, 2, 0, 2 * Math.PI);
          canvasCtx.fillStyle = "#000000";
          canvasCtx.fill();
        }
      }
    });
  });

  // テキストUIは完全削除（renderTargetHUDなし）
}

// イベントリスナー
cameraBtn.addEventListener("click", startCamera);
countdownBtn.addEventListener("click", startCountdown);

// --- データ収集UIのイベント制御 ---

// RECトグル
recBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const isRec = featureLogger.toggleRecording();
  if (isRec) {
    recBtn.classList.add("recording");
    recBtn.textContent = "■ STOP";
    loggerStatusIndicator.textContent = "REC";
    loggerStatusIndicator.classList.add("recording");
  } else {
    recBtn.classList.remove("recording");
    recBtn.textContent = "REC";
    loggerStatusIndicator.textContent = "IDLE";
    loggerStatusIndicator.classList.remove("recording");
  }
});

// JSON保存
exportBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  featureLogger.exportJSON();
});

// HIT操作の共通ハンドラ (Spaceキー / HITボタン / 画面タップ)
const activeHitPointers = new Set<number>();

const activateHit = () => {
  featureLogger.setHit(true);
  hitBtn.classList.add("active");
};

const deactivateHit = () => {
  featureLogger.setHit(false);
  hitBtn.classList.remove("active");
};

// HITボタン直接操作
hitBtn.addEventListener("pointerdown", (e) => {
  e.stopPropagation();
  try {
    hitBtn.setPointerCapture(e.pointerId);
  } catch {}
  activateHit();
});
hitBtn.addEventListener("pointerup", (e) => {
  e.stopPropagation();
  deactivateHit();
});
hitBtn.addEventListener("pointercancel", (e) => {
  e.stopPropagation();
  deactivateHit();
});

// 画面タップによるHIT操作（他ボタン操作時やHUD操作時は除外）
window.addEventListener("pointerdown", (e) => {
  pianoSynth.ensureContext();

  const target = e.target as HTMLElement | null;
  if (
    target &&
    (target.closest("button") ||
      target.closest(".logger-panel") ||
      target.closest(".debug-hud"))
  ) {
    return;
  }

  activeHitPointers.add(e.pointerId);
  activateHit();
});

// --- デバッグHUD 調整パネルおよびスライダー制御 ---

// HUD パネル開閉トグル
if (hudToggleBtn && hudPanel) {
  hudToggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isHidden = hudPanel.classList.toggle("hidden");
    hudToggleBtn.textContent = isHidden ? "調整 ▼" : "閉じる ▲";
  });
}

// TCN 確率閾値スライダー
if (sliderProb && valProb) {
  sliderProb.addEventListener("input", (e) => {
    e.stopPropagation();
    const val = parseFloat(sliderProb.value);
    valProb.textContent = val.toFixed(2);
    tcnDetector.setMinProb(val);
  });
}

// 減速閾値スライダー
if (sliderDecel && valDecel) {
  sliderDecel.addEventListener("input", (e) => {
    e.stopPropagation();
    const val = parseFloat(sliderDecel.value);
    valDecel.textContent = val <= 0.001 ? "0.00 (OFF)" : val.toFixed(2);
    tcnDetector.setMinDecel(val);
  });
}

// クールダウンスライダー
if (sliderCooldown && valCooldown) {
  sliderCooldown.addEventListener("input", (e) => {
    e.stopPropagation();
    const val = parseInt(sliderCooldown.value, 10);
    valCooldown.textContent = `${val}ms`;
    tcnDetector.setCooldownMs(val);
  });
}

window.addEventListener("pointerup", (e) => {
  if (activeHitPointers.has(e.pointerId)) {
    activeHitPointers.delete(e.pointerId);
    if (activeHitPointers.size === 0) {
      deactivateHit();
    }
  }
});

window.addEventListener("pointercancel", (e) => {
  if (activeHitPointers.has(e.pointerId)) {
    activeHitPointers.delete(e.pointerId);
    if (activeHitPointers.size === 0) {
      deactivateHit();
    }
  }
});

// Spaceキー操作（押下中 HIT、離すと解除）
window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !e.repeat) {
    e.preventDefault();
    activateHit();
  }
});

window.addEventListener("keyup", (e) => {
  if (e.code === "Space") {
    e.preventDefault();
    deactivateHit();
  }
});

// アプリ開始
initializeApp();
