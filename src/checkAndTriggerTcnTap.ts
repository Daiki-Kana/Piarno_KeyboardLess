import { HandData } from "./handTracker";
import {
  tcnDetector,
  sequencer,
  pianoSynth,
  activeRipples,
  recentTapMap,
  isPlaying,
  setCurrentTarget,
  positionManager,
} from "./main";

/**
 * 学習済み 1D-TCN モデルを用いた人差し指打鍵検知および発音処理
 */
export async function checkAndTriggerTcnTap(
  smoothedHands: HandData[],
  timestamp: number,
): Promise<void> {
  // Step 1: 生座標のノイズ・座標跳躍スパイクを排除するため、
  // 1 Euro Filter平滑化済みの smoothedHands を推論エンジンへ渡す
  const tapEvent = await tcnDetector.processFrame(smoothedHands, timestamp);
  if (!tapEvent) return;

  // 現在の音符を即座に発音 (和音コード指定時は重厚なピアノ伴奏、単音時はメロディ)
  const currentNote = sequencer.getCurrentNote();
  if (currentNote.chord && currentNote.chord.length > 0) {
    pianoSynth.playChord(currentNote.chord as number[], tapEvent.velocity);
  } else {
    pianoSynth.playNote(currentNote.frequency, tapEvent.velocity);
  }

  console.log(
    `[1D-TCN 打鍵発音成功] ${tapEvent.handedness}手 ${tapEvent.name} -> ` +
      `♪ ${currentNote.solfege}(${currentNote.pitch}, ${currentNote.frequency.toFixed(1)}Hz, vel: ${tapEvent.velocity.toFixed(2)})`,
  );

  // 波紋描画位置（平滑化座標の人差し指を取得）
  const targetHand =
    smoothedHands.find((h) => h.handedness === tapEvent.handedness) ??
    smoothedHands[0];
  const indexTip = targetHand?.fingertips.find((f) => f.tipIndex === 8);
  const rippleX = indexTip ? indexTip.x : tapEvent.x;
  const rippleY = indexTip ? indexTip.y : tapEvent.y;

  activeRipples.push({
    x: rippleX,
    y: rippleY,
    startTime: timestamp,
    duration: 260,
    velocity: tapEvent.velocity,
  });

  // 打鍵直後フラッシュ用タイムスタンプ記憶
  const key = `${tapEvent.handedness}_8`;
  recentTapMap.set(key, timestamp);

  // 演奏中の場合のみシーケンサーを1音前進（プレビュー時はその場で音出しテスト）
  if (isPlaying) {
    const { nextNote } = sequencer.advance();
    // 次のターゲット指を決定（人差し指単体検証中のため参考ログとして保持）
    const target = positionManager.assignTargetFinger(nextNote);
    setCurrentTarget(target);
    console.debug(
      `[Next target reference] ${target.handedness} ${target.tipIndex}`,
    );
  }
}
