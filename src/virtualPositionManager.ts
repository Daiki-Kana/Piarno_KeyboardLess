/**
 * 両手10本対応: 仮想ポジション管理および動的指割り当て（Two-Hand Dynamic Finger Assigner）
 * 実際のピアノ演奏に即し、「左手（伴奏/低音）」と「右手（メロディ/主旋律）」の仮想ポジションを
 * 独立して自動スライド管理し、次に打鍵すべき最適な手と指（targetFinger）を動的に決定する。
 */

import { NoteInfo } from './songSequencer';

export type Handedness = 'Left' | 'Right';

export interface TargetFinger {
  hand: 'left' | 'right';
  handedness: Handedness;
  tipIndex: number;     // 4: 親指, 8: 人差指, 12: 中指, 16: 薬指, 20: 小指
  name: string;         // 例: "左手 小指", "右手 人差指"
  fingerNumber: number; // ピアノ運指番号: 1(親指) ~ 5(小指)
  finger: number;       // 0-based インデックス (0: 親指 ~ 4: 小指)
  orderIndex: number;   // 10本指の絶対物理位置: 0 (左小指) ~ 9 (右小指)
}

/** 左手5指の物理定義 (低音: 小指 -> 高音: 親指) */
export const LEFT_FINGERS: readonly TargetFinger[] = [
  { hand: 'left', handedness: 'Left', tipIndex: 20, name: '左手 小指', fingerNumber: 5, finger: 4, orderIndex: 0 },
  { hand: 'left', handedness: 'Left', tipIndex: 16, name: '左手 薬指', fingerNumber: 4, finger: 3, orderIndex: 1 },
  { hand: 'left', handedness: 'Left', tipIndex: 12, name: '左手 中指', fingerNumber: 3, finger: 2, orderIndex: 2 },
  { hand: 'left', handedness: 'Left', tipIndex: 8,  name: '左手 人差指', fingerNumber: 2, finger: 1, orderIndex: 3 },
  { hand: 'left', handedness: 'Left', tipIndex: 4,  name: '左手 親指', fingerNumber: 1, finger: 0, orderIndex: 4 },
] as const;

/** 右手5指の物理定義 (低音: 親指 -> 高音: 小指) */
export const RIGHT_FINGERS: readonly TargetFinger[] = [
  { hand: 'right', handedness: 'Right', tipIndex: 4,  name: '右手 親指', fingerNumber: 1, finger: 0, orderIndex: 5 },
  { hand: 'right', handedness: 'Right', tipIndex: 8,  name: '右手 人差指', fingerNumber: 2, finger: 1, orderIndex: 6 },
  { hand: 'right', handedness: 'Right', tipIndex: 12, name: '右手 中指', fingerNumber: 3, finger: 2, orderIndex: 7 },
  { hand: 'right', handedness: 'Right', tipIndex: 16, name: '右手 薬指', fingerNumber: 4, finger: 3, orderIndex: 8 },
  { hand: 'right', handedness: 'Right', tipIndex: 20, name: '右手 小指', fingerNumber: 5, finger: 4, orderIndex: 9 },
] as const;

/** 白鍵（ダイアトニック）音階の基準オフセット (C4 = 0) */
const DIATONIC_BASE_MAP: Record<string, number> = {
  C: 0,
  D: 1,
  E: 2,
  F: 3,
  G: 4,
  A: 5,
  B: 6,
};

const DIATONIC_NOTE_NAMES = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

