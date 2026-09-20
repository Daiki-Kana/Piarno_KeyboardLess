import { NOTE_FREQS, NoteInfo, SongData as SequencerSongData } from '../songSequencer';
import { RIGHT_FINGERS, LEFT_FINGERS, TargetFinger } from '../virtualPositionManager';

/**
 * 楽曲・運指データの型定義およびランドマーク変換ユーティリティ
 */

export type FingerNumber = 1 | 2 | 3 | 4 | 5;
export type HandType = 'Right' | 'Left';

/**
 * 楽曲シーケンス内の1音の定義
 */
export interface SongNote {
  finger: FingerNumber;
  hand?: HandType;
  note?: string; // 例: "C4", "D4", "E4", "G4"
}

/**
 * 楽曲データ全体のJSON構造定義
 */
export interface SongData {
  id: string;
  title: string;
  hand: HandType;
  sequence: SongNote[];
}

/**
 * ピアノ運指番号 (1: 親指 〜 5: 小指) から
 * MediaPipe Handランドマークインデックス (親指:4, 人差指:8, 中指:12, 薬指:16, 小指:20) への変換マップ
 */
export const FINGER_TO_TIP_INDEX: Record<FingerNumber, number> = {
  1: 4,  // 親指
  2: 8,  // 人差し指
  3: 12, // 中指
  4: 16, // 薬指
  5: 20, // 小指
};

/**
 * MediaPipe Handランドマークインデックスから
 * ピアノ運指番号 (1: 親指 〜 5: 小指) への逆変換マップ
 */
export const TIP_INDEX_TO_FINGER: Record<number, FingerNumber> = {
  4: 1,
  8: 2,
  12: 3,
  16: 4,
  20: 5,
};

/**
 * 指番号 (1〜5) を MediaPipe ランドマークインデックス (4, 8, 12, 16, 20) に変換
 */
export function fingerToTipIndex(finger: FingerNumber): number {
  return FINGER_TO_TIP_INDEX[finger] ?? 12;
}

/**
 * MediaPipe ランドマークインデックス (4, 8, 12, 16, 20) を指番号 (1〜5) に変換
 */
export function tipIndexToFinger(tipIndex: number): FingerNumber {
  return TIP_INDEX_TO_FINGER[tipIndex] ?? 3;
}

/**
 * SongNoteから対応するTargetFinger物理構造体を取得
 */
export function getTargetFingerFromNote(note: SongNote, defaultHand: HandType = 'Right'): TargetFinger {
  const hand = note.hand ?? defaultHand;
  const finger = note.finger;
  if (hand === 'Right') {
    // 右手: 1(親指)=0, 2(人差指)=1, 3(中指)=2, 4(薬指)=3, 5(小指)=4
    return RIGHT_FINGERS[finger - 1] ?? RIGHT_FINGERS[2];
  } else {
    // 左手: 1(親指)=4, 2(人差指)=3, 3(中指)=2, 4(薬指)=1, 5(小指)=0
    return LEFT_FINGERS[5 - finger] ?? LEFT_FINGERS[2];
  }
}

const PITCH_SOLFEGE_MAP: Record<string, string> = {
  C: 'ド', D: 'レ', E: 'ミ', F: 'ファ', G: 'ソ', A: 'ラ', B: 'シ',
};

/**
 * JSONノートをNoteInfoにパース
 */
export function parseSongNoteToInfo(note: SongNote, defaultHand: HandType = 'Right'): NoteInfo {
  const pitch = note.note ?? 'C4';
  const match = pitch.match(/^([A-G])(#|b)?(\d)$/);
  const noteName = match ? match[1] : 'C';
  const solfege = PITCH_SOLFEGE_MAP[noteName] ?? 'ド';
  const frequency = (NOTE_FREQS as Record<string, number>)[pitch] ?? 261.63;
  const hand = note.hand ?? defaultHand;

  return {
    pitch,
    solfege,
    frequency,
    hand,
    finger: note.finger,
  };
}

/**
 * JSON形式のSongDataをSongSequencerが扱える内部SongDataに変換
 */
export function loadSongFromJson(songJson: SongData): SequencerSongData {
  const notes: NoteInfo[] = songJson.sequence.map((n) => parseSongNoteToInfo(n, songJson.hand));
  return {
    id: songJson.id,
    title: songJson.title,
    notes,
  };
}