/** ピッチ文字列（例: "C3", "C4", "G4"）をダイアトニック度数 (C4=0) に変換 */
export function pitchToDiatonic(pitch: string): number {
  const match = pitch.match(/^([A-G])(#|b)?(\d)$/);
  if (!match) return 0;
  const noteName = match[1];
  const octave = parseInt(match[3], 10);
  const baseOffset = DIATONIC_BASE_MAP[noteName] ?? 0;
  return (octave - 4) * 7 + baseOffset;
}

/** ダイアトニック度数からピッチ文字列（例: -7 -> "C3", 0 -> "C4"）へ逆変換 */
export function diatonicToPitch(diatonic: number): string {
  const octave = 4 + Math.floor(diatonic / 7);
  const mod = ((diatonic % 7) + 7) % 7;
  return `${DIATONIC_NOTE_NAMES[mod]}${octave}`;
}

export interface PositionStatus {
  leftBasePitch: string;
  leftCoverRange: string;   // 例: "C3 - G3"
  rightBasePitch: string;
  rightCoverRange: string; // 例: "C4 - G4"
  activeHand: Handedness;
  slideDescription: string;
}

export class VirtualPositionManager {
  // 左手小指が担当するダイアトニック度数 (初期: -7 = C3)
  private leftBaseDiatonic: number = -7;

  // 右手親指が担当するダイアトニック度数 (初期: 0 = C4)
  private rightBaseDiatonic: number = 0;

  // 直前の打鍵音・指定指
  private lastPitch: string | null = null;
  private lastFinger: TargetFinger | null = null;

  // 現在のステータス
  private status: PositionStatus = {
    leftBasePitch: 'C3',
    leftCoverRange: 'C3 - G3',
    rightBasePitch: 'C4',
    rightCoverRange: 'C4 - G4',
    activeHand: 'Right',
    slideDescription: '初期ホームポジション',
  };

  constructor(initialLeftBase: string = 'C4', initialRightBase: string = 'C4') {
    this.reset(initialLeftBase, initialRightBase);
  }

  /**
   * ホームポジションにリセット
   */
  public reset(initialLeftBase: string = 'C4', initialRightBase: string = 'C4'): void {
    this.leftBaseDiatonic = pitchToDiatonic(initialLeftBase);
    this.rightBaseDiatonic = pitchToDiatonic(initialRightBase);
    this.lastPitch = null;
    this.lastFinger = null;
    this.status = {
      leftBasePitch: initialLeftBase,
      leftCoverRange: `${initialLeftBase} - ${diatonicToPitch(this.leftBaseDiatonic + 4)}`,
      rightBasePitch: initialRightBase,
      rightCoverRange: `${initialRightBase} - ${diatonicToPitch(this.rightBaseDiatonic + 4)}`,
      activeHand: 'Right',
      slideDescription: 'ホームポジション (左手 C4-G4 / 右手 C4-G4)',
    };
  }

  /**
   * 現在の両手の仮想ポジションおよびスライド状況ステータスを取得
   */
  public getStatus(): PositionStatus {
    return this.status;
  }

  /**
   * 次に鳴らすべき音符を受け取り、最適な手と指（targetFinger）を動的に決定する
   */
  public assignTargetFinger(note: NoteInfo): TargetFinger {
    const targetDiatonic = pitchToDiatonic(note.pitch);

    // 1. 担当手の決定 (note.hand 指定があれば最優先、なければ C4(0) 以上は右手、C4未満は左手)
    const targetHand: Handedness =
      note.hand ?? (targetDiatonic >= 0 ? 'Right' : 'Left');

    // 2. 同音連打ヒューリスティック (同一手かつ同一音程なら同じ指を確実に再利用)
    if (
      this.lastPitch === note.pitch &&
      this.lastFinger !== null &&
      this.lastFinger.handedness === targetHand
    ) {
      this.status.activeHand = targetHand;
      this.status.slideDescription = `同音連打: ${this.lastFinger.name} を維持`;
      return this.lastFinger;
    }

    let chosenFinger: TargetFinger;

    if (targetHand === 'Right') {
      // ==========================================
      // 【右手】の動的指割り当て & ポジションスライド
      // カバー範囲: [rightBase, rightBase + 4]
      // ==========================================
      const rightMin = this.rightBaseDiatonic;
      const rightMax = this.rightBaseDiatonic + 4;

      if (targetDiatonic >= rightMin && targetDiatonic <= rightMax) {
        // 現在のカバー範囲内
        const offset = targetDiatonic - rightMin;
        const defaultFinger = RIGHT_FINGERS[offset];

        // 弱指（薬指・小指）保護: 下降進行で弱指が続く場合、中指優先へシフト
        if (
          this.lastFinger &&
          this.lastFinger.handedness === 'Right' &&
          this.lastFinger.fingerNumber >= 4 &&
          defaultFinger.fingerNumber >= 4 &&
          this.lastPitch !== null &&
          pitchToDiatonic(this.lastPitch) > targetDiatonic
        ) {
          this.rightBaseDiatonic = Math.max(0, targetDiatonic - 2);
          chosenFinger = RIGHT_FINGERS[targetDiatonic - this.rightBaseDiatonic];
          this.status.slideDescription = `右手弱指保護: 中指優先へ微調整 -> ${chosenFinger.name}`;
        } else {
          chosenFinger = defaultFinger;
          this.status.slideDescription = `右手ポジション内 -> ${chosenFinger.name}`;
        }
      } else if (targetDiatonic > rightMax) {
        // 高音スライド ↗ (動かしやすい中指 offset 2 で受け持つ)
        this.rightBaseDiatonic = targetDiatonic - 2;
        chosenFinger = RIGHT_FINGERS[2];
        this.status.slideDescription = `右手高音スライド ↗ [${diatonicToPitch(this.rightBaseDiatonic)}-${diatonicToPitch(this.rightBaseDiatonic + 4)}] -> ${chosenFinger.name}`;
      } else {
        // 低音スライド ↙ (下降余地を残して中指 offset 2 または 人差指 offset 1 で受け持つ)
        const idealOffset = Math.min(2, Math.max(0, targetDiatonic));
        this.rightBaseDiatonic = targetDiatonic - idealOffset;
        chosenFinger = RIGHT_FINGERS[idealOffset];
        this.status.slideDescription = `右手低音スライド ↙ [${diatonicToPitch(this.rightBaseDiatonic)}-${diatonicToPitch(this.rightBaseDiatonic + 4)}] -> ${chosenFinger.name}`;
      }
    } else {
      // ==========================================
      // 【左手】の動的指割り当て & ポジションスライド
      // 初心者・デスク演奏に最適化:
      // 机上で独立動作が困難な弱指（小指・薬指）への無理な割り当てを回避し、
      // 誰でも自然に打鍵できる親指(1)・人差指(2)・中指(3)を優先して配分
      // ==========================================
      const noteName = note.pitch.replace(/\d/, '');
      if (note.pitch === 'C4' || note.pitch === 'C3' || noteName === 'C') {
        // 主音・和音の「ド (C)」は最も打鍵しやすい【左手 親指】に割り当て
        chosenFinger = LEFT_FINGERS[4]; // 左手 親指 (tipIndex: 4, fingerNumber: 1)
        this.status.slideDescription = `左手伴奏 [C] -> ${chosenFinger.name}`;
      } else if (note.pitch === 'F4' || note.pitch === 'F3' || noteName === 'F') {
        // 下属音の「ファ (F)」は機敏な【左手 人差指】に割り当て
        chosenFinger = LEFT_FINGERS[3]; // 左手 人差指 (tipIndex: 8, fingerNumber: 2)
        this.status.slideDescription = `左手伴奏 [F] -> ${chosenFinger.name}`;
      } else if (note.pitch === 'G4' || note.pitch === 'G3' || noteName === 'G') {
        // 属音の「ソ (G)」は安定した【左手 中指】に割り当て
        chosenFinger = LEFT_FINGERS[2]; // 左手 中指 (tipIndex: 12, fingerNumber: 3)
        this.status.slideDescription = `左手伴奏 [G] -> ${chosenFinger.name}`;
      } else if (note.pitch === 'A4' || noteName === 'A') {
        // 副和音の「ラ (Am)」は【左手 人差指】に割り当て
        chosenFinger = LEFT_FINGERS[3]; // 左手 人差指 (tipIndex: 8, fingerNumber: 2)
        this.status.slideDescription = `左手伴奏 [Am] -> ${chosenFinger.name}`;
      } else if (note.pitch === 'E4' || noteName === 'E') {
        // 和音の「ミ (Em/C)」は【左手 中指】に割り当て
        chosenFinger = LEFT_FINGERS[2]; // 左手 中指 (tipIndex: 12, fingerNumber: 3)
        this.status.slideDescription = `左手伴奏 [Em] -> ${chosenFinger.name}`;
      } else if (note.pitch === 'D4' || noteName === 'D') {
        // 和音の「レ (Dm/G)」は【左手 人差指】に割り当て
        chosenFinger = LEFT_FINGERS[3]; // 左手 人差指 (tipIndex: 8, fingerNumber: 2)
        this.status.slideDescription = `左手伴奏 [Dm] -> ${chosenFinger.name}`;
      } else {
        // その他の左手低音域
        const leftMin = this.leftBaseDiatonic;
        const leftMax = this.leftBaseDiatonic + 4;

        if (targetDiatonic >= leftMin && targetDiatonic <= leftMax) {
          const offset = targetDiatonic - leftMin;
          const defaultFinger = LEFT_FINGERS[offset];
          // 小指・薬指への割り当てを避け、中指・親指へ安全にフォールバック
          if (defaultFinger.fingerNumber >= 4) {
            chosenFinger = LEFT_FINGERS[2]; // 中指
          } else {
            chosenFinger = defaultFinger;
          }
          this.status.slideDescription = `左手ポジション -> ${chosenFinger.name}`;
        } else {
          this.leftBaseDiatonic = targetDiatonic - 2;
          chosenFinger = LEFT_FINGERS[2]; // 中指
          this.status.slideDescription = `左手スライド -> ${chosenFinger.name}`;
        }
      }
    }

    // ステータス更新
    this.status.leftBasePitch = diatonicToPitch(this.leftBaseDiatonic);
    this.status.leftCoverRange = `${this.status.leftBasePitch} - ${diatonicToPitch(this.leftBaseDiatonic + 4)}`;
    this.status.rightBasePitch = diatonicToPitch(this.rightBaseDiatonic);
    this.status.rightCoverRange = `${this.status.rightBasePitch} - ${diatonicToPitch(this.rightBaseDiatonic + 4)}`;
    this.status.activeHand = targetHand;

    this.lastPitch = note.pitch;
    this.lastFinger = chosenFinger;

    return chosenFinger;
  }
}
